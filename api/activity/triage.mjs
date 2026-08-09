// POST /api/activity/triage — Raydar-owned done/snooze/dismiss overlay.
// Sole writer of activity:v1:triage. Paraform state is never touched here:
// triage is per-ask (keyed to the inbound item id at click time), so a NEW
// client message automatically re-surfaces a row that was marked done.

import { cors, requireAuth } from "../seq/_lib/core.mjs";
import { hsetJson, hdel, hgetallJson } from "./_lib/kv.mjs";

export const TRIAGE_KEY = "activity:v1:triage";
const STATUSES = new Set(["done", "snoozed", "dismissed", "open"]);

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "POST") { res.status(405).json({ ok: false, error: "method_not_allowed" }); return; }
  if (!(await requireAuth(req, res))) return;

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const key = String(body?.key || "").trim();           // applicationId
  const status = String(body?.status || "").trim();
  const inboundId = String(body?.inbound_id || "").trim() || null;
  const until = body?.until ? String(body.until) : null; // ISO, snooze only

  if (!key) { res.status(400).json({ ok: false, error: "key_required" }); return; }
  if (!STATUSES.has(status)) { res.status(400).json({ ok: false, error: "bad_status" }); return; }
  if (status === "snoozed" && (!until || !Number.isFinite(Date.parse(until)))) {
    res.status(400).json({ ok: false, error: "snooze_needs_until" }); return;
  }

  try {
    if (status === "open") {
      await hdel(TRIAGE_KEY, key);
    } else {
      await hsetJson(TRIAGE_KEY, key, {
        status, until, inboundId,
        by: req.authedEmail || null,
        at: new Date().toISOString(),
      });
    }
    // Read back so the click is confirmed against the store, not assumed.
    const all = await hgetallJson(TRIAGE_KEY);
    const now = all[key] || null;
    const consistent = status === "open" ? now === null : now?.status === status;
    if (!consistent) { res.status(200).json({ ok: false, error: "readback_mismatch" }); return; }
    res.status(200).json({ ok: true, key, triage: now });
  } catch (e) {
    res.status(200).json({ ok: false, error: String(e?.message || e).slice(0, 180) });
  }
}
