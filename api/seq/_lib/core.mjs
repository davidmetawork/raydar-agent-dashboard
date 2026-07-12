// ─────────────────────────────────────────────────────────────────────────────
// core.js — engine for the Sequences launcher backend (isolated raydar-sequences).
// Talks to Paraform's tRPC API using the service session cookie (env, never logged).
// All Paraform write verbs here were verified live 2026-06-28 (see memory
// project_sequences_launcher). NOTHING here touches the frozen screener contract.
// ─────────────────────────────────────────────────────────────────────────────

export const BASE = "https://www.paraform.com/api";
const COOKIE = process.env.PARAFORM_COOKIE || "";          // value of __Secure-next-auth.session-token
// Google domain-restricted auth: enforced IFF GOOGLE_CLIENT_ID is set.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const ALLOWED_DOMAINS = (process.env.ALLOWED_DOMAINS || "raydar.xyz,raydargroup.com")
  .split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);

export const CONFIG = {
  TEMPLATE_ID: process.env.TEMPLATE_ID || "ms87yhip8wozzyrkpq6sx51b", // 1st-Round template (disabled, has *INSERT ROLE*)
  TEMPLATE_PREFIX: "No Scheduled Call - Raydar - 1st Round Interview",
  TOKEN: "*INSERT ROLE*",
  MATCH_PROJECT_ID: process.env.MATCH_PROJECT_ID || "cmqvf861b00040aksj38cyiwp", // "LinkedIn Job Applicants"
  RECRUITER_ID: process.env.RECRUITER_ID || "clskvclu80066l60fhutn6kks",
  AGENCY_ID: process.env.AGENCY_ID || "cltyq2743004fl20fnop2ep02",
  CALENDLY: {
    david: "https://calendly.com/raydar-xyz",
    noah: "https://calendly.com/noah-raydar/new-role-chat?back=1",
  },
};

const ALLOW_ORIGINS = [
  "https://monitor.raydar.xyz",
  "https://raydar-agent-dashboard.vercel.app",
  "http://localhost:3000",
];

export function cors(req, res) {
  const o = req.headers.origin;
  res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGINS.includes(o) ? o : ALLOW_ORIGINS[0]);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type,x-app-key");
  if (req.method === "OPTIONS") { res.status(204).end(); return true; }
  return false;
}

export function authConfig() {
  return { googleClientId: GOOGLE_CLIENT_ID, allowedDomains: ALLOWED_DOMAINS, authRequired: !!GOOGLE_CLIENT_ID };
}

// Google domain-restricted gate. Verifies the caller's Google ID token via Google's
// tokeninfo endpoint (no deps): audience must be our client id, hosted-domain (hd)
// must be an allowed Raydar domain, email verified, not expired. Enforced only when
// GOOGLE_CLIENT_ID is configured (lets the tool run pre-auth-setup, then locks down).
export async function requireAuth(req, res) {
  if (!GOOGLE_CLIENT_ID) return true; // auth not configured yet -> open (warn in logs)
  const hdr = req.headers["authorization"] || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
  if (!token) { res.status(401).json({ ok: false, error: "auth_required" }); return false; }
  try {
    const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(token), { signal: AbortSignal.timeout(8000) });
    const t = await r.json();
    const ok = r.ok && t.aud === GOOGLE_CLIENT_ID && t.email_verified === "true" &&
      Number(t.exp) * 1000 > Date.now() && ALLOWED_DOMAINS.includes(String(t.hd || t.email?.split("@")[1] || "").toLowerCase());
    if (!ok) { res.status(403).json({ ok: false, error: "forbidden", detail: "must sign in with a " + ALLOWED_DOMAINS.join("/") + " Google account" }); return false; }
    req.authedEmail = t.email;
    return true;
  } catch (e) {
    res.status(401).json({ ok: false, error: "auth_check_failed" }); return false;
  }
}

export function hasCookie() { return !!COOKIE; }

export const headers = () => ({
  accept: "application/json",
  "content-type": "application/json",
  cookie: `__Secure-next-auth.session-token=${COOKIE}`,
});
const env = (json) => ({ json, meta: { values: {}, v: 1 } });

