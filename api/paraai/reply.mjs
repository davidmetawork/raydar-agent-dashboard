// Para AI reply actioning API.
//
// GET  -> health + the reply records behind the Monitor review lane.
// POST -> operator actions on one reply record (the review card buttons).
//
// Machine callers (the Fly worker) present the runner key; humans present the
// Monitor session. Every write action re-reads live Paraform state first, so a
// card that David already actioned in the Paraform UI cannot double-fire.
import { timingSafeEqual } from "node:crypto";

import { cors, requireAuth } from "./_lib/core.mjs";
import {
  replyConfig,
  replyHealth,
  runReplyTick,
  runReplyBackfill,
  planReplyAction,
  executeAction,
} from "./_lib/reply.mjs";
import {
  listReplyRecords,
  readReplyRecord,
  saveReplyRecord,
  acquireReplyLock,
  releaseReplyLock,
  storeConfigured,
} from "./_lib/reply-store.mjs";
import {
  readSubmissionRequests,
  pendingRequestsFor,
  performPass,
  performOffMarket,
  reEnableCandidate,
  expiresAtMs,
} from "./_lib/reply-actions.mjs";
import { listJobs } from "./_lib/store.mjs";

export const config = { maxDuration: 120 };

const ACTIONS = new Set(["submit", "pass", "off-market", "re-enable", "dismiss", "tick", "backfill"]);
// Actions that mutate Paraform. "dismiss" only clears the Raydar-side card.
const WRITE_ACTIONS = new Set(["submit", "pass", "off-market", "re-enable"]);
const CONFIRM_WORDS = {
  submit: "SUBMIT",
  pass: "PASS",
  "off-market": "OFF-MARKET",
  "re-enable": "RE-ENABLE",
};
const BACKFILL_CONFIRMATION = "BACKFILL ALL REPLIES";

function equalSecret(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

async function authorized(req, res) {
  const bearer = String(req.headers?.authorization || "").replace(/^Bearer\s+/i, "");
  if (
    bearer
    && [process.env.PARAAI_AUTOMATION_RUNNER_KEY, process.env.CRON_SECRET]
      .filter(Boolean)
      .some((secret) => equalSecret(bearer, secret))
  ) return true;
  return requireAuth(req, res);
}

function bodyOf(req) {
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body || "{}"); } catch { return {}; }
  }
  return req.body && typeof req.body === "object" ? req.body : {};
}

