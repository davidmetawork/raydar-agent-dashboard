import { randomUUID } from "node:crypto";
import { cors, requireSourcingAuth } from "./_lib/core.mjs";
import { getRun, saveRun, storeConfigured } from "./_lib/store.mjs";
import { applyFeedback, proposeNextRun } from "../../sourcing-domain.mjs";

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });
  if (!storeConfigured()) return res.status(503).json({ ok: false, error: "state_store_not_configured" });
  if (!(await requireSourcingAuth(req, res))) return;
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const run = await getRun(String(body.runId || ""));
    if (!run) return res.status(404).json({ ok: false, error: "run_not_found" });
    const index = run.candidates.findIndex((candidate) => candidate.id === body.candidateId);
    if (index < 0) return res.status(404).json({ ok: false, error: "candidate_not_found" });
    const candidate = run.candidates[index];
    if (candidate.state === "dedup_blocked" || candidate.state === "enrolled") {
      return res.status(409).json({ ok: false, error: "candidate_not_reviewable" });
    }
    const updated = applyFeedback(candidate, { verdict: body.verdict, reason: body.reason, note: body.note });
    const event = {
      id: `feedback-${randomUUID()}`,
      candidateId: candidate.id,
      verdict: updated.feedback.verdict,
      reason: updated.feedback.reason,
      note: updated.feedback.note,
      actor: req.authedEmail,
      at: new Date().toISOString(),
    };
    const next = {
      ...run,
      candidates: run.candidates.map((item, itemIndex) => itemIndex === index ? updated : item),
      feedbackEvents: [...(run.feedbackEvents || []), event],
    };
    const feedback = next.candidates.map((item) => item.feedback || {});
    next.learning = proposeNextRun(feedback);
    const saved = await saveRun(next, Number(body.expectedRevision));
    return res.status(200).json({ ok: true, run: saved });
  } catch (error) {
    const conflict = error?.code === "REVISION_CONFLICT";
    return res.status(conflict ? 409 : 400).json({ ok: false, error: conflict ? "revision_conflict" : "feedback_invalid", detail: String(error?.message || error).slice(0, 200) });
  }
}
