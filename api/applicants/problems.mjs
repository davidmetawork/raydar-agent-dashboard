// Read-only Applicant Problems projection. Problems ride the same immutable
// generation as Applicants; this endpoint never creates alerts or work items.

import { cors, requireAuth } from "./_lib/core.mjs";
import { readActivePublication, readPublishedArtifacts, verifyGeneration } from "./_lib/generation.mjs";
import { getJson, kvConfigured } from "./_lib/kv.mjs";
import { applicantProblemsV2, applicantRowsV2FromSnapshot } from "./_lib/profile-v2.mjs";

export function createProblemsHandler({
  corsHandler = cors, authHandler = requireAuth, kvReady = kvConfigured, readJson = getJson,
  readActive = () => readActivePublication({ readJson }),
  readArtifacts = (pointer) => readPublishedArtifacts(pointer, { readJson }),
} = {}) {
  return async function handler(req, res) {
    if (corsHandler(req, res)) return;
    if (req.method !== "GET") return res.status(405).json({ ok: false, error: "GET only" });
    if (!(await authHandler(req, res))) return;
    if (!kvReady()) return res.status(503).json({ ok: false, error: "state_store_not_configured" });
    try {
      const generation = await readActive();
      const artifacts = generation ? await readArtifacts(generation) : null;
      if (!generation || !artifacts || !verifyGeneration(artifacts).ok) {
        return res.status(503).json({ ok: false, error: "generation_unavailable" });
      }
      const rows = applicantRowsV2FromSnapshot(artifacts.snapshot);
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ ok: true, problems: applicantProblemsV2(rows, artifacts.snapshot?.problems),
        generation: { generationId: generation.generationId, digest: generation.digest } });
    } catch (error) {
      return res.status(502).json({ ok: false, error: "problems_unavailable", detail: String(error?.message || error).slice(0, 180) });
    }
  };
}

export default createProblemsHandler();