function statusFor(code) {
  if (code === "AUTH_EXPIRED") return 503;
  if (code === "REPLY_REVISION_CONFLICT" || code === "REPLY_ALREADY_CLAIMED") return 409;
  if (code === "REPLY_RECORD_NOT_FOUND") return 404;
  if (code === "REPLY_NOT_CONFIGURED") return 503;
  return 500;
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  res.setHeader("Cache-Control", "no-store");
  if (!["GET", "POST"].includes(req.method)) {
    return res.status(405).json({ ok: false, error: "GET_or_POST_only" });
  }
  if (!(await authorized(req, res))) return;
  if (!storeConfigured()) {
    return res.status(503).json({ ok: false, error: "state_store_not_configured" });
  }

  try {
    if (req.method === "GET") {
      const [health, records] = await Promise.all([
        replyHealth(),
        listReplyRecords(Number(req.query?.limit || 200)),
      ]);
      return res.status(200).json({ ok: true, health, records: records.map(publicRecord) });
    }

    const body = bodyOf(req);
    const action = String(body.action || "").trim();
    if (!ACTIONS.has(action)) {
      return res.status(400).json({ ok: false, error: "unknown_action", detail: [...ACTIONS].join(", ") });
    }

    if (action === "tick") {
      const result = await runReplyTick();
      return res.status(200).json({ ok: true, result });
    }

    // The backfill is a supervised, explicitly confirmed operation. It walks the
    // whole outreach history past the arming pin and freezes what it writes, so
    // it is deliberately not something the worker can trigger on its own.
    if (action === "backfill") {
      if (String(body.confirmation || "").trim() !== BACKFILL_CONFIRMATION) {
        return res.status(400).json({ ok: false, error: "confirmation_required", detail: BACKFILL_CONFIRMATION });
      }
      const result = await runReplyBackfill({ limit: body.limit });
      return res.status(200).json({ ok: true, result });
    }

    const replyId = String(body.replyId || "").trim();
    if (!replyId) return res.status(400).json({ ok: false, error: "replyId_required" });

    // The operator path deliberately does NOT require the per-action automation
    // gates: the whole point of a dark rollout is that David can work the review
    // queue by hand while the worker writes nothing. It does require the master
    // switch, so one flip kills every write this subsystem can make, by hand or
    // otherwise.
    if (WRITE_ACTIONS.has(action) && !replyConfig().approved) {
      return res.status(409).json({
        ok: false,
        error: "reply_lane_not_approved",
        detail: "PARAAI_REPLY_APPROVED is unset, so no Paraform write is permitted from this lane",
      });
    }

    // Confirmation strings are load-bearing here exactly as they are on
    // /api/paraai/run: one misclick must not dismiss a hiring manager's request.
    if (WRITE_ACTIONS.has(action)) {
      const expected = `${CONFIRM_WORDS[action]} ${replyId}`;
      if (String(body.confirmation || "").trim() !== expected) {
        return res.status(400).json({ ok: false, error: "confirmation_required", detail: expected });
      }
    }

    const record = await readReplyRecord(replyId);
    if (!record) return res.status(404).json({ ok: false, error: "reply_not_found" });
    if (Number(body.expectedRevision) !== Number(record.revision)) {
      return res.status(409).json({ ok: false, error: "revision_conflict", detail: `current revision ${record.revision}` });
    }

    const lock = await acquireReplyLock(replyId);
    if (!lock) return res.status(409).json({ ok: false, error: "reply_busy" });
    try {
      if (action === "dismiss") {
        const next = { ...record, status: "dismissed", dismissedAt: new Date().toISOString() };
        const saved = await saveReplyRecord(next, record.revision);
        return res.status(200).json({ ok: true, record: publicRecord(saved) });
      }

      // Live Paraform state is the authority for what is still actionable.
      const requests = await readSubmissionRequests();
      const pending = pendingRequestsFor(record.candidateUserId, requests);
      if (!pending.length) {
        const saved = await saveReplyRecord(
          { ...record, status: "no_action", resolution: "no_pending_requests" },
          record.revision,
        );
        return res.status(200).json({ ok: true, record: publicRecord(saved), detail: "no pending requests remain" });
      }

      if (action === "submit") {
        const jobs = await listJobs(300).catch(() => []);
        const plan = await planReplyAction(record, { requests, jobs, config: replyConfig() });
        if (plan.action !== "submit") {
          return res.status(409).json({
            ok: false,
            error: "not_submittable",
            detail: `the live plan for this reply is ${plan.action} (${plan.reason})`,
          });
        }
        const requested = Array.isArray(body.requestIds) && body.requestIds.length
          ? plan.requestIds.filter((id) => body.requestIds.includes(id))
          : plan.requestIds;
        if (!requested.length) {
          return res.status(409).json({
            ok: false,
            error: "requests_no_longer_pending",
            detail: "the selected requests are no longer submittable; refresh the card",
          });
        }
        const results = await executeAction(record, { ...plan, requestIds: requested }, {
          requests, jobs, config: replyConfig(), force: true,
        });
        const failed = results.filter((row) => ["blocked", "unverified", "error", "missing"].includes(row.outcome));
        const saved = await saveReplyRecord(
          {
            ...record,
            status: failed.length ? "needs_review" : "actioned",
            resolution: failed.length ? "operator_submit_incomplete" : "submitted_by_operator",
            results,
          },
          record.revision,
        );
        return res.status(200).json({ ok: true, record: publicRecord(saved), results });
      }

      if (action === "re-enable") {
        await reEnableCandidate(record.candidateUserId);
        const saved = await saveReplyRecord(
          { ...record, status: "reverted", resolution: "re_enabled" },
          record.revision,
        );
        return res.status(200).json({ ok: true, record: publicRecord(saved) });
      }

      const requestIds = Array.isArray(body.requestIds) && body.requestIds.length
        ? pending.filter((request) => body.requestIds.includes(request.id))
        : pending;
      // Every requested id has already left PENDING while other requests remain.
      // Writing nothing and recording "actioned" would overstate what happened,
      // so this is reported as a stale card instead.
      if (!requestIds.length) {
        return res.status(409).json({
          ok: false,
          error: "requests_no_longer_pending",
          detail: "the selected requests are no longer pending; refresh the card",
        });
      }
      const reasonKey = String(body.reason || (action === "off-market" ? "off_market" : "not_interested"));
      const results = [];
      for (const request of requestIds) {
        const outcome = await performPass(request, reasonKey);
        results.push({ requestId: request.id, outcome: outcome.verified ? "dismissed" : "unverified" });
      }
      if (action === "off-market") {
        const offMarket = await performOffMarket(record.candidateUserId);
        results.push({ requestId: null, outcome: "off_market", verified: offMarket.verified });
      }
      // A write that could not be proven by read-back leaves the card in review
      // rather than closing it.
      const unverified = results.some((row) => row.outcome === "unverified");
      const saved = await saveReplyRecord(
        {
          ...record,
          status: unverified ? "needs_review" : "actioned",
          resolution: unverified
            ? "operator_write_unverified"
            : action === "off-market" ? "off_market_by_operator" : "passed_by_operator",
          results,
        },
        record.revision,
      );
      return res.status(200).json({ ok: true, record: publicRecord(saved), results });
    } finally {
      await releaseReplyLock(replyId, lock).catch(() => {});
    }
  } catch (error) {
    const code = String(error?.code || "reply_request_failed");
    return res.status(statusFor(code)).json({
      ok: false,
      error: code,
      detail: String(error?.message || error).slice(0, 240),
    });
  }
}

// The reply body itself never leaves the store. The card gets the verbatim
// evidence quote the decision actually rested on, and nothing more.
export function publicRecord(record) {
  return {
    replyId: record.replyId,
    revision: record.revision,
    candidateUserId: record.candidateUserId,
    candidateName: record.candidateName,
    receivedAt: record.receivedAt,
    status: record.status,
    shadow: record.shadow === true,
    summary: record.summary || null,
    intent: record.decision?.intent || null,
    confidence: record.decision?.confidence || null,
    evidence: record.decision?.evidence || null,
    conditions: record.decision?.conditions || [],
    provenance: record.decision?.provenance || [],
    reviewReason: record.decision?.reviewReason || record.plan?.reason || null,
    plan: record.plan || null,
    results: record.results || null,
    resolution: record.resolution || null,
    threadId: record.threadId,
  };
}

export { expiresAtMs, planReplyAction, replyConfig };
