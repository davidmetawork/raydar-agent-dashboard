import { cors, hasCookie, paraformHealth } from "./_lib/core.mjs";

export default async function handler(req, res) {
  if (cors(req, res)) return; // health is open so the page can show status
  try {
    const h = await paraformHealth();
    res.status(200).json({ ok: h.paraform === "live", cookieSet: hasCookie(), ...h });
  } catch (e) {
    res.status(200).json({ ok: false, cookieSet: hasCookie(), paraform: "error", detail: String(e.message || e).slice(0, 160) });
  }
}
