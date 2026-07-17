import {
  AGENCY_ID,
  RECRUITER_ID,
  candidateAlreadySubmitted,
  trpcGet,
} from "../../paraai/_lib/core.mjs";

export const STATUS_CACHE_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_CRM_PAGE_SIZE = 1000;
export const DEFAULT_MAX_CRM_PAGES = 25;

const CONFIRMED_JOB_STATES = new Set([
  "awaiting_matches",
  "ready_to_enroll",
  "needs_review",
  "ensuring_email",
  "enrolling",
  "verifying",
  "enrolled",
  "no_email",
]);

const text = (value) => String(value || "").trim().replace(/\s+/g, " ");

export function normalizeCandidateName(value) {
  return text(value).normalize("NFKC").toLocaleLowerCase("en-US");
}

export function localConfirmedMembership(job) {
  const candidateUserId = text(job?.identity?.candidateUserId);
  const name = text(job?.submission?.name || job?.candidate?.fullName);
  if (!candidateUserId || !name) return null;

  const readbackVerified = job?.submitReadbackVerified === true;
  const vendorAlreadySubmitted = job?.error?.code === "ALREADY_SUBMITTED";
  const reconciledState = CONFIRMED_JOB_STATES.has(String(job?.state || ""));
  if (!readbackVerified && !vendorAlreadySubmitted && !reconciledState) {
    return null;
  }
  return {
    candidateUserId,
    name,
    normalizedName: normalizeCandidateName(name),
  };
}

export function confirmedLocalMemberships(jobs = []) {
  const byId = new Map();
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const confirmed = localConfirmedMembership(job);
    if (!confirmed) continue;
    // listJobs is newest-first. Preserve the newest confirmed identity if a
    // candidate has more than one historical job.
    if (!byId.has(confirmed.candidateUserId)) {
      byId.set(confirmed.candidateUserId, confirmed);
    }
  }
  return [...byId.values()];
}

function vendorCandidate(row, membershipPredicate) {
  const candidateUserId = text(row?.id || row?.candidateUserId || row?.candidate_user_id);
  const name = text(row?.name || row?.fullName || row?.full_name);
  const normalizedName = normalizeCandidateName(name);
  if (!candidateUserId || !normalizedName) return null;
  return {
    candidateUserId,
    name,
    normalizedName,
    added: membershipPredicate(row) === true,
    localConfirmed: false,
  };
}

export function buildParaAIStatusIndex(
  rows = [],
  {
    confirmedMemberships = [],
    membershipPredicate = candidateAlreadySubmitted,
  } = {},
) {
  const byId = new Map();
  let skipped = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const candidate = vendorCandidate(row, membershipPredicate);
    if (!candidate) {
      skipped++;
      continue;
    }
    const existing = byId.get(candidate.candidateUserId);
    if (!existing) {
      byId.set(candidate.candidateUserId, candidate);
      continue;
    }
    // Cursor pagination can overlap while updated_at is changing. The same ID
    // is one candidate, not a homonym; preserve the newest name and OR only
    // authoritative membership evidence across duplicate rows.
    existing.added ||= candidate.added;
  }

  for (const local of Array.isArray(confirmedMemberships) ? confirmedMemberships : []) {
    const candidateUserId = text(local?.candidateUserId);
    const name = text(local?.name);
    const normalizedName = normalizeCandidateName(local?.normalizedName || name);
    if (!candidateUserId || !normalizedName) continue;
    const existing = byId.get(candidateUserId);
    if (existing) {
      // A local job may only augment the exact CRM identity it was prepared
      // against. A name mismatch is identity drift and must not turn green.
      if (existing.normalizedName !== normalizedName) continue;
      existing.added = true;
      existing.localConfirmed = true;
    } else {
      // The five-minute CRM snapshot may predate a newly accepted submission.
      // A confirmed local job carries the exact candidate ID and name, so it is
      // safe to add until the next authoritative CRM refresh catches up.
      byId.set(candidateUserId, {
        candidateUserId,
        name,
        normalizedName,
        added: true,
        localConfirmed: true,
      });
    }
  }

  const byName = new Map();
  for (const candidate of byId.values()) {
    const group = byName.get(candidate.normalizedName) || [];
    group.push(candidate);
    byName.set(candidate.normalizedName, group);
  }

  const statuses = [...byName.entries()]
    .map(([normalizedName, candidates]) => {
      candidates.sort((left, right) => left.candidateUserId.localeCompare(right.candidateUserId));
      const ambiguous = candidates.length > 1;
      const candidate = candidates[0];
      const added = !ambiguous && candidate.added === true;
      return {
        name: candidate.name,
        normalizedName,
        candidateUserId: ambiguous ? null : candidate.candidateUserId,
        candidateUserIds: ambiguous ? candidates.map((item) => item.candidateUserId) : undefined,
        status: added ? "added" : "not_added",
        label: ambiguous ? "Ambiguous" : added ? "Added" : "Not added",
        added,
        ambiguous,
        source: added && candidate.localConfirmed ? "local_confirmed" : "paraform_crm",
      };
    })
    .sort((left, right) => left.normalizedName.localeCompare(right.normalizedName));

  return {
    statuses,
    scanned: Array.isArray(rows) ? rows.length : 0,
    indexedCandidateCount: byId.size,
    uniqueNames: statuses.length,
    addedCount: statuses.filter((status) => status.status === "added").length,
    ambiguousCount: statuses.filter((status) => status.ambiguous).length,
    skipped,
  };
}

