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
import { hSet, K } from "./_lib/kv.mjs";
import { beatLanes } from "./_lib/catalog.mjs";

const BEAT_STATUSES = new Set(["ok", "warn", "fail"]);

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
  await hSet(K.beat(lane), { at: new Date().toISOString(), status, note });
  return res.status(200).json({ ok: true, lane, status });
}
