// ─────────────────────────────────────────────────────────────────────────────
// enrich/core.mjs — engine for the "Enrich" page.
//
// Finds candidates who are enrolled in a Paraform email sequence but have NO email
// (so the sequence can't reach them), looks up their email via FullEnrich
// (fullenrich.com), and — on explicit apply — writes the found email back onto the
// Paraform candidate so the sequence can send.
//
// Reuses the Sequences launcher's Paraform session + auth plumbing (../../seq/_lib/core.mjs)
// so there's ONE service cookie and ONE Google gate. Nothing here touches the frozen
// screener / status contract.
//
// Live-verified 2026-06-30:
//   • read leads   → campaigns.getCampaign { campaign_id } embeds campaign_to_candidate_users,
//                    each with candidate_email (null = no email), id (= campaign_to_candidate_user_id),
//                    candidate_user_id, and nested candidate_user.candidate {name, linkedin_user, experiences}
//   • enrich       → POST app.fullenrich.com/api/v2/contact/enrich/bulk → { enrichment_id }
//                    GET  .../bulk/{id} → { status, data:[{ custom, contact_info:{ most_probable_work_email:{email,status}, … }}] }
//   • write email  → candidateUser.updateCandidateUserEmailForUser { candidate_user_id, email }  (zod: both required)
//                    campaigns.updateSequenceCandidateEmail { campaign_to_candidate_user_id, email } (best-effort, lead-scoped)
// ─────────────────────────────────────────────────────────────────────────────

import { trpcGet, trpcPost } from "../../seq/_lib/core.mjs";

export { cors, requireAuth, hasCookie, authConfig, paraformHealth } from "../../seq/_lib/core.mjs";

const FULLENRICH_KEY = process.env.FULLENRICH_API_KEY || "";
const FE_BASE = "https://app.fullenrich.com/api/v2";
export const FE_BULK_MAX = 100; // FullEnrich caps a bulk request at 100 contacts

export function fullenrichConfigured() { return !!FULLENRICH_KEY; }

const feHeaders = () => ({ authorization: "Bearer " + FULLENRICH_KEY, "content-type": "application/json" });

// ---------- candidate-input extraction (from an emailless sequence lead) ----------
const CRED_SUFFIX = /,?\s*\b(?:MD|MS|MSc|MBA|PhD|MPH|JD|DO|RN|CFA|CPA|PE|Esq|Jr|Sr|II|III|IV)\.?\b/gi;

