import { timingSafeEqual } from "node:crypto";

import { cors, requireAuth } from "./_lib/core.mjs";
import {
  interestConfig,
  interestStatus,
  runInterestTick,
  sweepInterest,
  readSubmissionCredits,
  listInterestHandoffs,
} from "./_lib/interest.mjs";
import {
  listReviews,
  resolveReview,
  resolveInterestHandoff,
  probeInterestStore,
  storeConfigured,
} from "./_lib/interest-store.mjs";

// Curated-list interest lane endpoint.
//   GET  ?action=status      gates, last sweep, staleness
//   GET  ?action=reviews     open review cards
//   GET  ?action=handoffs    David-only curated-interest handoffs
//   GET  ?action=credits     weekly single-submission position
//   POST ?action=tick        one sweep + process (the Fly worker calls this)
//   POST ?action=sweep       detection only, never writes
//   POST ?action=resolve     David-only clear of a handled review card
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

function isAutomationBearer(req) {
  const bearer = String(req.headers?.authorization || "").replace(/^Bearer\s+/i, "");
  return Boolean(
    bearer
    && [process.env.PARAAI_AUTOMATION_RUNNER_KEY, process.env.CRON_SECRET]
      .filter(Boolean)
      .some((secret) => equalSecret(bearer, secret)),
  );
}

async function humanAuthorized(req, res) {
  if (isAutomationBearer(req)) {
    res.status(403).json({ ok: false, error: "human_auth_required" });
    return false;
  }
  if (!(await requireAuth(req, res))) return false;
  const approver = String(
    process.env.PARAAI_INTEREST_HUMAN_APPROVER_EMAIL || "",
  ).trim().toLowerCase();
  if (!approver) {
    res.status(503).json({
      ok: false,
      error: "human_approver_not_configured",
    });
    return false;
  }
  if (!humanApproverMatches(req.authedEmail)) {
    res.status(403).json({ ok: false, error: "human_approver_required" });
    return false;
  }
  return true;
}

export function humanApproverMatches(email, env = process.env) {
  const approver = String(
    env.PARAAI_INTEREST_HUMAN_APPROVER_EMAIL || "",
  ).trim().toLowerCase();
  return Boolean(
    approver
    && String(email || "").trim().toLowerCase() === approver,
  );
}

export function interestResolveConfirmation(candidateUserId, batchId = "") {
  const candidate = String(candidateUserId || "").trim();
  const batch = String(batchId || "").trim();
  return `RESOLVE ${candidate}${batch ? ` ${batch}` : ""}`;
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  const action = String(req.query?.action || "status").toLowerCase();
  const humanOnly = action === "handoffs" || action === "resolve";
  if (humanOnly) {
    if (!(await humanAuthorized(req, res))) return;
  } else if (!(await authorized(req, res))) return;

  try {
    if (req.method === "GET") {
      if (action === "status") {
        const status = await interestStatus();
        let storeProbe = null;
        if (storeConfigured()) {
          storeProbe = await probeInterestStore().then(() => ({ ok: true })).catch((e) => ({ ok: false, code: e.code }));
        }
        return res.status(200).json({ ok: true, ...status, storeProbe });
      }
      if (action === "reviews") {
        return res.status(200).json({ reviews: await listReviews() });
      }
      if (action === "handoffs") {
        const [status, handoffs] = await Promise.all([
          interestStatus(),
          listInterestHandoffs(),
        ]);
        return res.status(200).json({
          ok: true,
          status,
          handoffs,
        });
      }
      if (action === "credits") {
        return res.status(200).json({ credits: await readSubmissionCredits() });
      }
      return res.status(400).json({ error: "unknown action" });
    }

    if (req.method === "POST") {
      if (action === "tick") {
        // No mailer override: the tick resolves the delegated Gmail sender
        // itself, and the email gate still governs whether it is ever called.
        const result = await runInterestTick();
        return res.status(200).json(result);
      }
      if (action === "sweep") {
        // Detection only. Never writes to Paraform regardless of gates.
        const result = await sweepInterest({ config: interestConfig() });
        return res.status(200).json({
          ok: result.ok,
          populationSize: result.populationSize,
          cursorStart: result.cursorStart,
          cursorEnd: result.cursorEnd,
          nextCursor: result.nextCursor,
          cycleComplete: result.cycleComplete,
          cycleCandidatesRead: result.cycleCandidatesRead,
          candidatesRead: result.candidatesRead,
          seeded: result.seeded,
          detected: result.detected.length,
          readErrors: result.readErrors,
          stateDeferrals: result.stateDeferrals,
          postCallOutboxQueued: result.postCallOutboxQueued,
          postCallOutboxErrors: result.postCallOutboxErrors,
          durationMs: result.durationMs,
        });
      }
      if (action === "resolve") {
        const candidateUserId = String(req.body?.candidateUserId || "").trim();
        if (!candidateUserId) return res.status(400).json({ error: "candidateUserId required" });
        const batchId = String(req.body?.batchId || "").trim();
        if (batchId.length > 200) {
          return res.status(400).json({ error: "batchId invalid" });
        }
        if (
          req.body?.confirmation
          !== interestResolveConfirmation(candidateUserId, batchId)
        ) {
          return res.status(400).json({
            ok: false,
            error: "confirmation_required",
          });
        }
        let resolved = true;
        if (batchId) {
          resolved = await resolveInterestHandoff(candidateUserId, batchId);
        } else {
          await resolveReview(candidateUserId);
        }
        if (!resolved) {
          return res.status(404).json({
            ok: false,
            error: "handoff_not_found",
          });
        }
        return res.status(200).json({ ok: true, resolved: true });
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
