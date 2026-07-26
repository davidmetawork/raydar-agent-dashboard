import { cors, hasCookie, paraformHealth } from "./_lib/core.mjs";
import { sweepStaleness } from "./_lib/booking-stop.mjs";

export default async function handler(req, res) {
  if (cors(req, res)) return; // health is open so the page can show status
  // Booking-stop liveness is reported HERE, on the one unauthenticated endpoint,
  // deliberately. The sweep's own staleness alarm lives inside the sweep — which
  // is no use at all if the sweep stops being invoked, and that is precisely the
  // failure that went unnoticed for nine days. Exposing it here means liveness
  // can be checked from outside the cron's own auth path (counts only, no PII).
  let bookingStop = null;
  try {
    const s = await sweepStaleness();
    bookingStop = {
      lastSuccessfulSweep: s.lastAt,
      ageMinutes: s.ageMs == null ? null : Math.round(s.ageMs / 60000),
      stale: s.stale,
      activeLeadsLastPass: s.activeLeads ?? null,
    };
  } catch { bookingStop = { error: "unavailable" }; }

  try {
    const h = await paraformHealth();
    res.status(200).json({ ok: h.paraform === "live", cookieSet: hasCookie(), ...h, bookingStop });
  } catch (e) {
    res.status(200).json({ ok: false, cookieSet: hasCookie(), paraform: "error", detail: String(e.message || e).slice(0, 160), bookingStop });
  }
}
