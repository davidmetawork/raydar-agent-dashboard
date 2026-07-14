import { cors, hasCookie, paraformHealth, fullenrichConfigured } from "./_lib/core.mjs";
import { contactoutConfigured } from "./_lib/contactout.mjs";

export default async function handler(req, res) {
  if (cors(req, res)) return; // open so the page can show status
  try {
    const h = await paraformHealth();
    const anyProvider = fullenrichConfigured() || contactoutConfigured();
    res.status(200).json({
      ok: h.paraform === "live" && anyProvider,
      cookieSet: hasCookie(),
      fullenrich: fullenrichConfigured(),
      contactout: contactoutConfigured(),
      ...h,
    });
  } catch (e) {
    res.status(200).json({
      ok: false, cookieSet: hasCookie(),
      fullenrich: fullenrichConfigured(), contactout: contactoutConfigured(),
      paraform: "error", detail: String(e.message || e).slice(0, 160),
    });
  }
}
