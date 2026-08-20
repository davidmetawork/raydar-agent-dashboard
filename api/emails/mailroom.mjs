// The Email Hub's server-side bridge to the Mailroom. The MAILROOM_API_KEY
// never reaches the browser, and every write is attributed to the Google
// account the dashboard authenticated (req.authedEmail).
//
//   GET  /api/emails/mailroom              feed + health (Hub step 1)
//   GET  /api/emails/mailroom?message=<id> one email, full body (step 2)
//   GET  /api/emails/mailroom?lanes=1      lane registry + senders (step 3)
//   POST /api/emails/mailroom              { lane, sender?, enabled? } (step 3)
import { cors, requireAuth } from "../seq/_lib/core.mjs";

const TIMEOUT = 8000;

function mailroom() {
  return {
    base: process.env.MAILROOM_BASE || "https://raydar-mailroom.vercel.app",
    key: process.env.MAILROOM_API_KEY,
  };
}

async function proxy(path, init = {}) {
  const { base, key } = mailroom();
  const r = await fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...(init.headers || {}) },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, body };
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (!(await requireAuth(req, res))) return;
  res.setHeader("cache-control", "no-store");

  const { key } = mailroom();
  if (!key) return res.status(200).json({ ok: false, configured: false });

  try {
    if (req.method === "POST") {
      const actor = req.authedEmail || "unknown@raydar.xyz";
      const payload = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      if (!payload.lane) return res.status(400).json({ ok: false, error: "lane_required" });
      // Copy edits (step 4) and sender switches (step 3) are different
      // endpoints on the Mailroom; both are attributed to the signed-in user.
      const isCopy = ["save", "activate", "revert"].includes(payload.action);
      const path = isCopy ? "/api/template" : "/api/lane";
      const bodyOut = isCopy
        ? { lane: payload.lane, action: payload.action, subject: payload.subject, bodyText: payload.bodyText, version: payload.version, note: payload.note, actor }
        : { lane: payload.lane, sender: payload.sender, enabled: payload.enabled, actor };
      const r = await proxy(path, { method: "POST", body: JSON.stringify(bodyOut) });
      return res.status(200).json({ ok: r.ok && r.body.ok !== false, ...r.body });
    }

    const messageId = Number(req.query?.message);
    if (Number.isInteger(messageId) && messageId > 0) {
      const r = await proxy(`/api/message?id=${messageId}`);
      if (!r.ok) return res.status(200).json({ ok: false, configured: true, error: `mailroom message ${r.status}` });
      return res.status(200).json({ ok: true, configured: true, ...r.body });
    }

    if (req.query?.templates) {
      const r = await proxy(`/api/templates?lane=${encodeURIComponent(String(req.query.templates))}`);
      if (!r.ok) return res.status(200).json({ ok: false, configured: true, error: `mailroom templates ${r.status}` });
      return res.status(200).json({ ok: true, configured: true, ...r.body });
    }

    if (req.query?.lanes) {
      const r = await proxy("/api/lanes");
      if (!r.ok) return res.status(200).json({ ok: false, configured: true, error: `mailroom lanes ${r.status}` });
      return res.status(200).json({ ok: true, configured: true, ...r.body });
    }

    const [feed, health] = await Promise.all([proxy("/api/feed?limit=100"), proxy("/api/health")]);
    if (!feed.ok) return res.status(200).json({ ok: false, configured: true, error: `mailroom feed ${feed.status}` });
    return res.status(200).json({ ok: true, configured: true, rows: feed.body.rows || [], health: health.body });
  } catch (err) {
    return res.status(200).json({ ok: false, configured: true, error: String(err && err.message || err).slice(0, 200) });
  }
}
