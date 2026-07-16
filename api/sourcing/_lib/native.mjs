import { createHash, randomUUID } from "node:crypto";
import {
  nativeSaveCandidate,
  nativeSearchCreateSession,
  nativeSearchPaginate,
  nativeSearchSubmit,
} from "./core.mjs";
import { dedupeResults } from "../../../sourcing-domain.mjs";
import { bookedSet, enrolledElsewhereSet, projectMembers } from "../../seq/_lib/core.mjs";

const text = (value) => String(value ?? "").trim();
const rows = (value) => Array.isArray(value) ? value : [];
const first = (...values) => values.map(text).find(Boolean) || "";
const identity = (value) => createHash("sha256").update(String(value)).digest("hex").slice(0, 24);
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const DEFAULT_ADAPTERS = Object.freeze({
  createSession: nativeSearchCreateSession,
  submitSearch: nativeSearchSubmit,
  paginateSearch: nativeSearchPaginate,
  saveCandidate: nativeSaveCandidate,
  projectMembers,
  bookedSet,
  enrolledElsewhereSet: () => enrolledElsewhereSet({ strict: true }),
  wait,
});

export function normalizeNativeHit(hit = {}, lane = {}) {
  const current = hit.currentPosition || hit.current_position || hit.currentRole || hit.current_role || {};
  const linkedinSlug = first(hit.linkedinSlug, hit.linkedin_slug, hit.linkedin_url, hit.linkedin);
  const sourceId = first(hit.candidateDbId, hit.candidate_db_id, hit.candidateId, hit.candidate_id, hit.id, linkedinSlug);
  if (!sourceId) return null;
  return {
    id: `cand-${identity(sourceId)}`,
    candidateId: sourceId,
    candidateUserId: first(hit.savedRecordId, hit.saved_record_id, hit.candidate_user_id) || null,
    linkedinSlug: linkedinSlug || null,
    name: first(hit.name, hit.full_name) || "Unknown candidate",
    title: first(hit.title, hit.oneLiner, hit.one_liner, current.title, current.role_title),
    company: first(hit.company, hit.companyName, hit.company_name, current.company, current.company_name, current.name),
    location: first(hit.location, hit.location_name, hit.city),
    laneId: lane.id,
    laneName: lane.name,
    state: "discovered",
    projectStatus: "pending",
    feedback: null,
  };
}

export function buildLaneQuery(rubric, lane, adjustments = []) {
  const role = rubric?.role || {};
  const must = rows(rubric?.mustHaves);
  const pref = rows(rubric?.preferences);
  const positive = rubric?.searchSignals || {};
  const negative = rubric?.exclusions || {};
  const parts = [
    `Find strong candidates for ${first(role.title, "this role")}${role.company ? ` at ${role.company}` : ""}.`,
    lane?.rationale ? `Search angle: ${lane.rationale}` : "",
    must.length ? `Must have: ${must.join("; ")}.` : "",
    rows(negative.titles).length ? `Exclude titles: ${negative.titles.join(", ")}.` : "",
    rows(negative.criteria).length ? `Reject profiles matching these dealbreakers or traits to avoid: ${negative.criteria.join("; ")}.` : "",
    adjustments.length ? `Reviewer-approved calibration: ${adjustments.map((item) => item.action || item).join(" ")}` : "",
    rows(positive.titles).length ? `Target titles: ${positive.titles.join(", ")}.` : "",
    rows(positive.skills).length ? `Skills: ${positive.skills.join(", ")}.` : "",
    rows(positive.companies).length ? `Ideal company backgrounds: ${positive.companies.join(", ")}.` : "",
    rows(positive.locations).length ? `Locations: ${positive.locations.join(", ")}.` : "",
    positive.experience ? `Experience: ${positive.experience}.` : "",
    rows(negative.skills).length ? `Exclude profiles missing or centered on: ${negative.skills.join(", ")}.` : "",
    rows(negative.companies).length ? `Avoid companies: ${negative.companies.join(", ")}.` : "",
    pref.length ? `Prefer: ${pref.join("; ")}.` : "",
  ];
  // Paraform's current submitNlSearch schema rejects queries over 1,000
  // characters. Preserve role, must-have, exclusion, and approved-calibration
  // segments first; later positive/preference segments fill the remaining room.
  let query = "";
  for (const part of parts.filter(Boolean)) {
    const room = 1000 - query.length - (query ? 1 : 0);
    if (room <= 0) break;
    query += `${query ? " " : ""}${part.slice(0, room)}`;
  }
  return query;
}

