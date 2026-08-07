// Acknowledge a tile: mute its alerting and exclude it from the banner until
// it expires. Without this the board would open red on day one (several
// systems are legitimately degraded) and David would learn to ignore it —
// which is the exact disease this whole project treats.
import { cors, requireAuth } from "../seq/_lib/core.mjs";
import { hSet, hDel, K } from "./_lib/kv.mjs";
import { byId } from "./_lib/catalog.mjs";

const MAX_MINUTES = 20160; // 14 days

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (!(await requireAuth(req, res))) return;
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method" });
  const body = typeof req.body === "object" && req.body ? req.body : {};
  const id = String(body.id || "");
  if (!byId.has(id)) return res.status(404).json({ ok: false, error: "unknown_tile" });
  const minutes = Number(body.minutes);
  if (minutes === 0) {
    await hDel(K.ack(id));
    return res.status(200).json({ ok: true, cleared: true });
  }
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > MAX_MINUTES) {
    return res.status(400).json({ ok: false, error: "minutes_out_of_range" });
  }
  const reason = String(body.reason || "").slice(0, 200);
  if (!reason) return res.status(400).json({ ok: false, error: "reason_required" });
  const until = new Date(Date.now() + minutes * 60000).toISOString();
  await hSet(K.ack(id), { until, reason, by: req.authedEmail || "unknown" }, Math.ceil(minutes * 60) + 60);
  return res.status(200).json({ ok: true, until, reason });
}
