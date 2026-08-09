// Machine channel between the desktop interview loop and the Applicants tab.
//
// POST: the loop publishes the stream/queue snapshot and reports send outcomes
// (acks). GET: the loop pulls human "interview" approvals it has not yet
// acknowledged. Shared-secret auth (APPHUB_SYNC_KEY), never requireAuth — the
// caller is a launchd cron, not a browser (pattern: api/health/beat.mjs).
// 401 carries no detail on purpose.

import { timingSafeEqual } from "node:crypto";
import {
  hashGetAllJson,
  hashSetJson,
  K,
  kvConfigured,
  setJson,
  validKey,
} from "./_lib/kv.mjs";

export const config = { maxDuration: 30 };

// The loop caps the snapshot on its side (drops per-step detail); this guard
// keeps a buggy publisher from parking a multi-megabyte blob in KV.
export const MAX_SNAPSHOT_BYTES = 900_000;
const ACK_STATUSES = new Set(["invited", "blocked"]);

function authed(req) {
  const secret = process.env.APPHUB_SYNC_KEY || "";
  if (!secret) return false;
  const provided = req.headers?.authorization || "";
  const a = Buffer.from(provided);
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Accepts acks as `{key: record}` or `[{key, ...record}]`. All-or-nothing:
// one malformed entry rejects the batch before anything is written, so the
// loop's stderr shows exactly which key it produced wrong.
export function normalizeAcks(input, now = () => new Date().toISOString()) {
  const entries = Array.isArray(input)
    ? input.map((entry) => [entry?.key, entry])
    : input && typeof input === "object" ? Object.entries(input) : null;
  if (!entries) return { ok: false, badKey: null };
  const acks = {};
  for (const [rawKey, record] of entries) {
    const key = String(rawKey || "").trim();
    const status = String(record?.status || "");
    if (!validKey(key) || !ACK_STATUSES.has(status)) {
      return { ok: false, badKey: key || null };
    }
    acks[key] = {
      status,
      at: String(record?.at || "") || now(),
      ...(record?.reason ? { reason: String(record.reason).slice(0, 200) } : {}),
      ...(record?.inviteId ? { inviteId: String(record.inviteId).slice(0, 100) } : {}),
    };
  }
  return { ok: true, acks };
}

export function createSyncHandler({
  kvReady = kvConfigured,
  readHash = hashGetAllJson,
  writeHash = hashSetJson,
  writeJson = setJson,
  now = () => new Date().toISOString(),
} = {}) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    if (!authed(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
    if (!kvReady()) return res.status(503).json({ ok: false, error: "state_store_not_configured" });

    try {
      if (req.method === "GET") {
        const [decisions, acks] = await Promise.all([
          readHash(K.decisions),
          readHash(K.acks),
        ]);
        const approvals = Object.entries(decisions)
          .filter(([key, decision]) => decision?.action === "interview" && !acks[key])
          .map(([key, decision]) => ({ key, ...decision }));
        return res.status(200).json({ ok: true, generatedAt: now(), decisions: approvals });
      }
      if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method" });

      let body;
      try { body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {}); }
      catch { return res.status(400).json({ ok: false, error: "invalid_json" }); }

      const stored = { snapshot: false, queue: false, acks: 0 };
      if (body.snapshot != null) {
        if (typeof body.snapshot !== "object" || Array.isArray(body.snapshot)) {
          return res.status(400).json({ ok: false, error: "invalid_snapshot" });
        }
        const bytes = Buffer.byteLength(JSON.stringify(body.snapshot));
        if (bytes > MAX_SNAPSHOT_BYTES) {
          return res.status(413).json({ ok: false, error: "snapshot_too_large", bytes, max: MAX_SNAPSHOT_BYTES });
        }
        await writeJson(K.snapshot, body.snapshot);
        stored.snapshot = true;
      }
      // The queue rides its own key so a large review backlog can never
      // squeeze the stream out of the snapshot cap (each part gets the full
      // budget; the 2026-08-09 seed hit exactly this with 2,151 queue rows).
      if (body.queue != null) {
        if (!Array.isArray(body.queue)) {
          return res.status(400).json({ ok: false, error: "invalid_queue" });
        }
        const doc = { generatedAt: String(body.snapshot?.generatedAt || now()), rows: body.queue };
        const bytes = Buffer.byteLength(JSON.stringify(doc));
        if (bytes > MAX_SNAPSHOT_BYTES) {
          return res.status(413).json({ ok: false, error: "queue_too_large", bytes, max: MAX_SNAPSHOT_BYTES });
        }
        await writeJson(K.queue, doc);
        stored.queue = true;
      }
      if (body.acks != null) {
        const normalized = normalizeAcks(body.acks, now);
        if (!normalized.ok) {
          return res.status(400).json({ ok: false, error: "invalid_ack", key: normalized.badKey });
        }
        if (Object.keys(normalized.acks).length) {
          await writeHash(K.acks, normalized.acks);
          stored.acks = Object.keys(normalized.acks).length;
        }
      }
      return res.status(200).json({ ok: true, stored });
    } catch (error) {
      return res.status(502).json({
        ok: false,
        error: "store_unavailable",
        detail: String(error?.message || error).slice(0, 180),
      });
    }
  };
}

export default createSyncHandler();