export async function trpcGet(proc, json, tries = 3) {
  const url = `${BASE}/trpc/${proc}?input=` + encodeURIComponent(JSON.stringify(env(json)));
  for (let a = 0; a < tries; a++) {
    try {
      const r = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(20000) });
      if (r.status === 401) { const e = new Error("AUTH_EXPIRED"); e.code = "AUTH_EXPIRED"; throw e; }
      const b = await r.json();
      if (b?.error) throw new Error(b.error.json?.message || "trpc error");
      return b?.result?.data?.json;
    } catch (e) { if (e.code === "AUTH_EXPIRED" || a === tries - 1) throw e; await sleep(500 * (a + 1)); }
  }
}
export async function trpcPost(proc, json, tries = 3) {
  for (let a = 0; a < tries; a++) {
    try {
      const r = await fetch(`${BASE}/trpc/${proc}`, { method: "POST", headers: headers(), body: JSON.stringify(env(json)), signal: AbortSignal.timeout(20000) });
      if (r.status === 401) { const e = new Error("AUTH_EXPIRED"); e.code = "AUTH_EXPIRED"; throw e; }
      const b = await r.json();
      if (b?.error) throw new Error(b.error.json?.message || "trpc error");
      return b?.result?.data?.json;
    } catch (e) { if (e.code === "AUTH_EXPIRED" || a === tries - 1) throw e; await sleep(500 * (a + 1)); }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- health ----------
export async function paraformHealth() {
  if (!COOKIE) return { paraform: "no_cookie" };
  try {
    const seqs = await trpcGet("campaigns.getListOfCampaignsOptimized", {});
    return { paraform: "live", sequenceCount: Array.isArray(seqs) ? seqs.length : 0 };
  } catch (e) {
    return { paraform: e.code === "AUTH_EXPIRED" ? "expired" : "error", detail: String(e.message || e).slice(0, 120) };
  }
}

// ---------- sequences (dropdown) ----------
export async function listSequences() {
  const arr = (await trpcGet("campaigns.getListOfCampaignsOptimized", {})) || [];
  return arr.map((c) => ({ id: c.id, name: c.name, enabled: c.enabled, leads: c.leads_count ?? null }))
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
}

// ---------- CSV helpers ----------
// Active Project = "Company - Job Title (status)|Other Project ..." -> Job Title
export function parseTitle(activeProject) {
  if (!activeProject) return "";
  let s = String(activeProject).split("|")[0].trim();          // first project only
  s = s.replace(/\s*\([^)]*\)\s*$/, "").trim();                // drop trailing (status)
  const i = s.indexOf(" - ");                                   // split Company - Title
  let title = (i >= 0 ? s.slice(i + 3) : s).trim();
  title = title.replace(/\s+v\d+(?:\.\d+)*$/i, "").trim();      // drop internal version suffix (v1, v12, v2.0)
  return title;
}
export function isTemplateSequence(seq) {
  return seq && (seq.id === CONFIG.TEMPLATE_ID || seq.name === CONFIG.TEMPLATE_PREFIX);
}

// ---------- candidate matching (by email, within a CRM project) ----------
export async function projectEmailIndex() {
  const input = { cursor: 0, limit: 250, filters: { recruiters: [CONFIG.RECRUITER_ID], agency_id: CONFIG.AGENCY_ID, candidate_projects: [CONFIG.MATCH_PROJECT_ID], sort: { field: "added_at", order: "desc" } }, project_id: null, role_specific_id: null };
  // project_id/role_specific_id null require meta markers:
  const url = `${BASE}/trpc/candidateUser.getCRMExternalCandidates?input=` +
    encodeURIComponent(JSON.stringify({ json: input, meta: { values: { project_id: ["undefined"], role_specific_id: ["undefined"] }, v: 1 } }));
  const r = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(20000) });
  if (r.status === 401) { const e = new Error("AUTH_EXPIRED"); e.code = "AUTH_EXPIRED"; throw e; }
  const items = (await r.json())?.result?.data?.json?.items || [];
  const idx = new Map();
  for (const it of items) for (const e of (it.emails || [])) {
    const em = (typeof e === "string" ? e : e?.email || "").toLowerCase().trim();
    if (em) idx.set(em, { id: it.id, name: it.name });
  }
  return idx;
}

