import { clearSessionCookie, issueSession, sessionConfig, sessionFromRequest } from "./_lib/session.mjs";

export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }
  const config = sessionConfig();
  if (!config.durableSessionEnabled) {
    return res.status(503).json({ ok: false, authenticated: false, error: "auth_session_not_configured" });
  }
  const existing = sessionFromRequest(req);
  if (!existing) {
    res.setHeader("Set-Cookie", clearSessionCookie());
    return res.status(401).json({ ok: false, authenticated: false, error: "auth_required" });
  }
  // Visiting any protected page renews the one-year trusted-browser window.
  const renewed = issueSession(existing);
  res.setHeader("Set-Cookie", renewed.cookie);
  return res.status(200).json({
    ok: true,
    authenticated: true,
    email: existing.email,
    expiresAt: renewed.expiresAt,
    sessionDays: config.sessionDays,
  });
}
