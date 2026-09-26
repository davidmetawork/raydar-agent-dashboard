// GET /api/roster/paraai-status
//
// Authenticated reconstruction of Para AI Talent Network membership plus
// reviewed outcome completion, for the Candidates tab.
//
// READ MODEL (2026-09-26 Paraform read-cut pass): an ordinary request (no
// `refresh` param) never touches Paraform. It serves the last computed
// snapshot from the shared roster:v1:paraai-status KV store
// (api/roster/_lib/status-kv-cache.mjs) and labels its age. Only
// `?refresh=1` — the Candidates tab's explicit "Refresh now" action — may
// run the expensive CRM walk and five-sequence read, and even that is paced
// by a shared lock (REFRESH_MIN_INTERVAL_MS) so a double-click or two open
// tabs cannot fan out into two scans.
//
// Before this, the CRM/sequence reads were cached only in per-process
// memory (createCrmSnapshotLoader / createOutcomeSequenceSnapshotLoader,
// still used below to do the actual scan when one is due), which a
// front-end poll every 60 seconds could bypass on every serverless cold
// start — "up to ~36k reads a day per always-open Candidates tab" per
// docs/research/paraform-quota-plan-2026-09-25.md.

import { cors, requireAuth } from "../paraai/_lib/core.mjs";
import { listJobs } from "../paraai/_lib/store.mjs";
import {
  buildParaAIStatusIndex,
  confirmedLocalMemberships,
  createCrmSnapshotLoader,
  scanCrmDeep,
} from "./_lib/paraai-status.mjs";
import {
  applyOutcomeMemberships,
  buildOutcomeMembershipIndex,
  createOutcomeSequenceSnapshotLoader,
  readOutcomeSequenceSnapshot,
} from "./_lib/outcome-sequences.mjs";
import {
  claimRefreshWindow,
  readStatusSnapshot,
  snapshotAgeMs,
  writeStatusSnapshot,
} from "./_lib/status-kv-cache.mjs";

export const config = { maxDuration: 120 };

const queryOf = (req) => {
  if (req?.query && typeof req.query === "object") return req.query;
  try {
    return Object.fromEntries(new URL(req?.url || "", "http://localhost").searchParams.entries());
  } catch {
    return {};
  }
};

const defaultSnapshotLoader = createCrmSnapshotLoader({
  scan: () => scanCrmDeep({
    pageSize: Number(process.env.PARAAI_ROSTER_CRM_PAGE_SIZE || 1000),
    maxPages: Number(process.env.PARAAI_ROSTER_MAX_CRM_PAGES || 25),
  }),
});
const defaultOutcomeSnapshotLoader = createOutcomeSequenceSnapshotLoader({
  scan: () => readOutcomeSequenceSnapshot(),
});

function outcomeVerificationPayload(outcomeSnapshot, outcomeIndex, error = "") {
  return {
    complete: Boolean(outcomeSnapshot),
    generatedAt: outcomeSnapshot?.generatedAt || null,
    cached: outcomeSnapshot?.cached === true,
    stale: outcomeSnapshot?.stale === true,
    sequenceCount: outcomeSnapshot?.ruleCount || 0,
    candidateCount: outcomeIndex?.candidateCount || 0,
    leadCount: outcomeIndex?.leadCount || 0,
    ...(outcomeSnapshot ? {} : { error: String(error || "unavailable").slice(0, 120) }),
  };
}

function compactOutcomes(outcomeIndex) {
  return [...(outcomeIndex?.memberships?.values() || [])].map((membership) => ({
    candidateUserId: membership.candidateUserId,
    outcomeComplete: membership.outcomeComplete === true,
    verifiedOutcome: membership.verifiedOutcome || null,
    outcomeConflict: membership.outcomeConflict === true,
    outcomeSequenceIds: membership.sequenceIds,
  }));
}