function splitName(raw) {
  const clean = String(raw || "").replace(CRED_SUFFIX, "").replace(/\s+/g, " ").trim();
  if (!clean) return { first: "", last: "" };
  const parts = clean.split(" ");
  return { first: parts[0], last: parts.slice(1).join(" ") };
}
function linkedinUrl(handle) {
  const h = String(handle || "").trim();
  if (!h) return null;
  if (/^https?:\/\//i.test(h)) return h;
  return "https://www.linkedin.com/in/" + h.replace(/^\/+|\/+$/g, "");
}
function currentCompany(cand) {
  const exps = Array.isArray(cand?.experiences) ? cand.experiences : [];
  const current = exps.find((e) => !e?.end_date) || exps[0];
  return current?.company_name || "";
}

// One getCampaign call → the emailless candidates in a sequence, with enrichment inputs.
// Returns { sequence, totalLeads, candidates:[{cuid, ctcuid, name, linkedinUrl, company, firstName, lastName}], skipped }
export async function findEmaillessCandidates(sequenceId) {
  const camp = await trpcGet("campaigns.getCampaign", { campaign_id: sequenceId });
  if (!camp) throw new Error("sequence not found");
  const leads = Array.isArray(camp.campaign_to_candidate_users) ? camp.campaign_to_candidate_users : [];

  const candidates = [];
  let skipped = 0;
  for (const l of leads) {
    if ((l.candidate_email || "").trim()) continue;   // already has an email
    if (l.is_archived) continue;                       // not an active lead
    const cand = l.candidate_user?.candidate || {};
    const { first, last } = splitName(cand.name);
    const li = linkedinUrl(cand.linkedin_user);
    if (!first && !li) { skipped++; continue; }        // nothing to enrich on
    candidates.push({
      cuid: l.candidate_user_id,
      ctcuid: l.id,
      name: (cand.name || "").trim() || `${first} ${last}`.trim(),
      firstName: first, lastName: last,
      linkedinUrl: li, company: currentCompany(cand),
    });
  }
  return { sequence: camp.name, totalLeads: leads.length, candidates, skipped };
}

// ---------- FullEnrich ----------
// Map the page's checkbox keys → FullEnrich enrich_fields.
const FIELD_MAP = { personal: "contact.personal_emails", work: "contact.work_emails", phone: "contact.phones" };
export function toEnrichFields(want) {
  const fields = (Array.isArray(want) && want.length ? want : ["personal"]).map((k) => FIELD_MAP[k]).filter(Boolean);
  return fields.length ? [...new Set(fields)] : ["contact.personal_emails"];
}

export async function startEnrichment(name, candidates, enrichFields) {
  const fields = (Array.isArray(enrichFields) && enrichFields.length) ? enrichFields : ["contact.personal_emails"];
  const data = candidates.slice(0, FE_BULK_MAX).map((c) => {
    const row = {
      first_name: c.firstName || undefined,
      last_name: c.lastName || undefined,
      company_name: c.company || undefined,
      linkedin_url: c.linkedinUrl || undefined,
      enrich_fields: fields,
      custom: { cuid: c.cuid, ctcuid: c.ctcuid },
    };
    Object.keys(row).forEach((k) => row[k] === undefined && delete row[k]);
    return row;
  });
  const r = await fetch(FE_BASE + "/contact/enrich/bulk", {
    method: "POST", headers: feHeaders(),
    body: JSON.stringify({ name: (name || "Raydar enrich").slice(0, 80), data }),
    signal: AbortSignal.timeout(25000),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body.enrichment_id) {
    const e = new Error(body.message || body.error || `FullEnrich start failed (${r.status})`);
    e.status = r.status; throw e;
  }
  return { enrichmentId: body.enrichment_id, submitted: data.length };
}

const GOOD = new Set(["DELIVERABLE", "HIGH_PROBABILITY"]);

export async function getEnrichment(enrichmentId) {
  // FullEnrich's GET is slow (~20s+ even for a small FINISHED job), so give it room.
  const r = await fetch(FE_BASE + "/contact/enrich/bulk/" + encodeURIComponent(enrichmentId), {
    headers: feHeaders(), signal: AbortSignal.timeout(55000),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(body.message || `FullEnrich fetch failed (${r.status})`); e.status = r.status; throw e; }

  const results = (body.data || []).map((row) => {
    const ci = row.contact_info || {};
    const work = ci.most_probable_work_email || (ci.work_emails || [])[0] || null;
    const personal = ci.most_probable_personal_email || (ci.personal_emails || [])[0] || null;
    const phone = ci.most_probable_phone || (ci.phones || [])[0] || null;
    // default email pick: prefer a "good" PERSONAL email, else a "good" work email
    let picked = null;
    if (personal && GOOD.has(personal.status)) picked = { email: personal.email, kind: "personal", status: personal.status };
    else if (work && GOOD.has(work.status)) picked = { email: work.email, kind: "work", status: work.status };
    return {
      cuid: row.custom?.cuid || null,
      ctcuid: row.custom?.ctcuid || null,
      name: row.input?.first_name ? `${row.input.first_name} ${row.input.last_name || ""}`.trim() : (row.profile?.full_name || ""),
      work: work ? { email: work.email, status: work.status } : null,
      personal: personal ? { email: personal.email, status: personal.status } : null,
      phone: phone ? { number: phone.number, region: phone.region || null } : null,
      picked,
    };
  });
  return { status: body.status || "UNKNOWN", credits: body.cost?.credits ?? null, results };
}

// ---------- write-back ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// items: [{ cuid, ctcuid, email }]  → writes email onto the candidate (+ the sequence lead).
export async function applyEmails(items) {
  const out = [];
  const pool = 6;
  const queue = items.filter((i) => i && i.cuid && EMAIL_RE.test(String(i.email || "").trim()));
  let idx = 0;
  async function worker() {
    while (idx < queue.length) {
      const it = queue[idx++];
      const email = String(it.email).trim();
      const rec = { cuid: it.cuid, email, ok: false, sequenceUpdated: false };
      try {
        await trpcPost("candidateUser.updateCandidateUserEmailForUser", { candidate_user_id: it.cuid, email });
        rec.ok = true;
      } catch (e) { rec.error = String(e.message || e).slice(0, 160); }
      if (it.ctcuid) {
        try {
          await trpcPost("campaigns.updateSequenceCandidateEmail", { campaign_to_candidate_user_id: it.ctcuid, email });
          rec.sequenceUpdated = true;
        } catch { /* best-effort; global email is the source of truth */ }
      }
      out.push(rec);
    }
  }
  await Promise.all(Array.from({ length: Math.min(pool, queue.length) }, worker));
  const badInputs = items.length - queue.length;
  return { applied: out, appliedCount: out.filter((r) => r.ok).length, skippedInvalid: badInputs };
}

// Re-read the sequence and report which of the applied candidates now carry an email
// on their lead — verified truth, not an assumption.
export async function verifyApplied(sequenceId, cuids) {
  try {
    const camp = await trpcGet("campaigns.getCampaign", { campaign_id: sequenceId });
    const leads = Array.isArray(camp?.campaign_to_candidate_users) ? camp.campaign_to_candidate_users : [];
    const set = new Set(cuids);
    const withEmail = leads.filter((l) => set.has(l.candidate_user_id) && (l.candidate_email || "").trim());
    return { verifiedOnLead: withEmail.length };
  } catch { return { verifiedOnLead: null }; }
}
