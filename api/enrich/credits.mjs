import { cors, requireAuth, fullenrichConfigured, feCredits } from "./_lib/core.mjs";
import { contactoutConfigured, coCredits } from "./_lib/contactout.mjs";

// GET → remaining credits on both providers, for the cards at the top of /enrich.
// Tolerant: one provider failing (or being unconfigured) never hides the other.
export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (!(await requireAuth(req, res))) return;
  const [co, fe] = await Promise.allSettled([
    contactoutConfigured() ? coCredits() : Promise.reject(new Error("no_key")),
    fullenrichConfigured() ? feCredits() : Promise.reject(new Error("no_key")),
  ]);
  res.status(200).json({
    ok: true,
    contactout: co.status === "fulfilled"
      ? { ok: true, ...co.value }
      : { ok: false, error: contactoutConfigured() ? String(co.reason?.message || co.reason).slice(0, 120) : "no_key" },
    fullenrich: fe.status === "fulfilled"
      ? { ok: true, ...fe.value }
      : { ok: false, error: fullenrichConfigured() ? String(fe.reason?.message || fe.reason).slice(0, 120) : "no_key" },
  });
}