// ---------- templating: find-or-create the role-specific sequence ----------
export async function ensureRoleSequence(title, sendAs, seqCache) {
  const targetName = `${CONFIG.TEMPLATE_PREFIX} - ${title}`;
  const all = seqCache || (await trpcGet("campaigns.getListOfCampaignsOptimized", {})) || [];
  const existing = all.find((c) => c.name === targetName);
  if (existing) return { id: existing.id, name: targetName, created: false };

  const copy = await trpcPost("campaigns.copySequence", { sequence_id: CONFIG.TEMPLATE_ID });
  const newId = copy?.id;
  if (!newId) throw new Error("copySequence returned no id");

  const full = await trpcGet("campaigns.getCampaign", { campaign_id: newId });
  let steps = (full?.steps || []).map((s) => ({ ...s, attachments: Array.isArray(s.attachments) ? s.attachments : [] }));
  const calendly = CONFIG.CALENDLY[sendAs] || CONFIG.CALENDLY.david;
  steps = steps.map((s) => {
    const swap = (t) => (t || "")
      .split(CONFIG.TOKEN).join(title)
      .split(CONFIG.CALENDLY.david).join(calendly); // per-sender Calendly swap
    return { ...s, subject: swap(s.subject), body: swap(s.body) };
  });
  await trpcPost("campaigns.updateSequenceSteps", { campaign_id: newId, steps });
  try { await trpcPost("campaigns.updateSequence", { sequence_id: newId, name: targetName, enabled: true }); }
  catch { await trpcPost("campaigns.updateSequence", { sequence_id: newId, name: targetName }); }
  // ensure enabled (separate toggle as backstop)
  try { await trpcPost("campaigns.bulkSetSequencesEnabled", { sequence_ids: [newId], enabled: true }); } catch {}
  return { id: newId, name: targetName, created: true };
}

// ---------- create / upsert a candidate from their LinkedIn URL ----------
// candidates.createExternalCandidateFromManual takes ONLY linkedin_url and enriches
// from LinkedIn/CrustData. Idempotent by URL: re-runs return status:"existing" with the
// SAME candidate_user_id, so re-uploading a cohort never duplicates. Returns the id, or
// throws (e.g. "CrustData failed to enrich" for a bad/dead LinkedIn URL) — caller catches
// per-row so one bad URL doesn't sink the batch.
export async function createCandidate(linkedinUrl) {
  const r = await trpcPost("candidates.createExternalCandidateFromManual", { linkedin_url: linkedinUrl });
  return { id: r?.candidate_user_id || null, status: r?.status || "unknown" };
}

// Best-effort: file created candidates under the "LinkedIn Job Applicants" CRM project.
export async function addToProject(candidateUserIds, projectId = CONFIG.MATCH_PROJECT_ID) {
  if (!candidateUserIds.length) return { count: 0 };
  return (await trpcPost("candidateProjects.addCandidateUsersToProject", { project_id: projectId, candidate_user_ids: candidateUserIds })) || { count: 0 };
}

export async function enrollIntoCampaign(campaignId, candidateUserIds) {
  if (!candidateUserIds.length) return { enrolled: 0 };
  await trpcPost("campaigns.addToCampaigns", { campaign_ids: [campaignId], candidate_user_ids: candidateUserIds });
  return { enrolled: candidateUserIds.length };
}

// CrustData enrichment often can't find an email, leaving the lead un-sendable even
// though the CSV had one. Set it explicitly: candidate record first (so it's a valid
// source), then the per-lead send-to address. Both are best-effort/idempotent.
export async function setCandidateEmail(candidateUserId, email) {
  if (!email) return;
  try { await trpcPost("candidateUser.updateCandidateUserEmailForUser", { candidate_user_id: candidateUserId, email }); } catch { /* non-fatal */ }
}
export async function setLeadEmail(ccuId, email) {
  if (!ccuId || !email) return;
  try { await trpcPost("campaigns.updateSequenceCandidateEmail", { campaign_to_candidate_user_id: ccuId, candidate_email: email }); } catch { /* non-fatal */ }
}
// After enrolling, map candidate_user_id -> campaign_to_candidate_user_id for a campaign.
export async function ccuIndex(campaignId) {
  const c = await trpcGet("campaigns.getCampaign", { campaign_id: campaignId });
  const m = new Map();
  for (const cc of (c?.campaign_to_candidate_users || [])) m.set(cc.candidate_user_id, { ccuId: cc.id, email: cc.candidate_email });
  return m;
}

