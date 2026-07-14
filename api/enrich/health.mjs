import { cors, requireAuth, hasCookie, paraformHealth, fullenrichConfigured, feCredits } from "./_lib/core.mjs";
import { contactoutConfigured, coCredits } from "./_lib/contactout.mjs";

// GET            → open health check (page shows status pre-auth)
// GET ?credits=1 → remaining credits on both providers (auth-gated like the other
//                  endpoints). Folded in here because the dashboard project sits on
//                  Vercel's Hobby 12-function cap.
export default async function handler(req, res) {
  if (cors(req, res)) return;
  const q = req.query || (typeof req.url === "string" ? Object.fromEntries(new URL(req.url, "http://x").searchParams) : {});

  if (q.credits) {
    if (!(await requireAuth(req, res))) return;
    const [co, fe] = await Promise.allSettled([
      contactoutConfigured() ? coCredits() : Promise.reject(new Error("no_key")),
      fullenrichConfigured() ? feCredits() : Promise.reject(new Error("no_key")),
    ]);
    return res.status(200).json({
      ok: true,
      contactout: co.status === "fulfilled"
        ? { ok: true, ...co.value }
        : { ok: false, error: contactoutConfigured() ? String(co.reason?.message || co.reason).slice(0, 120) : "no_key" },
      fullenrich: fe.status === "fulfilled"
        ? { ok: true, ...fe.value }
        : { ok: false, error: fullenrichConfigured() ? String(fe.reason?.message || fe.reason).slice(0, 120) : "no_key" },
    });
  }

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
