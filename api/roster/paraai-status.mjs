// GET /api/roster/paraai-status
//
// Authenticated, read-only reconstruction of Para AI Talent Network membership.
// The expensive Paraform CRM walk is cached for five minutes. `?refresh=1`
// forces a new authoritative walk, while confirmed local submission jobs are
// overlaid on every request so a newly accepted candidate appears immediately.

import { cors, requireAuth } from "../paraai/_lib/core.mjs";
import { listJobs } from "../paraai/_lib/store.mjs";
import {
  buildParaAIStatusIndex,
  confirmedLocalMemberships,
  createCrmSnapshotLoader,
  scanCrmDeep,
} from "./_lib/paraai-status.mjs";

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

export function createParaAIStatusHandler({
  corsImpl = cors,
  requireAuthImpl = requireAuth,
  loadSnapshot = defaultSnapshotLoader,
  loadJobs = () => listJobs(500),
  now = Date.now,
} = {}) {
  return async function paraAIStatusHandler(req, res) {
    if (corsImpl(req, res)) return;
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ ok: false, error: "GET only" });
    }
    if (!(await requireAuthImpl(req, res))) return;
    res.setHeader("Cache-Control", "private, no-store");

    const refresh = String(queryOf(req).refresh || "") === "1";
    try {
      const [snapshot, jobsResult] = await Promise.all([
        loadSnapshot({ refresh }),
        Promise.resolve()
          .then(() => loadJobs())
          .then((jobs) => ({ jobs, available: true }))
          .catch(() => ({ jobs: [], available: false })),
      ]);
      const index = buildParaAIStatusIndex(snapshot.rows, {
        confirmedMemberships: confirmedLocalMemberships(jobsResult.jobs),
      });
      const generatedAt = new Date(Number(now())).toISOString();
      const statuses = index.statuses;
      return res.status(200).json({
        ok: true,
        generatedAt,
        snapshotGeneratedAt: snapshot.generatedAt,
        cached: snapshot.cached === true,
        refreshed: refresh,
        complete: snapshot.complete === true,
        scanned: index.scanned,
        indexedCandidateCount: index.indexedCandidateCount,
        uniqueNames: index.uniqueNames,
        addedCount: index.addedCount,
        ambiguousCount: index.ambiguousCount,
        localJobsAvailable: jobsResult.available,
        statuses,
      });
    } catch (error) {
      const code = String(error?.code || "");
      const authExpired = code === "AUTH_EXPIRED" || /AUTH_EXPIRED|401/.test(String(error?.message || error));
      const incomplete = code === "CRM_SCAN_INCOMPLETE";
      return res.status(authExpired || incomplete ? 503 : 502).json({
        ok: false,
        error: authExpired
          ? "AUTH_EXPIRED"
          : incomplete
            ? "crm_scan_incomplete"
            : "paraai_status_failed",
        complete: false,
        scanned: Number(error?.snapshot?.rows?.length || 0),
        detail: String(error?.message || error).slice(0, 200),
      });
    }
  };
}

export default createParaAIStatusHandler();
