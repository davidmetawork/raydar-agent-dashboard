// Para AI expired-match actioning API.
//
// GET  -> health + the expired records behind the Monitor review lane.
// POST -> operator actions: the supervised canary, the backlog backfill, a
//         manual tick, and clearing a Raydar-side card.
//
// Machine callers (the Fly worker) present the runner key; humans present the
// Monitor session. Every Paraform write re-reads live state first, so a card
// David already actioned in the Paraform UI cannot double-fire.
import { timingSafeEqual } from "node:crypto";

import { cors, requireAuth } from "./_lib/core.mjs";
import {
  expiredConfig,
  expiredHealth,
  runExpiredTick,
  expiredWriteEnabled,
} from "./_lib/expired.mjs";
import {
  listExpiredRecords,
  readExpiredRecord,
  saveExpiredRecord,
  storeConfigured,
  spendDailyDismissBudget,
} from "./_lib/expired-store.mjs";
import {
  readSubmissionRequestHistory,
  readParaAiStatus,
  expiredRows,
  expiredReasonText,
  EXPIRED_REASONS,
  performExpiredDismiss,
} from "./_lib/expired-actions.mjs";

export const config = { maxDuration: 120 };

const ACTIONS = new Set(["dismiss-one", "tick", "backfill", "clear", "status"]);
const WRITE_ACTIONS = new Set(["dismiss-one", "backfill"]);
// The canary: one real dismissal on a card David names, with the automation
// gates still shut. Typed per-request so it can never be a stray click.
const DISMISS_CONFIRMATION = "DISMISS EXPIRED";
const BACKFILL_CONFIRMATION = "BACKFILL ALL EXPIRED";

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
  return req.body || {};
}

export default async function handler(req, res) {
  if (cors(req, res)) return undefined;
  if (!(await authorized(req, res))) return undefined;

  if (req.method === "GET") {
    if (!storeConfigured()) {
      return res.status(200).json({ ok: true, configured: false, health: await expiredHealth() });
    }
    const records = await listExpiredRecords(Number(req.query?.limit) || 200).catch(() => []);
    return res.status(200).json({
      ok: true,
      configured: true,
      health: await expiredHealth(),
      records,
    });
  }

  if (req.method !== "POST") {
    res.setHeader("allow", "GET, POST, OPTIONS");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  const body = bodyOf(req);
  const action = String(body.action || "").toLowerCase();
  if (!ACTIONS.has(action)) {
    return res.status(400).json({ ok: false, error: "unknown_action", actions: [...ACTIONS] });
  }

  const settings = expiredConfig();
  // The master switch gates every operator path too: a lane that has never been
  // approved cannot be driven by hand into writing.
  if (WRITE_ACTIONS.has(action) && !settings.approved) {
    return res.status(409).json({ ok: false, error: "expired_lane_not_approved" });
  }

  try {
    if (action === "status") {
      const [history, paraAi] = await Promise.all([
        readSubmissionRequestHistory(),
        readParaAiStatus().catch(() => null),
      ]);
      const rows = expiredRows(history.rows, history.currentUserId);
      return res.status(200).json({
        ok: true,
        expiredCount: history.currentUserExpiredCount,
        counts: history.counts,
        paraAi,
        matchingPaused: paraAi ? paraAi.matchingStatus !== "ACTIVE" : null,
        rows: rows.map((row) => ({
          id: row.id,
          createdAt: row.createdAt,
          roleName: row.roleName,
          companyName: row.companyName,
          reachedOut: row.reachedOut,
          statusLabel: row.statusLabel,
        })),
      });
    }

    if (action === "tick") {
      const result = await runExpiredTick({ mode: "manual", limit: Number(body.limit) || null });
      return res.status(200).json({ ok: true, result });
    }

    if (action === "clear") {
      const requestId = String(body.requestId || "");
      const record = await readExpiredRecord(requestId);
      if (!record) return res.status(404).json({ ok: false, error: "record_not_found" });
      if (Number(body.expectedRevision) !== Number(record.revision)) {
        return res.status(409).json({ ok: false, error: "revision_conflict", revision: record.revision });
      }
      const next = { ...record, status: "dismissed", resolution: "cleared_by_operator" };
      const saved = await saveExpiredRecord(next, record.revision);
      return res.status(200).json({ ok: true, record: saved });
    }

    if (action === "dismiss-one") {
      if (String(body.confirm || "") !== DISMISS_CONFIRMATION) {
        return res.status(400).json({ ok: false, error: "confirmation_required", expected: DISMISS_CONFIRMATION });
      }
      const requestId = String(body.requestId || "");
      if (!requestId) return res.status(400).json({ ok: false, error: "requestId_required" });
      const reasonKey = String(body.reasonKey || "no_response");
      if (!EXPIRED_REASONS[reasonKey]) {
        return res.status(400).json({ ok: false, error: "unknown_reason", reasons: EXPIRED_REASONS });
      }

      // Re-read live Paraform state: the row must still be expired right now.
      const history = await readSubmissionRequestHistory();
      const row = expiredRows(history.rows, history.currentUserId).find((item) => item.id === requestId);
      if (!row) return res.status(409).json({ ok: false, error: "row_not_expired_or_not_found" });

      const budget = await spendDailyDismissBudget(settings.dailyCap);
      if (!budget.granted) return res.status(429).json({ ok: false, error: "daily_cap_reached", used: budget.used });

      const outcome = await performExpiredDismiss(row, reasonKey, { claim: true, lane: "operator" });
      return res.status(200).json({
        ok: true,
        verified: outcome.verified,
        reasonSent: outcome.reason,
        rowStatus: outcome.row?.status || null,
        // The canary's headline measurement: did the pause counter actually move?
        expiredCountBefore: history.currentUserExpiredCount,
        expiredCountAfter: outcome.expiredCountAfter,
        paraAiBefore: outcome.paraAiBefore,
        paraAiAfter: outcome.paraAiAfter,
      });
    }

    if (action === "backfill") {
      if (String(body.confirm || "") !== BACKFILL_CONFIRMATION) {
        return res.status(400).json({ ok: false, error: "confirmation_required", expected: BACKFILL_CONFIRMATION });
      }
      if (!expiredWriteEnabled(settings)) {
        return res.status(409).json({ ok: false, error: "write_gates_closed", health: await expiredHealth() });
      }
      // Walks past the arming pin by design, tags every record backfillOnly so
      // the organic tick can never re-action them, and spends the same daily
      // budget as the organic lane.
      const result = await runExpiredTick({
        mode: "backfill",
        ignoreArmingPin: true,
        limit: Math.max(1, Math.min(50, Number(body.limit) || 5)),
      });
      return res.status(200).json({ ok: true, result });
    }

    return res.status(400).json({ ok: false, error: "unhandled_action" });
  } catch (error) {
    const code = String(error?.code || "expired_action_failed");
    const status = code === "AUTH_EXPIRED" ? 503 : 500;
    return res.status(status).json({ ok: false, error: code, detail: String(error?.message || error).slice(0, 240) });
  }
}