export async function defaultCrmPage({
  cursor = 0,
  limit = DEFAULT_CRM_PAGE_SIZE,
  recruiterId = RECRUITER_ID,
} = {}) {
  // trpcGet uses the Para AI adapter, whose cookie is resolved at request time
  // (env or n8n fallback), cached, and cleared on a 401. Do not use the
  // Sequences adapter's module-time COOKIE constant for this long-lived index.
  const result = await trpcGet("candidateUser.getCRMExternalCandidates", {
    cursor,
    limit,
    filters: {
      recruiters: [String(recruiterId || RECRUITER_ID)],
      agency_id: AGENCY_ID,
      sort: { field: "updated_at", direction: "desc" },
    },
  });
  return {
    items: Array.isArray(result?.items) ? result.items : result?.items,
    nextCursor: result?.next_cursor ?? null,
  };
}

export async function scanCrmDeep({
  fetchPage = defaultCrmPage,
  pageSize = DEFAULT_CRM_PAGE_SIZE,
  maxPages = DEFAULT_MAX_CRM_PAGES,
} = {}) {
  const boundedPageSize = Math.max(1, Math.min(1000, Number(pageSize) || DEFAULT_CRM_PAGE_SIZE));
  const boundedMaxPages = Math.max(1, Math.min(100, Number(maxPages) || DEFAULT_MAX_CRM_PAGES));
  const rows = [];
  const seenCursors = new Set();
  let cursor = 0;

  for (let page = 0; page < boundedMaxPages; page++) {
    const cursorKey = String(cursor);
    if (seenCursors.has(cursorKey)) {
      const error = new Error("Paraform CRM cursor repeated");
      error.code = "CRM_CURSOR_LOOP";
      throw error;
    }
    seenCursors.add(cursorKey);
    const response = await fetchPage({ cursor, limit: boundedPageSize, recruiterId: RECRUITER_ID });
    const items = response?.items;
    if (!Array.isArray(items)) {
      const error = new Error("Paraform CRM page did not contain an items array");
      error.code = "CRM_SHAPE_INVALID";
      throw error;
    }
    rows.push(...items);
    const nextCursor = response?.nextCursor ?? response?.next_cursor ?? null;
    if (!items.length || nextCursor == null) {
      return {
        rows,
        complete: true,
        pages: page + 1,
        nextCursor: null,
      };
    }
    cursor = nextCursor;
  }
  return {
    rows,
    complete: false,
    pages: boundedMaxPages,
    nextCursor: cursor,
  };
}

export function createCrmSnapshotLoader({
  scan = scanCrmDeep,
  now = Date.now,
  ttlMs = STATUS_CACHE_TTL_MS,
} = {}) {
  let cache = { at: 0, snapshot: null, pending: null };

  return async function loadCrmSnapshot({ refresh = false } = {}) {
    const current = Number(now());
    if (!refresh && cache.snapshot && current - cache.at < ttlMs) {
      return { ...cache.snapshot, cached: true };
    }
    if (cache.pending) {
      const snapshot = await cache.pending;
      return { ...snapshot, cached: false };
    }
    cache.pending = Promise.resolve()
      .then(() => scan())
      .then((snapshot) => {
        if (snapshot?.complete !== true) {
          const error = new Error("Paraform CRM scan hit its safety page limit");
          error.code = "CRM_SCAN_INCOMPLETE";
          error.snapshot = snapshot;
          throw error;
        }
        const completedAt = Number(now());
        const value = {
          ...snapshot,
          generatedAt: new Date(completedAt).toISOString(),
        };
        cache = { at: completedAt, snapshot: value, pending: null };
        return value;
      })
      .catch((error) => {
        cache.pending = null;
        throw error;
      });
    const snapshot = await cache.pending;
    return { ...snapshot, cached: false };
  };
}
