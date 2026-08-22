// Desktop heartbeat sink.
//
// The laptop is invisible to serverless: before this endpoint, a silently-dead
// launchd lane was indistinguishable from a healthy one. That is how the
// 2026-08-04 Gmail exhaustion ran 480 consecutive failures with zero alerts,
// and how the 2026-07-28 launchd timer death went unnoticed for a day.
//
// Shared-secret auth (HEALTH_BEAT_KEY), not the Google session: the callers are
// cron jobs, not browsers.
import { timingSafeEqual } from "node:crypto";
import { hSet, lPushTrim, K } from "./_lib/kv.mjs";
import { beatLanes } from "./_lib/catalog.mjs";

const BEAT_STATUSES = new Set(["ok", "warn", "fail"]);

// Optional producer-reported numbers (sent, deferred, gmail429…), surfaced on
// the lane's tile. Bounded and numbers-only so a producer bug cannot stuff
// prose or PII into board state. Invalid metrics are DROPPED, never fatal:
// the heartbeat must land even when its garnish is malformed — losing the
// beat would fake a dead lane, which is worse than losing a number. The drop
// is visible in the response so a producer test can catch it.
const METRICS_MAX_KEYS = 12;
const METRICS_KEY_RE = /^[a-zA-Z0-9_.-]{1,32}$/;

function sanitizeMetrics(raw) {
  if (raw === undefined) return { metrics: undefined, dropped: false };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { metrics: undefined, dropped: true };
  }
  const entries = Object.entries(raw);
  if (entries.length === 0 || entries.length > METRICS_MAX_KEYS) {
    return { metrics: undefined, dropped: true };
  }
  const metrics = {};
  for (const [key, value] of entries) {
    if (!METRICS_KEY_RE.test(key) || typeof value !== "number" || !Number.isFinite(value)) {
      return { metrics: undefined, dropped: true };
    }
    metrics[key] = value;
  }
  return { metrics, dropped: false };
}

// The activity ring for the Status tab: hlth:beat:<lane> is overwrite-only
// liveness, so per-run outcomes used to be thrown away one beat later. Each
// beat is additionally appended to a 50-entry ring, hlth:beatlog:<lane>.
// A ring failure can NEVER affect the beat response — losing the beat would
// fake a dead lane, which is worse than losing a history entry — so this
// swallows everything and reports success/failure only as a boolean.
export const BEATLOG_KEEP = 50;

export async function appendBeatLog(lane, record, { push = lPushTrim } = {}) {
  try {
    await push(K.beatlog(lane), record, BEATLOG_KEEP);
    return true;
  } catch {
    return false;
  }
}

function authed(req) {
  const secret = process.env.HEALTH_BEAT_KEY || "";
  if (!secret) return false;
  const provided = req.headers?.authorization || "";
  const a = Buffer.from(provided);
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method" });
  if (!authed(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
  const lane = String(body?.lane || "");
  if (!beatLanes.has(lane)) return res.status(404).json({ ok: false, error: "unknown_lane" });
  // Keep an omitted status backward-compatible with the original green beat,
  // but never turn a typo or a new unrecognised state into a false OK.
  const status = body?.status === undefined ? "ok" : String(body.status);
  if (!BEAT_STATUSES.has(status)) {
    return res.status(400).json({ ok: false, error: "invalid_status" });
  }
  const note = String(body?.note || "").slice(0, 200);
  const { metrics, dropped } = sanitizeMetrics(body?.metrics);
  const record = {
    at: new Date().toISOString(),
    status,
    note,
    ...(metrics ? { metrics } : {}),
  };
  await hSet(K.beat(lane), record);
  await appendBeatLog(lane, record); // never throws; the beat already landed
  return res.status(200).json({ ok: true, lane, status, ...(dropped ? { metricsDropped: true } : {}) });
}