export function createParaAIStatusHandler({
  corsImpl = cors,
  requireAuthImpl = requireAuth,
  loadSnapshot = defaultSnapshotLoader,
  loadOutcomeSnapshot = defaultOutcomeSnapshotLoader,
  loadJobs = () => listJobs(500),
  now = Date.now,
  readCache = readStatusSnapshot,
  writeCache = writeStatusSnapshot,
  claimWindow = claimRefreshWindow,
  ageOf = snapshotAgeMs,
} = {}) {
  // The live scan for `outcomes=1` (the tab's periodic outcome recheck).
  async function computeOutcomesOnly() {
    try {
      const outcomeSnapshot = await loadOutcomeSnapshot({ refresh: true });
      const outcomeIndex = buildOutcomeMembershipIndex(outcomeSnapshot.entries);
      return {
        ok: true,
        outcomeVerification: outcomeVerificationPayload(outcomeSnapshot, outcomeIndex),
        outcomes: compactOutcomes(outcomeIndex),
      };
    } catch (error) {
      console.warn("[roster] outcome-only verification unavailable", {
        code: String(error?.code || "unknown"),
        sequenceId: String(error?.sequenceId || ""),
        detail: String(error?.message || error).slice(0, 160),
      });
      return {
        ok: true,
        outcomeVerification: outcomeVerificationPayload(null, null, error?.code || error?.message || error),
        outcomes: [],
      };
    }
  }

  // The live scan for the full status list (the tab's first-open / refresh read).
  async function computeFull() {
    const [snapshot, jobsResult, outcomeResult] = await Promise.all([
      loadSnapshot({ refresh: true }),
      Promise.resolve()
        .then(() => loadJobs())
        .then((jobs) => ({ jobs, available: true }))
        .catch(() => ({ jobs: [], available: false })),
      Promise.resolve()
        .then(() => loadOutcomeSnapshot({ refresh: true }))
        .then((outcomeSnapshot) => ({ snapshot: outcomeSnapshot, available: true }))
        .catch((error) => {
          console.warn("[roster] outcome verification unavailable", {
            code: String(error?.code || "unknown"),
            sequenceId: String(error?.sequenceId || ""),
            detail: String(error?.message || error).slice(0, 160),
          });
          return {
            snapshot: null,
            available: false,
            error: String(error?.code || error?.message || error).slice(0, 120),
          };
        }),
    ]);
    const index = buildParaAIStatusIndex(snapshot.rows, {
      confirmedMemberships: confirmedLocalMemberships(jobsResult.jobs),
    });
    const outcomeIndex = outcomeResult.available
      ? buildOutcomeMembershipIndex(outcomeResult.snapshot.entries)
      : null;
    const generatedAt = new Date(Number(now())).toISOString();
    const statuses = outcomeIndex
      ? applyOutcomeMemberships(index.statuses, outcomeIndex.memberships)
      : index.statuses.map((status) => ({
          ...status,
          outcomeComplete: false,
          verifiedOutcome: null,
          outcomeConflict: false,
          outcomeSequenceIds: [],
        }));
    return {
      ok: true,
      generatedAt,
      snapshotGeneratedAt: snapshot.generatedAt,
      complete: snapshot.complete === true,
      scanned: index.scanned,
      indexedCandidateCount: index.indexedCandidateCount,
      uniqueNames: index.uniqueNames,
      addedCount: statuses.filter((status) => status.status === "added").length,
      ambiguousCount: index.ambiguousCount,
      localJobsAvailable: jobsResult.available,
      outcomeVerification: {
        ...outcomeVerificationPayload(
          outcomeResult.available ? outcomeResult.snapshot : null,
          outcomeIndex,
          outcomeResult.error,
        ),
      },
      statuses,
    };
  }

  function errorBody(error) {
    const code = String(error?.code || "");
    const authExpired = code === "AUTH_EXPIRED" || /AUTH_EXPIRED|401/.test(String(error?.message || error));
    const incomplete = code === "CRM_SCAN_INCOMPLETE";
    return {
      status: authExpired || incomplete ? 503 : 502,
      body: {
        ok: false,
        error: authExpired
          ? "AUTH_EXPIRED"
          : incomplete
            ? "crm_scan_incomplete"
            : "paraai_status_failed",
        complete: false,
        scanned: Number(error?.snapshot?.rows?.length || 0),
        detail: String(error?.message || error).slice(0, 200),
      },
    };
  }

  // A placeholder shaped like a real (but empty/incomplete) answer for each
  // mode, so a "no snapshot yet" response never forces the caller through
  // an error path it built for genuine Paraform failures.
  function emptyBody(mode) {
    return mode === "outcomes"
      ? { ok: true, outcomeVerification: outcomeVerificationPayload(null, null, "warming"), outcomes: [] }
      : { ok: true, statuses: [], outcomeVerification: outcomeVerificationPayload(null, null, "warming") };
  }

  // Serves `mode` from the durable KV snapshot, only ever running `compute`
  // (a live Paraform scan) when there is nothing to serve yet (a one-time,
  // lock-guarded bootstrap) or when the caller explicitly asked for a
  // refresh — and even then, only when the shared pacing lock is free.
  async function serveMode({ mode, refresh, compute }) {
    if (!refresh) {
      const cached = await readCache(mode);
      if (cached) {
        return { status: 200, body: { ...cached, refreshed: false, source: "snapshot", snapshotAgeMs: ageOf(cached, Number(now())) } };
      }
      // No snapshot has ever been written for this mode. One caller must do
      // the bootstrap scan; everyone else arriving in the same window gets
      // a "warming up" placeholder rather than piling onto Paraform too.
      const won = await claimWindow(mode);
      if (!won) {
        return { status: 200, body: { ...emptyBody(mode), warming: true, source: "warming" } };
      }
      try {
        const payload = await compute();
        const record = await writeCache(mode, payload);
        return { status: 200, body: { ...record, refreshed: false, source: "live", snapshotAgeMs: 0 } };
      } catch (error) {
        return errorBody(error);
      }
    }
    // Explicit operator "Refresh now" — still paced, so a double-click or a
    // second open tab reuses the last scan instead of starting another.
    const won = await claimWindow(mode);
    if (!won) {
      const cached = await readCache(mode);
      return {
        status: 200,
        body: {
          ...(cached || emptyBody(mode)),
          refreshed: false,
          refreshSkipped: "too_soon",
          source: cached ? "snapshot" : "warming",
          snapshotAgeMs: cached ? ageOf(cached, Number(now())) : null,
        },
      };
    }
    try {
      const payload = await compute();
      const record = await writeCache(mode, payload);
      return { status: 200, body: { ...record, refreshed: true, source: "live", snapshotAgeMs: 0 } };
    } catch (error) {
      // A failed refresh must not blank a tab that had a good answer.
      const cached = await readCache(mode);
      if (cached) {
        return {
          status: 200,
          body: { ...cached, refreshed: false, refreshError: String(error?.code || error?.message || error).slice(0, 160), source: "snapshot", snapshotAgeMs: ageOf(cached, Number(now())) },
        };
      }
      return errorBody(error);
    }
  }

  return async function paraAIStatusHandler(req, res) {
    if (corsImpl(req, res)) return;
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ ok: false, error: "GET only" });
    }
    if (!(await requireAuthImpl(req, res))) return;
    res.setHeader("Cache-Control", "private, no-store");

    const refresh = String(queryOf(req).refresh || "") === "1";
    const outcomesOnly = String(queryOf(req).outcomes || "") === "1";
    const { status, body } = outcomesOnly
      ? await serveMode({ mode: "outcomes", refresh, compute: computeOutcomesOnly })
      : await serveMode({ mode: "full", refresh, compute: computeFull });
    return res.status(status).json(body);
  };
}

export default createParaAIStatusHandler();
