// Email Hub step 1: a read-only, server-side proxy to the Mailroom's feed and
// health endpoints. The MAILROOM_API_KEY never reaches the browser; this
// endpoint sits behind the same Raydar auth as the rest of the Emails page.
import { cors, requireAuth } from "../seq/_lib/core.mjs";

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (!(await requireAuth(req, res))) return;
  res.setHeader("cache-control", "no-store");

  const base = process.env.MAILROOM_BASE || "https://raydar-mailroom.vercel.app";
  const key = process.env.MAILROOM_API_KEY;
  if (!key) {
    // Not an outage — the page explains the one missing env instead of erroring.
    return res.status(200).json({ ok: false, configured: false });
  }
  // Hub step 2: ?message=<id> returns one email with its full body so the
  // page can render it exactly as the recipient received it.
  const messageId = Number(req.query?.message);
  if (Number.isInteger(messageId) && messageId > 0) {
    try {
      const r = await fetch(`${base}/api/message?id=${messageId}`, {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(8000),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(200).json({ ok: false, configured: true, error: `mailroom message ${r.status}` });
      return res.status(200).json({ ok: true, configured: true, ...body });
    } catch (err) {
      return res.status(200).json({ ok: false, configured: true, error: String(err && err.message || err).slice(0, 200) });
    }
  }
  try {
    const [feedRes, healthRes] = await Promise.all([
      fetch(`${base}/api/feed?limit=100`, {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(8000),
      }),
      fetch(`${base}/api/health`, { signal: AbortSignal.timeout(8000) }),
    ]);
    const feed = await feedRes.json().catch(() => ({}));
    const health = await healthRes.json().catch(() => ({}));
    if (!feedRes.ok) {
      return res.status(200).json({ ok: false, configured: true, error: `mailroom feed ${feedRes.status}` });
    }
    return res.status(200).json({ ok: true, configured: true, rows: feed.rows || [], health });
  } catch (err) {
    return res.status(200).json({ ok: false, configured: true, error: String(err && err.message || err).slice(0, 200) });
  }
}
