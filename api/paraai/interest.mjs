import { timingSafeEqual } from "node:crypto";

import { cors, requireAuth } from "./_lib/core.mjs";
import {
  interestConfig,
  interestStatus,
  runInterestTick,
  sweepInterest,
  readSubmissionCredits,
} from "./_lib/interest.mjs";
import { listReviews, resolveReview, probeInterestStore, storeConfigured } from "./_lib/interest-store.mjs";

// Curated-list interest lane endpoint.
//   GET  ?action=status      gates, last sweep, staleness
//   GET  ?action=reviews     open review cards
//   GET  ?action=credits     weekly single-submission position
//   POST ?action=tick        one sweep + process (the Fly worker calls this)
//   POST ?action=sweep       detection only, never writes
//   POST ?action=resolve     clear a review card
//
// Plan: docs/PLAN-CURATED-INTEREST-TO-SUBMISSION-2026-07-28.md

export const config = { maxDuration: 300 };

function equalSecret(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

async function authorized(req, res) {
  const bearer = String(req.headers?.authorization || "").replace(/^Bearer\s+/i, "");
  if (
    bearer &&
    [process.env.PARAAI_AUTOMATION_RUNNER_KEY, process.env.CRON_SECRET]
      .filter(Boolean)
      .some((secret) => equalSecret(bearer, secret))
  ) return true;
  return requireAuth(req, res);
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (!(await authorized(req, res))) return;

  const action = String(req.query?.action || "status").toLowerCase();

  try {
    if (req.method === "GET") {
      if (action === "status") {
        const status = await interestStatus();
        let storeProbe = null;
        if (storeConfigured()) {
          storeProbe = await probeInterestStore().then(() => ({ ok: true })).catch((e) => ({ ok: false, code: e.code }));
        }
        return res.status(200).json({ ...status, storeProbe });
      }
      if (action === "reviews") {
        return res.status(200).json({ reviews: await listReviews() });
      }
      if (action === "credits") {
        return res.status(200).json({ credits: await readSubmissionCredits() });
      }
      return res.status(400).json({ error: "unknown action" });
    }

    if (req.method === "POST") {
      if (action === "tick") {
        const result = await runInterestTick({ mailer: null });
        return res.status(200).json(result);
      }
      if (action === "sweep") {
        // Detection only. Never writes to Paraform regardless of gates.
        const result = await sweepInterest({ config: interestConfig() });
        return res.status(200).json({
          ok: result.ok,
          candidatesRead: result.candidatesRead,
          seeded: result.seeded,
          detected: result.detected.length,
          readErrors: result.readErrors,
          durationMs: result.durationMs,
        });
      }
      if (action === "resolve") {
        const candidateUserId = String(req.body?.candidateUserId || "").trim();
        if (!candidateUserId) return res.status(400).json({ error: "candidateUserId required" });
        await resolveReview(candidateUserId);
        return res.status(200).json({ resolved: true });
      }
      return res.status(400).json({ error: "unknown action" });
    }

    return res.status(405).json({ error: "method not allowed" });
  } catch (error) {
    return res.status(500).json({
      error: String(error?.message || error).slice(0, 300),
      code: error?.code || null,
    });
  }
}