// Build the set of candidate_user_ids already enrolled in ANY of the recruiter's
// sequences. Used to skip anyone already in a sequence (the "don't re-message"
// rule) — this also makes re-running the same cohort a no-op (dedup/no double-email).
// One scan per enroll (getCampaign per sequence, bounded concurrency).
export async function enrolledElsewhereSet() {
  const seqs = (await trpcGet("campaigns.getListOfCampaignsOptimized", {})) || [];
  const set = new Set();
  let i = 0;
  const worker = async () => {
    while (i < seqs.length) {
      const s = seqs[i++];
      try {
        const c = await trpcGet("campaigns.getCampaign", { campaign_id: s.id });
        for (const cc of (c?.campaign_to_candidate_users || [])) set.add(cc.candidate_user_id);
      } catch { /* skip unreadable */ }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return set;
}

// ---------- "already booked a call" skip ----------
// Paraform relationship_status progresses CONTACTED -> REPLIED -> SCHEDULED_CALL ->
// SCREENED -> interview stages. Anyone at SCHEDULED_CALL or FURTHER has booked/done a
// call, so a "please schedule a call" nudge is wrong for them. (CONTACTED/REPLIED/NEW/
// null still need the nudge.) Configurable via BOOKED_STATUSES.
export const BOOKED_STATUSES = new Set(
  (process.env.BOOKED_STATUSES ||
    "SCHEDULED_CALL,SCREENED,INTERVIEWING,INTERVIEW,INTERVIEW_SCHEDULED,ONSITE,OFFER,OFFER_EXTENDED,HIRED,PLACED,ACCEPTED,CLIENT_SUBMITTED,SUBMITTED")
    .split(",").map((s) => s.trim()).filter(Boolean)
);
export async function relationshipStatus(candidateUserId) {
  try {
    const p = await trpcGet("candidateUser.getCandidateProfileInfo", { candidateUserId });
    return p?.candidate_user_relationship_status || null;
  } catch { return null; }
}
// Return the subset of candidate ids whose relationship_status means "already booked".
// Only pre-existing candidates can be booked, so callers pass just those (fast).
export async function bookedSet(candidateUserIds) {
  const booked = new Set();
  let i = 0;
  const worker = async () => {
    while (i < candidateUserIds.length) {
      const id = candidateUserIds[i++];
      const s = await relationshipStatus(id);
      if (s && BOOKED_STATUSES.has(s)) booked.add(id);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return booked;
}

// ---------- plan builder (shared by preview + enroll) ----------
// rows: [{firstName,lastName,email,linkedinUrl,activeProject}]
export async function buildPlan({ sequenceId, rows, sendAs }) {
  const seqs = (await trpcGet("campaigns.getListOfCampaignsOptimized", {})) || [];
  const seq = seqs.find((s) => s.id === sequenceId);
  if (!seq) throw new Error("sequence not found");
  const idx = await projectEmailIndex();

  // Annotate every row with its CRM match (if any) and parsed role title.
  const annotated = rows.map((row) => {
    const em = (row.email || "").toLowerCase().trim();
    const hit = em ? idx.get(em) : null;
    return { ...row, email: em, candidate_user_id: hit ? hit.id : null, title: parseTitle(row.activeProject) || "(no role)" };
  });
  const matched = annotated.filter((r) => r.candidate_user_id);
  const unmatched = annotated.filter((r) => !r.candidate_user_id);

  const templated = isTemplateSequence(seq);
  // Group ALL rows (matched + not-yet-in-CRM), not just the ones already in the CRM —
  // otherwise a cohort of brand-new applicants shows 0 role sequences.
  const groups = [];
  const mkGroup = (title, targetName, targetId, grows) => ({
    title, targetName, targetId,
    exists: targetId ? true : seqs.some((s) => s.name === targetName),
    rows: grows,                                            // all rows (carry email + linkedinUrl through)
    existingIds: grows.filter((r) => r.candidate_user_id).map((r) => r.candidate_user_id),
    toCreate: grows.filter((r) => !r.candidate_user_id),   // rows needing createExternalCandidateFromManual
    candidateCount: grows.length,
  });
  if (templated) {
    const byTitle = new Map();
    for (const r of annotated) {
      if (!byTitle.has(r.title)) byTitle.set(r.title, []);
      byTitle.get(r.title).push(r);
    }
    for (const [title, grows] of byTitle) {
      groups.push(mkGroup(title, `${CONFIG.TEMPLATE_PREFIX} - ${title}`, null, grows));
    }
  } else {
    groups.push(mkGroup(null, seq.name, seq.id, annotated));
  }

  return { seq, templated, sendAs: sendAs || "david", matchedCount: matched.length, unmatchedCount: unmatched.length, unmatched, groups, seqs };
}

export { sleep };