async function pool(items, concurrency, fn) {
  const output = new Array(items.length);
  let index = 0;
  const worker = async () => {
    while (index < items.length) {
      const current = index++;
      output[current] = await fn(items[current], current);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, worker));
  return output;
}

async function searchLane(lane, rubric, adjustments, cap, adapters) {
  const created = await adapters.createSession();
  const sessionId = text(created?.id || created?.session?.id);
  if (!sessionId) throw new Error("Paraform Search did not return a session id");
  const query = buildLaneQuery(rubric, lane, adjustments);
  const firstPage = await adapters.submitSearch(sessionId, query);
  const results = firstPage?.results || {};
  const collected = [...rows(results.hits)];
  const total = Number(results.total || collected.length);
  const pageSize = Math.min(50, Math.max(1, Number(firstPage?.session?.currentPageSize || collected.length || 50)));
  let page = Number(firstPage?.session?.currentPage || 1);
  while (collected.length < Math.min(total, cap)) {
    page += 1;
    const response = await adapters.paginateSearch(sessionId, page, pageSize);
    const hits = rows(response?.results?.hits);
    if (!hits.length) break;
    collected.push(...hits);
  }
  return {
    id: lane.id,
    name: lane.name,
    rationale: lane.rationale,
    sessionId,
    searchId: text(results.searchId || firstPage?.session?.latestSearchId) || null,
    query,
    reportedTotal: total,
    hits: collected.slice(0, cap),
  };
}

async function verifyProjectMembership(adapters, projectId, candidateUserIds) {
  const expected = new Set(candidateUserIds.map(text).filter(Boolean));
  const delays = [250, 750, 1500, 2500];
  let members = new Set();
  let lastError = null;
  for (let attempt = 0; attempt <= delays.length && expected.size; attempt++) {
    try {
      members = new Set(rows(await adapters.projectMembers(projectId)).map((item) => text(item?.id)).filter(Boolean));
      lastError = null;
      if ([...expected].every((id) => members.has(id))) break;
    } catch (error) {
      lastError = error;
    }
    if (attempt < delays.length) await adapters.wait(delays[attempt]);
  }
  return { members, error: lastError };
}

