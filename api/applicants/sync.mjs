// Machine channel between the desktop interview loop and the Applicants tab.
//
// POST: the loop publishes the stream/queue snapshot, reports send outcomes
// (acks), and prewarms complete applicant profile JSONs (profiles → the
// apphub:profile:* cache keys plus the apphub:photos hash).
// GET: the loop pulls human "interview" approvals it has not yet
// acknowledged. Shared-secret auth (APPHUB_SYNC_KEY), never requireAuth — the
// caller is a launchd cron, not a browser (pattern: api/health/beat.mjs).
// 401 carries no detail on purpose.

import { timingSafeEqual } from "node:crypto";
import {
  hashDelMany,
  hashGetAllJson,
  hashKeys,
  hashSetJson,
  K,
  kvConfigured,
  PROFILE_TTL_SECONDS,
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

// Prewarmed profiles ride sync as `{<cuId>: profileJson}` — the desktop loop
// bulk-writes the same apphub:profile:* cache keys api/applicants/profile.mjs
// fills on a cache miss (identical shape; see the kv.mjs header contract).
// All-or-nothing like acks: one bad entry rejects the whole batch before
// anything is written. Per-profile byte cap because the body-level cap alone
// would let one bloated profile ride in with the rest of the batch.
// Photos: only imageSrc values on the stable public Paraform bucket are
// collected into the apphub:photos hash — anything else (foreign hosts,
// expiring signed URLs) is silently dropped, not an error.
const CU_RE = /^[a-z0-9]{10,40}$/i;
export const MAX_PROFILE_BYTES = 30_000;
const PHOTO_URL_PREFIX = "https://storage.googleapis.com/paraform-images/";

export function normalizeProfiles(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, badCu: null };
  }
  const profiles = {};
  const photos = {};
  for (const [rawCu, profile] of Object.entries(input)) {
    const cu = String(rawCu || "").trim();
    if (!CU_RE.test(cu)
      || !profile || typeof profile !== "object" || Array.isArray(profile)
      || Buffer.byteLength(JSON.stringify(profile)) > MAX_PROFILE_BYTES) {
      return { ok: false, badCu: cu || null };
    }
    profiles[cu] = profile;
    if (typeof profile.imageSrc === "string" && profile.imageSrc.startsWith(PHOTO_URL_PREFIX)) {
      photos[cu] = profile.imageSrc;
    }
  }
  return { ok: true, profiles, photos };
}

export function createSyncHandler({
  kvReady = kvConfigured,
  readHash = hashGetAllJson,
  writeHash = hashSetJson,
  writeJson = setJson,
  readHashKeys = hashKeys,
  deleteHashFields = hashDelMany,
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
      // Photos hygiene: the hash has no TTL, so without pruning it grows for
      // every applicant ever seen while feed HGETALLs it on every poll. When a
      // full publish arrives (snapshot AND queue together), photos for people
      // no longer on the tab are dropped. Best-effort — a prune failure must
      // never fail the push that carried real data.
      if (stored.snapshot && stored.queue) {
        try {
          const keep = new Set(
            [...(Array.isArray(body.snapshot?.stream) ? body.snapshot.stream : []), ...body.queue]
              .map((row) => row?.cuId).filter(Boolean),
          );
          const drop = (await readHashKeys(K.photos)).filter((cu) => !keep.has(cu));
          if (drop.length) await deleteHashFields(K.photos, drop);
        } catch { /* hygiene only */ }
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
      // `stored.profiles` only appears when the field was sent, so responses
      // to profile-less POSTs (the existing loop payloads) stay unchanged.
      if (body.profiles != null) {
        const normalized = normalizeProfiles(body.profiles);
        if (!normalized.ok) {
          return res.status(400).json({ ok: false, error: "invalid_profile", cu: normalized.badCu });
        }
        const entries = Object.entries(normalized.profiles);
        for (const [cu, profile] of entries) {
          await writeJson(K.profile(cu), profile, PROFILE_TTL_SECONDS);
        }
        if (Object.keys(normalized.photos).length) {
          await writeHash(K.photos, normalized.photos);
        }
        stored.profiles = entries.length;
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
