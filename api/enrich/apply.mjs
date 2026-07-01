import { cors, requireAuth, hasCookie, applyEmails, verifyApplied } from "./_lib/core.mjs";

// POST { sequenceId, items:[{cuid, ctcuid, email}] }
// Writes the chosen email onto each candidate (and their sequence lead), then re-reads
// the sequence to report how many now actually carry an email — verified, not assumed.
// ⚠ This arms real outreach: once a lead has an email, the sequence can send to them.
export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (!(await requireAuth(req, res))) return;
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });
  if (!hasCookie()) return res.status(200).json({ ok: false, error: "no_cookie" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) return res.status(400).json({ ok: false, error: "items required" });

    const { applied, appliedCount, skippedInvalid } = await applyEmails(items);
    const okCuids = applied.filter((r) => r.ok).map((r) => r.cuid);
    const verify = body.sequenceId ? await verifyApplied(body.sequenceId, okCuids) : { verifiedOnLead: null };

    res.status(200).json({ ok: true, appliedCount, skippedInvalid, applied, ...verify, ranAt: new Date().toISOString() });
  } catch (e) {
    const expired = e.code === "AUTH_EXPIRED";
    res.status(200).json({ ok: false, error: expired ? "expired" : "error", detail: String(e.message || e).slice(0, 200) });
  }
}
