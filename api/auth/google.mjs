import { issueSession, sessionConfig, verifyGoogleCredential } from "./_lib/session.mjs";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }
  const config = sessionConfig();
  if (!config.authRequired || !config.durableSessionEnabled) {
    return res.status(503).json({ ok: false, error: "auth_session_not_configured" });
  }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const identity = await verifyGoogleCredential(body.credential);
    const session = issueSession(identity);
    res.setHeader("Set-Cookie", session.cookie);
    return res.status(200).json({
      ok: true,
      authenticated: true,
      email: identity.email,
      expiresAt: session.expiresAt,
      sessionDays: config.sessionDays,
    });
  } catch (error) {
    const forbidden = error?.code === "forbidden";
    return res.status(forbidden ? 403 : 401).json({ ok: false, error: error?.code || "auth_check_failed" });
  }
}
