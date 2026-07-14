// ─────────────────────────────────────────────────────────────────────────────
// contactout.mjs — ContactOut client for the Enrich waterfall (stage 1, cheap).
//
// ContactOut is tried FIRST for every emailless lead that has a usable LinkedIn
// URL; whoever it can't find falls through to FullEnrich (stage 2, ~3x pricier
// per personal email). Pure lookups — this module never writes to Paraform.
//
// Doc-verified 2026-07-14 (api.contactout.com single-page docs) + live-probed:
//   • auth        → header literally named `token: <key>`  (NOT Authorization: Bearer)
//   • batch       → POST /v2/people/linkedin/batch {profiles≤1000, email_type, include_phone}
//                   → { status:"QUEUED", job_id } ; charges 1 email credit ONLY per
//                   profile where an email is FOUND (misses are free)
//   • poll        → GET /v2/people/linkedin/batch/{job_id}
//                   ⚠ POLLING envelope ≠ webhook shape: { data: { uuid, status,
//                   result: { "<url>": { emails, personal_emails, work_emails, phones } } } }
//                   (the {job_id, profiles} shape is webhook-only — expecting it here
//                   silently finds nothing)
//   • credits     → GET /v1/stats — PREPAID accounts (this one, verified live) omit
//                   `remaining`/`over_quota` and `quota` IS the remaining balance;
//                   postpaid accounts have count/quota/remaining. Branch on shape.
//   • URL rules   → only linkedin.com/in/ or /pub/ profile URLs; Sales-Navigator /
//                   Recruiter URLs are rejected — those leads skip straight to stage 2
//   • exhaustion  → HTTP 403 ("out of credits"), not 429
// ─────────────────────────────────────────────────────────────────────────────

const CO_KEY = process.env.CONTACTOUT_API_KEY || process.env.CONTACT_OUT_API || process.env.CONTACTOUT_API || "";
const CO_BASE = "https://api.contactout.com";
export const CO_BATCH_MAX = 1000;

export function contactoutConfigured() { return !!CO_KEY; }

const coHeaders = () => ({ token: CO_KEY, accept: "application/json", "content-type": "application/json" });

// Only regular profile URLs work on the contact-info endpoints.
export function usableLinkedinUrl(url) {
  const u = String(url || "").trim();
  return /^https?:\/\//i.test(u) && /linkedin\.com\/(in|pub)\//i.test(u) ? u : null;
}

// Page checkbox keys → ContactOut email_type ("none" = zero email credits, e.g. phone-only runs).
export function toCoEmailType(want) {
  const w = Array.isArray(want) && want.length ? want : ["personal"];
  const p = w.includes("personal"), k = w.includes("work");
  if (p && k) return "personal,work";
  if (k) return "work";
  if (p) return "personal";
  return "none";
}

async function coFetch(path, init = {}) {
  const r = await fetch(CO_BASE + path, { ...init, headers: coHeaders(), signal: AbortSignal.timeout(25000) });
  const body = await r.json().catch(() => ({}));
  if (r.status === 403) {
    const e = new Error("ContactOut: out of credits (or endpoint not enabled for this key)");
    e.code = "CO_OUT_OF_CREDITS"; e.status = 403; throw e;
  }
  if (!r.ok) {
    const e = new Error(body.message || body.error || `ContactOut ${path} failed (${r.status})`);
    e.status = r.status; throw e;
  }
  return body;
}

export async function coStartBatch(profiles, { emailType = "personal", includePhone = false } = {}) {
  const batch = profiles.slice(0, CO_BATCH_MAX);
  const body = await coFetch("/v2/people/linkedin/batch", {
    method: "POST",
    body: JSON.stringify({ profiles: batch, email_type: emailType, include_phone: !!includePhone }),
  });
  if (!body.job_id) throw new Error("ContactOut batch returned no job_id");
  return { jobId: body.job_id, submitted: batch.length };
}

// Statuses that mean "still working" — anything else is terminal (unknown terminal
// names cost one extra poll at worst, never a hang).
const CO_PENDING = /^(QUEUED|PENDING|PROCESSING|IN_PROGRESS|RUNNING)$/i;
const CO_FAILED = /FAIL|ERROR|CANCEL/i;

export async function coGetBatch(jobId) {
  const body = await coFetch("/v2/people/linkedin/batch/" + encodeURIComponent(jobId));
  const d = body.data || {};
  const raw = d.result || d.profiles || {}; // poll shape, with webhook shape as a fallback
  const results = {};
  for (const [url, v] of Object.entries(raw)) {
    const o = (v && typeof v === "object" && !Array.isArray(v)) ? v : {};
    results[url] = {
      personalEmails: Array.isArray(o.personal_emails) ? o.personal_emails : [],
      workEmails: Array.isArray(o.work_emails) ? o.work_emails : [],
      phones: Array.isArray(o.phones) ? o.phones : [],
      emails: Array.isArray(o.emails) ? o.emails : (Array.isArray(v) ? v : []),
    };
  }
  const status = d.status || "UNKNOWN";
  const done = !CO_PENDING.test(status);
  // A dead job must NOT read as "completed, found nothing" — that's the silent-empty
  // trap. failed=true tells the page to say so and fall back for everyone.
  const failed = done && (CO_FAILED.test(status) || (status === "UNKNOWN" && !Object.keys(results).length));
  return { status, done, failed, results };
}

// Remaining credits. Prepaid shape (this account): no `remaining` key anywhere and
// `quota` fields ARE the live remaining balances. Postpaid: quota = monthly allowance.
export async function coCredits() {
  const body = await coFetch("/v1/stats");
  const u = body.usage || {};
  const prepaid = !("remaining" in u);
  const pick = (p) => {
    const used = u[p ? `${p}_count` : "count"] ?? null;
    const quota = u[p ? `${p}_quota` : "quota"] ?? null;
    const remaining = prepaid
      ? quota
      : (u[p ? `${p}_remaining` : "remaining"] ?? (quota != null && used != null ? quota - used : null));
    return { used, quota, remaining };
  };
  return { plan: prepaid ? "prepaid" : "postpaid", period: body.period || null, email: pick(""), phone: pick("phone"), search: pick("search") };
}