export async function executeNativeSearch({
  rubric,
  lanes,
  adjustments = [],
  candidateCap,
  reviewProject,
  seenCandidateIds = [],
  enrolledCandidateUserIds = null,
  bookedCandidateUserIds = null,
  fileToProject = false,
  adapters: adapterOverrides = {},
}) {
  const cap = Number(candidateCap);
  if (!Number.isInteger(cap) || cap < 1 || cap > 100) throw new Error("candidateCap must be 1-100");
  const searchLanes = rows(lanes).slice(0, Math.max(1, cap));
  if (!searchLanes.length) throw new Error("at least one Search lane is required");
  const adapters = { ...DEFAULT_ADAPTERS, ...adapterOverrides };
  const base = Math.floor(cap / searchLanes.length);
  let remainder = cap % searchLanes.length;
  const searched = [];
  // Sequential lanes keep Paraform load predictable and make partial failures auditable.
  for (const lane of searchLanes) {
    const laneCap = Math.max(1, base + (remainder-- > 0 ? 1 : 0));
    searched.push(await searchLane(lane, rubric, adjustments, laneCap, adapters));
  }
  const normalized = searched.flatMap((lane) => lane.hits.map((hit) => normalizeNativeHit(hit, lane)).filter(Boolean));
  const existingIds = normalized.map((candidate) => candidate.candidateUserId).filter(Boolean);
  const enrolled = new Set(enrolledCandidateUserIds === null
    ? await adapters.enrolledElsewhereSet()
    : enrolledCandidateUserIds);
  const booked = new Set(bookedCandidateUserIds === null
    ? await adapters.bookedSet(existingIds)
    : bookedCandidateUserIds);
  const deduped = dedupeResults(normalized, {
    seenCandidateIds,
    enrolledCandidateUserIds: [...enrolled],
    bookedCandidateUserIds: [...booked],
  });
  const accepted = deduped.accepted.slice(0, cap);
  const blocked = deduped.blocked;
  let filed = accepted;
  if (fileToProject) {
    filed = await pool(accepted, 3, async (candidate) => {
      if (!candidate.linkedinSlug) return { ...candidate, state: "dedup_blocked", dedupReason: "missing_linkedin_identity", projectStatus: "failed" };
      try {
        const saved = await adapters.saveCandidate(candidate.linkedinSlug, reviewProject.id, reviewProject.name);
        const candidateUserId = text(saved?.savedRecordId) || candidate.candidateUserId;
        if (!candidateUserId) {
          return { ...candidate, state: "discovered", projectStatus: "failed", projectError: "Paraform save returned no candidate identity" };
        }
        return {
          ...candidate,
          candidateUserId,
          candidateDbId: text(saved?.candidateDbId) || null,
          state: "discovered",
          projectStatus: "verification_pending",
        };
      } catch (error) {
        return { ...candidate, state: "discovered", projectStatus: "failed", projectError: text(error?.message).slice(0, 160) };
      }
    });
    const pendingIds = filed
      .filter((candidate) => candidate.projectStatus === "verification_pending")
      .map((candidate) => candidate.candidateUserId);
    const readback = await verifyProjectMembership(adapters, reviewProject.id, pendingIds);
    filed = filed.map((candidate) => {
      if (candidate.projectStatus !== "verification_pending") return candidate;
      if (readback.members.has(candidate.candidateUserId)) {
        return { ...candidate, state: "in_review", projectStatus: "filed", projectVerifiedAt: new Date().toISOString() };
      }
      return {
        ...candidate,
        state: "discovered",
        projectStatus: "readback_failed",
        projectError: text(readback.error?.message || "candidate not found in Project readback").slice(0, 160),
      };
    });

    // saveCandidate resolves the stable candidate-user id for previously unseen
    // profiles. Re-run the safety checks with those resolved ids before review.
    const filedIds = filed.filter((candidate) => candidate.projectStatus === "filed").map((candidate) => candidate.candidateUserId);
    const bookedAfterSave = new Set(bookedCandidateUserIds === null
      ? await adapters.bookedSet(filedIds)
      : bookedCandidateUserIds);
    filed = filed.map((candidate) => {
      if (candidate.projectStatus !== "filed") return candidate;
      const reason = bookedAfterSave.has(candidate.candidateUserId)
        ? "booked_or_later"
        : enrolled.has(candidate.candidateUserId)
          ? "already_in_sequence"
          : null;
      return reason
        ? { ...candidate, state: "dedup_blocked", dedupReason: reason, dedupStage: "post_project_readback" }
        : candidate;
    });
  } else {
    filed = accepted.map((candidate) => ({ ...candidate, state: "in_review", projectStatus: "not_authorized" }));
  }
  const candidates = [...filed, ...blocked];
  return {
    lanes: searched.map(({ hits, ...lane }) => ({ ...lane, resultCount: hits.length })),
    candidates,
    discoveredCount: normalized.length,
    reviewCount: candidates.filter((candidate) => candidate.state === "in_review").length,
    dedupedCount: candidates.filter((candidate) => candidate.state === "dedup_blocked").length,
    projectFiledCount: filed.filter((candidate) => candidate.projectStatus === "filed").length,
  };
}

export function newRunId() {
  return `run-${randomUUID()}`;
}
