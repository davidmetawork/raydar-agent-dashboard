import { clearSessionCookie } from "./_lib/session.mjs";

export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }
  res.setHeader("Set-Cookie", clearSessionCookie());
  return res.status(200).json({ ok: true, authenticated: false });
}
