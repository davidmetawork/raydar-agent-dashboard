import { timingSafeEqual } from "node:crypto";

import { cors, requireAuth } from "./_lib/core.mjs";
import {
  discoverOutreachRequestContact,
  draftOutreachRequest,
  expiredNoDigestOverrideEligible,
  handleOutreachFailure,
  outreachConfig,
  outreachExecutionEnabled,
  OPERATOR_CONFIRMED_NO_DIGEST_REASON,
  paraformCandidateRecipientPremark,
  pendingNoDigestConfirmation,
  PENDING_DIGEST_UNAVAILABLE_REASON,
  outreachHealth,
  pendingBackfillRequests,
  processMatchRequest,
  readSubmissionRequestHistory,
  recordExpiredExternalDelivery,
  releaseHeldOutreach,
  reviewHeldOutreach,
  runOutreachTick,
} from "./_lib/outreach.mjs";
import { mailroomReliefConfirmation } from "./_lib/outreach-mailroom.mjs";
import {
  listOutreachExceptions,
  listOutreachStates,
} from "./_lib/outreach-store.mjs";

export const config = { maxDuration: 120 };

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

function bodyOf(req) {
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body || "{}"); } catch { return {}; }
  }
  return req.body && typeof req.body === "object" ? req.body : {};
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  res.setHeader("Cache-Control", "no-store");
  if (!["GET", "POST"].includes(req.method)) {
    return res.status(405).json({ ok: false, error: "GET_or_POST_only" });
  }
  if (!(await authorized(req, res))) return;

  try {
    if (req.method === "GET") {
      const [states, exceptions] = await Promise.all([
        listOutreachStates(Number(req.query?.limit || 200)),
        listOutreachExceptions(Number(req.query?.exceptionLimit || 200)),
      ]);
      return res.status(200).json({
        ok: true,
        health: await outreachHealth({ probe: req.query?.probe === "1" }),
        states,
        exceptions,
      });
    }
    const body = bodyOf(req);
    const action = String(body.action || "");
    if (action === "tick") {
      return res.status(200).json({ ok: true, tick: await runOutreachTick() });
    }
    if (action === "draft-request") {
      const requestId = String(body.requestId || "").trim();
      if (!requestId) return res.status(400).json({ ok: false, error: "requestId_required" });
      const result = await draftOutreachRequest(requestId);
      return res.status(200).json({
        ok: true,
        action: result.action,
        requestId,
        ordinal: result.ordinal,
        draft: result.draft,
        digestUrl: result.digest?.digestUrl,
        roleUrl: result.roleUrl,
        copyVariant: result.copy?.variant,
      });
    }
    if (action === "send-request") {
      const requestId = String(body.requestId || "").trim();
      if (body.confirmation !== `SEND ${requestId}`) {
        return res.status(400).json({ ok: false, error: "confirmation_required" });
      }
      const config = outreachConfig();
      if (!outreachExecutionEnabled(config)) {
        return res.status(503).json({ ok: false, error: "outreach_gates_closed" });
      }
      const history = await readSubmissionRequestHistory();
      const request = history.find((row) => row.id === requestId);
      if (!request) return res.status(404).json({ ok: false, error: "request_not_found" });
      let result;
      try {
        // The explicitly confirmed operator send is the override for a candidate
        // who has already replied; the automatic tick still refuses.
        result = await processMatchRequest(request, history, {
          mode: "send",
          config,
          allowAfterReply: true,
        });
      } catch (error) {
        await handleOutreachFailure(error, request, { config }).catch(() => {});
        throw error;
      }
      return res.status(200).json({ ok: true, action: result.action, requestId });
    }
    if (action === "send-request-via-mailroom") {
      const requestId = String(body.requestId || "").trim();
      if (!requestId) {
        return res.status(400).json({ ok: false, error: "requestId_required" });
      }
      const recipientEmail = String(body.recipientEmail || "").trim().toLowerCase();
      const withoutDigest = body.withoutDigest === true;
      if (body.confirmation !== mailroomReliefConfirmation(requestId, {
        recipientEmail,
        withoutDigest,
      })) {
        return res.status(400).json({ ok: false, error: "confirmation_required" });
      }
      if (withoutDigest && !recipientEmail) {
        return res.status(400).json({
          ok: false,
          error: "recipientEmail_required_for_no_digest_relief",
        });
      }
      const config = outreachConfig();
      if (!outreachExecutionEnabled(config)) {
        return res.status(503).json({ ok: false, error: "outreach_gates_closed" });
      }
      const history = await readSubmissionRequestHistory();
      const request = history.find((row) => row.id === requestId);
      if (!request) return res.status(404).json({ ok: false, error: "request_not_found" });
      if (
        request.status !== "pending" ||
        (request.reachedOut && !paraformCandidateRecipientPremark(request))
      ) {
        return res.status(409).json({ ok: false, error: "request_not_pending_unreached" });
      }
      let result;
      try {
        result = await processMatchRequest(request, history, {
          mode: "send",
          config,
          // This route is already protected by an exact request + recipient
          // confirmation. Match the established operator-send semantics so a
          // historical Gmail thread cannot turn an approved relief send into a
          // mailbox read or an automatic hold.
          allowAfterReply: true,
          transport: "mailroom-relief",
          contactOverride: recipientEmail ? { email: recipientEmail } : null,
          allowWithoutDigest: withoutDigest,
          allowWithoutDigestReason: withoutDigest
            ? OPERATOR_CONFIRMED_NO_DIGEST_REASON
            : null,
        });
      } catch (error) {
        await handleOutreachFailure(error, request, { config }).catch(() => {});
        throw error;
      }
      return res.status(200).json({
        ok: true,
        action: result.action,
        requestId,
        transport: result.transport || result.match?.transport || null,
        deliveryMode: result.deliveryMode || result.match?.deliveryMode || null,
        mailroomRowId:
          result.sent?.mailroomRowId || result.match?.mailroomRowId || null,
        followup: null,
      });
    }
    if (action === "send-expired-without-digest") {
      const requestId = String(body.requestId || "").trim();
      if (body.confirmation !== `SEND EXPIRED WITHOUT DIGEST ${requestId}`) {
        return res.status(400).json({ ok: false, error: "confirmation_required" });
      }
      const config = outreachConfig();
      if (!outreachExecutionEnabled(config)) {
        return res.status(503).json({ ok: false, error: "outreach_gates_closed" });
      }
      const history = await readSubmissionRequestHistory();
      const request = history.find((row) => row.id === requestId);
      if (!request) return res.status(404).json({ ok: false, error: "request_not_found" });
      if (!expiredNoDigestOverrideEligible(request)) {
        return res.status(409).json({ ok: false, error: "request_not_expired" });
      }
      let result;
      try {
        // Human-only recovery for a request that expired before its first email.
        // It deliberately skips the now-impossible digest mutation, opens a new
        // Gmail thread, and keeps all outbox/reply/follow-up safeguards.
        result = await processMatchRequest(request, history, {
          mode: "send",
          config,
          allowAfterReply: true,
          allowWithoutDigest: true,
        });
      } catch (error) {
        await handleOutreachFailure(error, request, { config }).catch(() => {});
        throw error;
      }
      return res.status(200).json({
        ok: true,
        action: result.action,
        requestId,
        deliveryMode: "expired_without_digest",
      });
    }
    if (action === "send-pending-without-digest") {
      const requestId = String(body.requestId || "").trim();
      if (body.confirmation !== pendingNoDigestConfirmation(requestId)) {
        return res.status(400).json({ ok: false, error: "confirmation_required" });
      }
      const config = outreachConfig();
      if (!outreachExecutionEnabled(config)) {
        return res.status(503).json({ ok: false, error: "outreach_gates_closed" });
      }
      const history = await readSubmissionRequestHistory();
      const request = history.find((row) => row.id === requestId);
      if (!request) return res.status(404).json({ ok: false, error: "request_not_found" });
      if (
        request.status !== "pending" ||
        (request.reachedOut && !paraformCandidateRecipientPremark(request))
      ) {
        return res.status(409).json({ ok: false, error: "request_not_pending_unreached" });
      }
      let result;
      try {
        // Operator-only escape hatch for a Paraform contradiction: the same
        // request must still read pending+digestable, have no digest, and get
        // the exact vendor ineligible error again while holding our candidate
        // lock. There is deliberately no worker/tick fallback into this path.
        result = await processMatchRequest(request, history, {
          mode: "send",
          config,
          allowAfterReply: true,
          allowWithoutDigest: true,
          allowWithoutDigestReason: PENDING_DIGEST_UNAVAILABLE_REASON,
        });
      } catch (error) {
        await handleOutreachFailure(error, request, { config }).catch(() => {});
        throw error;
      }
      return res.status(200).json({
        ok: true,
        action: result.action,
        requestId,
        deliveryMode: PENDING_DIGEST_UNAVAILABLE_REASON,
      });
    }
    if (action === "record-expired-external-delivery") {
      const requestId = String(body.requestId || "").trim();
      const gmailMessageId = String(body.gmailMessageId || "").trim();
      if (body.confirmation !== `RECORD EXPIRED DELIVERY ${requestId} ${gmailMessageId}`) {
        return res.status(400).json({ ok: false, error: "confirmation_required" });
      }
      const config = outreachConfig();
      if (!outreachExecutionEnabled(config)) {
        return res.status(503).json({ ok: false, error: "outreach_gates_closed" });
      }
      const history = await readSubmissionRequestHistory();
      const request = history.find((row) => row.id === requestId);
      if (!request) return res.status(404).json({ ok: false, error: "request_not_found" });
      const result = await recordExpiredExternalDelivery(request, history, {
        gmailMessageId,
        threadId: body.threadId,
        sentAt: body.sentAt,
      }, { config });
      return res.status(200).json({
        ok: true,
        action: result.action,
        requestId,
        deliveryMode: "expired_without_digest",
        followup: result.state?.followup ? {
          number: result.state.followup.number,
          remaining: result.state.followup.remaining,
          dueAt: result.state.followup.dueAt,
        } : null,
      });
    }
    if (action === "inspect-pending") {
      const [history, states] = await Promise.all([
        readSubmissionRequestHistory(),
        listOutreachStates(),
      ]);
      return res.status(200).json({
        ok: true,
        action,
        requests: pendingBackfillRequests(history, states),
      });
    }
    if (action === "review-held") {
      // Read-only: re-judges every request parked by the old block-on-any-reply
      // rule and reports what would send. Never delivers email.
      return res.status(200).json({
        ok: true,
        action,
        ...(await reviewHeldOutreach({
          limit: Number(body.limit || 50),
          requestId: String(body.requestId || "").trim() || null,
        })),
      });
    }
    if (action === "release-held") {
      if (body.confirmation !== "RELEASE HELD REPLIES") {
        return res.status(400).json({ ok: false, error: "confirmation_required" });
      }
      const config = outreachConfig();
      if (!outreachExecutionEnabled(config)) {
        return res.status(503).json({ ok: false, error: "outreach_gates_closed" });
      }
      return res.status(200).json({
        ok: true,
        action,
        // requestId narrows the release to one held record. Without it the action
        // releases every sendable held request, which is rarely what an operator
        // working a single candidate means.
        ...(await releaseHeldOutreach({
          config,
          limit: Number(body.limit || 5),
          requestId: String(body.requestId || "").trim() || null,
        })),
      });
    }
    if (action === "discover-request-contact") {
      const requestId = String(body.requestId || "").trim();
      if (!requestId) return res.status(400).json({ ok: false, error: "requestId_required" });
      const result = await discoverOutreachRequestContact(requestId);
      return res.status(200).json({
        ok: true,
        action,
        request: result.request,
        discovery: result.discovery,
      });
    }
    if (action === "backfill-pending") {
      if (body.confirmation !== "SEND ALL CURRENT PENDING") {
        return res.status(400).json({ ok: false, error: "confirmation_required" });
      }
      const config = outreachConfig();
      if (!outreachExecutionEnabled(config)) {
        return res.status(503).json({ ok: false, error: "outreach_gates_closed" });
      }
      const limit = Math.max(1, Math.min(5, Number(body.limit || 5)));
      const [history, states] = await Promise.all([
        readSubmissionRequestHistory(),
        listOutreachStates(),
      ]);
      const batch = pendingBackfillRequests(history, states).slice(0, limit);
      const results = [];
      for (const request of batch) {
        try {
          const result = await processMatchRequest(request, history, { mode: "send", config });
          results.push({
            action: result.action,
            requestId: request.id,
            candidateName: request.candidateName,
            roleName: request.roleName,
            companyName: request.companyName,
          });
        } catch (error) {
          await handleOutreachFailure(error, request, { config }).catch(() => {});
          results.push({
            action: "error",
            requestId: request.id,
            candidateName: request.candidateName,
            roleName: request.roleName,
            companyName: request.companyName,
            code: String(error?.code || "OUTREACH_FAILED"),
          });
        }
      }
      const [refreshedHistory, refreshedStates] = await Promise.all([
        readSubmissionRequestHistory(),
        listOutreachStates(),
      ]);
      return res.status(200).json({
        ok: true,
        action,
        processed: results.filter((result) => result.action === "sent").length,
        results,
        remaining: pendingBackfillRequests(refreshedHistory, refreshedStates).length,
      });
    }
    return res.status(400).json({ ok: false, error: "unsupported_action" });
  } catch (error) {
    const code = String(error?.code || "OUTREACH_FAILED");
    const status = code === "OUTREACH_REQUEST_NOT_FOUND" ? 404
      : code === "OUTREACH_BUSY" || code === "OUTREACH_REVISION_CONFLICT" ? 409
        : code.includes("NOT_CONFIGURED") || code.includes("GATES") ? 503
          : 400;
    return res.status(status).json({
      ok: false,
      error: code,
      detail: String(error?.message || error).slice(0, 240),
    });
  }
}
