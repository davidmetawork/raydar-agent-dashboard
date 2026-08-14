// Upstash REST KV, `rev:*` namespace ONLY. Same shape as the apphub/health KV
// modules — a small, single-purpose store rather than a shared one, so the
// write ownership below is enforceable by reading one file.
//
// Write ownership (the contract — do not widen):
//   rev:deals        — hash, field <dealId> -> JSON deal. Written by
//                      POST/PATCH/DELETE /api/revenue/deal and by
//                      POST /api/revenue/import. Nothing else.
//   rev:audit        — list, LPUSH of {at,who,action,dealId,before,after}.
//                      Append-only, trimmed to AUDIT_MAX. This ledger is
//                      compensation-bearing; it needs a history, and the
//                      history must never be rewritten in place.
//   rev:activity     — last-good Paraform activity payload (see activity.mjs)
//   rev:activity-at  — unix seconds of the last successful activity refresh
//   rev:activity-lock— background-refresh single-flight, EX 120
//   rev:meta         — {targetCents} operator override of the annual target
//
// WHY KV AND NOT THE STATE GIST: the dashboard-state Gist is anonymously
// readable including every past revision, so a deleted revenue row would stay
// readable forever. This data carries client names, candidate labels and
// amounts. It does not go there.
//
// DURABILITY: KV has no backup and no PITR, and this project's Upstash
// database was deleted once already (2026-07-19, history unrecoverable). The
// CSV export endpoint is therefore part of the product, not a nicety.

import { randomUUID } from "node:crypto";

const KV_URL = String(process.env.KV_REST_API_URL || "").replace(/\/+$/, "");
const KV_TOKEN = process.env.KV_REST_API_TOKEN || "";

export const kvConfigured = () => Boolean(KV_URL && KV_TOKEN);

export const K = {
  deals: "rev:deals",
  audit: "rev:audit",
  activity: "rev:activity",
  activityAt: "rev:activity-at",
  activityLock: "rev:activity-lock",
  meta: "rev:meta",
};

export const AUDIT_MAX = 2000;

export async function kv(command) {
  if (!kvConfigured()) throw new Error("revenue state store not configured");
  const response = await fetch(KV_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${KV_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(8000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`kv HTTP ${response.status}: ${String(body?.error || "request rejected").replace(/\s+/g, " ").slice(0, 180)}`);
  }
  if (body?.error) throw new Error(String(body.error).slice(0, 180));
  return body?.result ?? null;
}

const parse = (raw, fallback = null) => {
  try { return raw == null ? fallback : JSON.parse(raw); } catch { return fallback; }
};

/** Time-sortable id, so the ledger has a natural insertion order without a clock field. */
export const newDealId = (now = Date.now()) =>
  `${now.toString(36).padStart(9, "0")}-${randomUUID().slice(0, 8)}`;

export const validDealId = (id) => typeof id === "string" && /^[a-z0-9]{6,12}-[a-f0-9]{8}$/.test(id);

// ─── deals ───────────────────────────────────────────────────────────────────

export async function listDeals({ kvImpl = kv } = {}) {
  const flat = await kvImpl(["HGETALL", K.deals]);
  if (!Array.isArray(flat)) return [];
  const deals = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const deal = parse(flat[i + 1]);
    if (deal && typeof deal === "object") deals.push({ ...deal, id: deal.id || flat[i] });
  }
  // Newest signing first — how a human reads a deal list.
  return deals.sort((a, b) => String(b.offerSignedAt).localeCompare(String(a.offerSignedAt)));
}

export async function getDeal(id, { kvImpl = kv } = {}) {
  return parse(await kvImpl(["HGET", K.deals, id]));
}

export async function putDeal(deal, { kvImpl = kv } = {}) {
  return kvImpl(["HSET", K.deals, deal.id, JSON.stringify(deal)]);
}

export async function putDeals(deals, { kvImpl = kv } = {}) {
  if (!deals?.length) return 0;
  return kvImpl(["HSET", K.deals, ...deals.flatMap((deal) => [deal.id, JSON.stringify(deal)])]);
}

export async function deleteDeal(id, { kvImpl = kv } = {}) {
  return kvImpl(["HDEL", K.deals, id]);
}

// ─── audit ───────────────────────────────────────────────────────────────────

/**
 * Append-only. A failure to write the audit entry must NOT fail the mutation
 * that already succeeded — the deal write is the user's intent and is already
 * durable — but it is logged loudly, because a silent gap in a compensation
 * ledger's history is exactly the thing this file exists to prevent.
 */
export async function appendAudit(entry, { kvImpl = kv } = {}) {
  try {
    await kvImpl(["LPUSH", K.audit, JSON.stringify(entry)]);
    await kvImpl(["LTRIM", K.audit, "0", String(AUDIT_MAX - 1)]);
    return true;
  } catch (error) {
    console.error("revenue_audit_write_failed", { action: entry?.action, error: String(error?.message || error) });
    return false;
  }
}

export async function readAudit(limit = 100, { kvImpl = kv } = {}) {
  const rows = await kvImpl(["LRANGE", K.audit, "0", String(Math.max(1, Math.min(limit, AUDIT_MAX)) - 1)]);
  return Array.isArray(rows) ? rows.map((row) => parse(row)).filter(Boolean) : [];
}

// ─── meta / activity cache ───────────────────────────────────────────────────

export async function readMeta({ kvImpl = kv } = {}) {
  return parse(await kvImpl(["GET", K.meta]), {}) || {};
}

export async function writeMeta(meta, { kvImpl = kv } = {}) {
  return kvImpl(["SET", K.meta, JSON.stringify(meta)]);
}

export async function readActivity({ kvImpl = kv } = {}) {
  const [payload, at] = await Promise.all([
    kvImpl(["GET", K.activity]),
    kvImpl(["GET", K.activityAt]),
  ]);
  return { payload: parse(payload), refreshedAt: Number(at) || 0 };
}

export async function writeActivity(payload, nowSeconds, { kvImpl = kv } = {}) {
  await kvImpl(["SET", K.activity, JSON.stringify(payload)]);
  await kvImpl(["SET", K.activityAt, String(nowSeconds)]);
}

/** Single-flight guard for the background refresh. SET NX EX 120. */
export async function claimActivityLock({ kvImpl = kv } = {}) {
  const result = await kvImpl(["SET", K.activityLock, "1", "NX", "EX", "120"]);
  return result === "OK";
}
