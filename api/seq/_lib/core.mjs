// ─────────────────────────────────────────────────────────────────────────────
// core.js — engine for the Sequences launcher backend (isolated raydar-sequences).
// Talks to Paraform's tRPC API using the service session cookie (env, never logged).
// All Paraform write verbs here were verified live 2026-06-28 (see memory
// project_sequences_launcher). NOTHING here touches the frozen screener contract.
// ─────────────────────────────────────────────────────────────────────────────

import { timingSafeEqual } from "node:crypto";
import { sessionConfig, sessionFromRequest, verifyGoogleCredential } from "../../auth/_lib/session.mjs";
import {
  AGENT_SCHEDULING_URL,
  HUMAN_SCHEDULING_URL,
  rewriteLegacySchedulingLinks,
} from "./scheduling-links.mjs";

export const BASE = "https://www.paraform.com/api";
const COOKIE = process.env.PARAFORM_COOKIE || "";          // browser session cookie value

export const CONFIG = {
  TEMPLATE_ID: process.env.TEMPLATE_ID || "ms87yhip8wozzyrkpq6sx51b", // 1st-Round template (disabled, has *INSERT ROLE*)
  TEMPLATE_PREFIX: "No Scheduled Call - Raydar - 1st Round Interview",
  TOKEN: "*INSERT ROLE*",
  MATCH_PROJECT_ID: process.env.MATCH_PROJECT_ID || "cmqvf861b00040aksj38cyiwp", // "LinkedIn Job Applicants"
  RECRUITER_ID: process.env.RECRUITER_ID || "clskvclu80066l60fhutn6kks",
  AGENCY_ID: process.env.AGENCY_ID || "cltyq2743004fl20fnop2ep02",
  SCHEDULER: {
    agent: AGENT_SCHEDULING_URL,
    human: HUMAN_SCHEDULING_URL,
  },
};

const ALLOW_ORIGINS = [
  "https://monitor.raydar.xyz",
  "https://raydar-agent-dashboard.vercel.app",
  "http://localhost:3000",
];

/**
 * Cron authentication. Vercel attaches `Authorization: Bearer $CRON_SECRET` to
 * scheduled invocations whenever CRON_SECRET exists on the project — verified in
 * this org: webview's /api/monitor and lifecycle's /api/cron are both
 * Bearer-ONLY and both demonstrably run on schedule.
 *
 * The `x-vercel-cron` header is NOT a credential. Vercel does not strip it from
 * inbound traffic (proven with curl), so accepting it let anyone trigger
 * endpoints that pause leads, disable sequences and enrol candidates.
 *
 * Fails CLOSED — and LOUDLY. If something arrives carrying the cron header but
 * no valid bearer, that is either an intruder or our own assumption being wrong,
 * and both need to be seen within the hour rather than discovered as a silently
 * dead cron nine days later.
 */
export function cronAuth(req) {
  const secret = process.env.CRON_SECRET || "";
  const provided = req.headers?.["authorization"] || "";
  const headerPresent = Boolean(req.headers?.["x-vercel-cron"]);
  if (!secret) return { ok: false, reason: "no_cron_secret", headerPresent };
  const a = Buffer.from(provided);
  const b = Buffer.from(`Bearer ${secret}`);
  const ok = a.length === b.length && timingSafeEqual(a, b);
  return { ok, reason: ok ? "bearer" : headerPresent ? "header_without_bearer" : "unauthenticated", headerPresent };
}

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
  return sessionConfig();
}

// Accept the durable, host-wide trusted-browser cookie first. Bearer ID tokens stay
// supported as a rollout fallback and are still verified server-side with Google.
export async function requireAuth(req, res) {
  const config = authConfig();
  if (!config.authRequired) return true; // auth not configured yet -> open (warn in logs)
  const session = sessionFromRequest(req);
  if (session) {
    req.authedEmail = session.email;
    return true;
  }
  const hdr = req.headers["authorization"] || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
  if (!token) { res.status(401).json({ ok: false, error: "auth_required" }); return false; }
  try {
    const identity = await verifyGoogleCredential(token);
    req.authedEmail = identity.email;
    return true;
  } catch (e) {
    if (e?.code === "forbidden") {
      res.status(403).json({ ok: false, error: "forbidden", detail: "must sign in with a " + config.allowedDomains.join("/") + " Google account" });
      return false;
    }
    res.status(401).json({ ok: false, error: "auth_check_failed" }); return false;
  }
}

export function hasCookie() { return !!COOKIE; }

// Paraform migrated from NextAuth to WorkOS (2026-07): iron-sealed WorkOS session
// values start with "Fe26.2" and ride the `wos-session` cookie; legacy NextAuth
// JWEs ("eyJ...") ride `__Secure-next-auth.session-token`. Auto-pick the name from
// the value so a cookie refresh stays a value-only swap; PARAFORM_SESSION_COOKIE_NAME
// overrides (allowlisted).
const PARAFORM_COOKIE_NAMES = new Set(["wos-session", "__Secure-next-auth.session-token"]);
export function paraformCookieName(value) {
  const override = process.env.PARAFORM_SESSION_COOKIE_NAME;
  if (override) {
    if (!PARAFORM_COOKIE_NAMES.has(override.trim())) throw new Error("PARAFORM_SESSION_COOKIE_NAME_INVALID");
    return override.trim();
  }
  return String(value || "").startsWith("Fe26.2") ? "wos-session" : "__Secure-next-auth.session-token";
}

export const headers = () => ({
  accept: "application/json",
  "content-type": "application/json",
  cookie: `${paraformCookieName(COOKIE)}=${COOKIE}`,
});
const env = (json) => ({ json, meta: { values: {}, v: 1 } });
const envWithMeta = (json, values = {}) => ({ json, meta: { values, v: 1 } });

// ─── Throttle vs expiry: decided HERE, not by each caller ────────────────────
// Paraform answers 401 to a burst and to role-forbidden procedures as well as
// to a dead session, so a 401 is a QUESTION, not a verdict. This used to be
// opt-in via withThrottleRetry, and the paths that never opted in are exactly
// the ones that kept declaring false expiries. On 2026-08-04 a false expiry
// stalled the membership snapshot, which stalled the booking-stop sweep, which
// aged the Scheduler's sequenceStop gate past its 60-minute ceiling and closed
// Agent Call admission — twice in one day, on a session that answered three
// clean serial 200s each time.
//
// So every trpc call now rides the ladder itself and only reports AUTH_EXPIRED
// after a SERIAL probe confirms it. Callers cannot forget, because there is
// nothing left to remember.
const throttled = () =>
  Object.assign(new Error("PARAFORM_THROTTLED"), { code: "PARAFORM_THROTTLED" });
const authExpired = () =>
  Object.assign(new Error("AUTH_EXPIRED"), { code: "AUTH_EXPIRED" });

async function classifyThrottle(fn, { delays = authRetryDelays() } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (e) {
      if (e?.code !== "PARAFORM_THROTTLED") throw e;
      if (attempt < delays.length) {
        // Jitter so a fleet of workers does not retry in lockstep.
        await sleep(delays[attempt] + Math.floor(Math.random() * 400));
        continue;
      }
      throw (await isSessionActuallyExpired()) ? authExpired() : e;
    }
  }
}

export async function trpcGet(proc, json, tries = 3) {
  return classifyThrottle(() => trpcGetRaw(proc, json, tries));
}

async function trpcGetRaw(proc, json, tries = 3) {
  const url = `${BASE}/trpc/${proc}?input=` + encodeURIComponent(JSON.stringify(env(json)));
  for (let a = 0; a < tries; a++) {
    try {
      const r = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(20000) });
      if (r.status === 401) throw throttled();
      // A 5xx/429 body is usually HTML, so without this the failure surfaced as
      // an opaque JSON parse error that nothing could classify as retryable.
      if (r.status === 429 || r.status >= 500) throw transportStatusError(r.status);
      const b = await r.json();
      if (b?.error) throw new Error(b.error.json?.message || "trpc error");
      return b?.result?.data?.json;
    } catch (e) { if (e.code === "PARAFORM_THROTTLED" || a === tries - 1) throw e; await sleep(500 * (a + 1)); }
  }
}
export async function trpcPost(proc, json, tries = 3) {
  return classifyThrottle(() => trpcPostRaw(proc, json, tries));
}

async function trpcPostRaw(proc, json, tries = 3) {
  for (let a = 0; a < tries; a++) {
    try {
      const r = await fetch(`${BASE}/trpc/${proc}`, { method: "POST", headers: headers(), body: JSON.stringify(env(json)), signal: AbortSignal.timeout(20000) });
      if (r.status === 401) throw throttled();
      if (r.status === 429 || r.status >= 500) throw transportStatusError(r.status);
      const b = await r.json();
      if (b?.error) throw new Error(b.error.json?.message || "trpc error");
      return b?.result?.data?.json;
    } catch (e) { if (e.code === "PARAFORM_THROTTLED" || a === tries - 1) throw e; await sleep(500 * (a + 1)); }
  }
}
// A few Paraform mutations use SuperJSON-only input types. Keep the ordinary
// adapter deliberately simple, and opt into metadata only for those pinned
// contracts (currently campaign start_date, which must deserialize as Date).
export async function trpcPostWithMeta(proc, json, values = {}, tries = 3) {
  return classifyThrottle(() => trpcPostWithMetaRaw(proc, json, values, tries));
}

async function trpcPostWithMetaRaw(proc, json, values = {}, tries = 3) {
  for (let a = 0; a < tries; a++) {
    try {
      const r = await fetch(`${BASE}/trpc/${proc}`, { method: "POST", headers: headers(), body: JSON.stringify(envWithMeta(json, values)), signal: AbortSignal.timeout(20000) });
      if (r.status === 401) throw throttled();
      if (r.status === 429 || r.status >= 500) throw transportStatusError(r.status);
      const b = await r.json();
      if (b?.error) throw new Error(b.error.json?.message || "trpc error");
      return b?.result?.data?.json;
    } catch (e) { if (e.code === "PARAFORM_THROTTLED" || a === tries - 1) throw e; await sleep(500 * (a + 1)); }
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
export async function crmProjectMembers(
  projectId,
  {
    fetchImpl = fetch,
    pageSize = 250,
    maxRows = 250_000,
  } = {},
) {
  if (!projectId) throw new Error("PROJECT_ID_REQUIRED");
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
    throw new Error("CRM_PAGE_SIZE_INVALID");
  }
  if (!Number.isInteger(maxRows) || maxRows < 1) {
    throw new Error("CRM_MAX_ROWS_INVALID");
  }
  const items = [];
  const seenIds = new Set();
  const seenCursors = new Set();
  let cursor = 0;
  while (true) {
    const cursorKey = String(cursor);
    if (seenCursors.has(cursorKey)) throw new Error("CRM_CURSOR_REPEATED");
    seenCursors.add(cursorKey);
    const input = {
      cursor,
      limit: pageSize,
      filters: {
        recruiters: [CONFIG.RECRUITER_ID],
        agency_id: CONFIG.AGENCY_ID,
        candidate_projects: [projectId],
        sort: { field: "added_at", order: "desc" },
      },
      project_id: null,
      role_specific_id: null,
    };
    // project_id/role_specific_id null require meta markers:
    const url = `${BASE}/trpc/candidateUser.getCRMExternalCandidates?input=` +
      encodeURIComponent(JSON.stringify({
        json: input,
        meta: {
          values: {
            project_id: ["undefined"],
            role_specific_id: ["undefined"],
          },
          v: 1,
        },
      }));
    const response = await fetchImpl(url, {
      headers: headers(),
      signal: AbortSignal.timeout(20000),
    });
    if (response.status === 401) {
      const error = new Error("AUTH_EXPIRED");
      error.code = "AUTH_EXPIRED";
      throw error;
    }
    if (!response.ok) throw new Error(`CRM_READ_FAILED_${response.status}`);
    const body = (await response.json())?.result?.data?.json || {};
    const page = Array.isArray(body.items) ? body.items : [];
    for (const item of page) {
      const id = String(item?.id || "").trim();
      if (id && seenIds.has(id)) continue;
      if (id) seenIds.add(id);
      items.push(item);
      if (items.length > maxRows) throw new Error("CRM_MAX_ROWS_EXCEEDED");
    }
    const nextCursor = body.next_cursor ?? null;
    if (!page.length || nextCursor == null) break;
    if (String(nextCursor) === cursorKey) throw new Error("CRM_CURSOR_REPEATED");
    cursor = nextCursor;
  }
  return items;
}

export async function projectEmailIndex(options = {}) {
  const items = await crmProjectMembers(CONFIG.MATCH_PROJECT_ID, options);
  const idx = new Map();
  for (const it of items) for (const e of (it.emails || [])) {
    const em = (typeof e === "string" ? e : e?.email || "").toLowerCase().trim();
    if (!em) continue;
    const existing = idx.get(em);
    if (existing && String(existing.id) !== String(it.id)) {
      throw new Error("CRM_EMAIL_OWNER_CONFLICT");
    }
    idx.set(em, { id: it.id, name: it.name });
  }
  return idx;
}

// ---------- delayed enrollment (store = Paraform projects, no extra infra) ----------
// A scheduled cohort is a CRM project named "⏳SeqDelay|YYYY-MM-DD|sendAs|TPL|<Role>"
// (templated) or "⏳SeqDelay|YYYY-MM-DD|sendAs|SEQ|<sequenceId>|<label>". Candidates
// are created + filed at upload time; the daily release cron enrolls due projects
// (running the booked/in-sequence checks THEN — the whole point of the delay) and
// deletes the project. State is visible/editable in Paraform's own Projects UI.
export const DELAY_PREFIX = "⏳SeqDelay|";
export function delayProjectName({ dueDate, sendAs, kind, key, label }) {
  // key = role title (TPL) or sequence id (SEQ); label only used for SEQ display
  const parts = [DELAY_PREFIX.slice(0, -1), dueDate, sendAs, kind, key];
  if (kind === "SEQ" && label) parts.push(label.slice(0, 60));
  return parts.join("|");
}
export function parseDelayProject(p) {
  if (!p?.name?.startsWith(DELAY_PREFIX)) return null;
  const seg = p.name.split("|");
  if (seg.length < 5) return null;
  const [, dueDate, sendAs, kind] = seg;
  return { projectId: p.id, dueDate, sendAs, kind, key: kind === "TPL" ? seg.slice(4).join("|") : seg[4], label: kind === "SEQ" ? (seg[5] || seg[4]) : seg.slice(4).join("|") };
}
export async function listDelayProjects() {
  const all = (await trpcGet("candidateProjects.getProjectsByUserId", {})) || [];
  return all.map(parseDelayProject).filter(Boolean);
}
// Members of a project: [{id, name, email}] (first known email, for lead backfill).
export async function projectMembers(projectId, options = {}) {
  const items = await crmProjectMembers(projectId, options);
  return items.map((it) => {
    const em = (it.emails || []).map((e) => (typeof e === "string" ? e : e?.email || "")).find(Boolean) || "";
    return { id: it.id, name: it.name, email: em.toLowerCase().trim() };
  });
}
export async function createDelayProject(nameArgs, candidateUserIds) {
  const proj = await trpcPost("candidateProjects.createProject", { name: delayProjectName(nameArgs) });
  if (!proj?.id) throw new Error("createProject returned no id");
  if (candidateUserIds.length) await trpcPost("candidateProjects.addCandidateUsersToProject", { project_id: proj.id, candidate_user_ids: candidateUserIds });
  return proj.id;
}
export async function deleteDelayProject(projectId) {
  try { await trpcPost("candidateProjects.deleteCandidateProject", { project_id: projectId }); } catch { /* non-fatal; will retry next run */ }
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
  steps = steps.map((s) => {
    const swap = (t) => rewriteLegacySchedulingLinks(
      (t || "").split(CONFIG.TOKEN).join(title),
    ).value;
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
// Membership read. ⚠ Paraform API change (seen 2026-07-12): campaigns.getCampaign no
// longer embeds campaign_to_candidate_users/leads — the membership verb is now
// campaigns.getCampaignLeads({campaign_id, cursor}), paginated 50/page with a NUMERIC
// OFFSET cursor + totalCount. Always paginate to the end: a single-page read here is
// the same silent-dedup-miss class as the duplicate-bot Code Red.
// ─── Paraform throttling ─────────────────────────────────────────────────────
// Paraform answers HTTP 401 to a BURST, not only to a dead session. Measured
// 2026-07-26: 40 concurrent getCandidateProfileInfo reads on a healthy session
// returned 27x200 / 13x401, while the same reads issued serially were 100%
// clean. Because trpcGet maps every 401 to AUTH_EXPIRED and throws without
// retrying, a throttle is indistinguishable from an expiry — which silently
// voided 780 of 945 profile reads in one run, every one of them scoring as
// "not booked". Opt in with withThrottleRetry where a miss actually matters.
// Read per call rather than at import, so the ladder can be retuned from the
// environment without a redeploy — and so tests can run it sub-second.
const AUTH_RETRY_DELAYS_MS = [600, 1800, 4500, 9000, 15000];
const authRetryDelays = () => {
  const parsed = String(process.env.PARAFORM_THROTTLE_DELAYS_MS || "")
    .split(",").map((n) => Number(n.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0);
  return parsed.length ? parsed : AUTH_RETRY_DELAYS_MS;
};
const probeDelayMs = () => Number(process.env.PARAFORM_PROBE_DELAY_MS || 1500);

// ─── Transport faults ────────────────────────────────────────────────────────
// The throttle ladder above only ever knew about the 401 case. Nothing retried
// a TRANSPORT failure, and every Paraform call on the sweep path is issued with
// `tries = 1` precisely so the inner loop stays out of the way of that ladder.
// The result: a booking sweep is ~750 sequential round trips, each with a hard
// 20s `AbortSignal.timeout`, and ONE slow response anywhere in the chain
// aborted the entire hourly pass with no partial progress and no resumption.
// Measured live 2026-07-30: the 17:37Z pass died 117.6s in — nowhere near the
// 300s function budget — on a DOMException TimeoutError, and no pass had
// completed for at least six hours.
//
// The ladder here is deliberately MUCH tighter than the auth one. A stuck
// endpoint already costs 20s per attempt, so a long ladder would trade one lost
// pass for a different lost pass; three quick retries recover the realistic
// case (a single slow response) inside the budget.
const TRANSPORT_RETRY_DELAYS_MS = [500, 1500, 4000];

const TRANSIENT_TRANSPORT_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/** Transient = the request never got a verdict, so repeating it is safe and is
 *  the only way to learn anything. An application error (`trpc error`, a
 *  contract violation) is NOT transient: retrying it just burns the budget. */
export function isTransientTransportError(e, depth = 0) {
  if (!e || depth > 3) return false;
  // AbortSignal.timeout() rejects with a DOMException named TimeoutError whose
  // legacy numeric `code` is 23 — the string that used to reach health.
  if (e.name === "TimeoutError" || e.name === "AbortError") return true;
  if (e.retryableTransport === true) return true;
  if (typeof e.code === "string" && TRANSIENT_TRANSPORT_CODES.has(e.code)) return true;
  // fetch() wraps a network fault in a TypeError and hides the reason in .cause.
  if (isTransientTransportError(e.cause, depth + 1)) return true;
  return false;
}

/** Marks a response status the caller should treat as "no verdict yet". */
function transportStatusError(status) {
  const e = new Error(`PARAFORM_HTTP_${status}`);
  e.code = `PARAFORM_HTTP_${status}`;
  e.status = status;
  e.retryableTransport = true;
  return e;
}

export async function withThrottleRetry(fn, {
  onThrottle = null,
  onTransient = null,
  delays = AUTH_RETRY_DELAYS_MS,
  transportDelays = TRANSPORT_RETRY_DELAYS_MS,
  // Epoch ms after which a caller would rather fail than keep waiting. Retrying
  // is only free if someone is still there to receive the answer: a retry that
  // finishes after the caller's own deadline just gets the process killed
  // mid-write, which is how a dead sweep learned to look like a running one.
  deadline = null,
} = {}) {
  let throttleAttempt = 0;
  let transportAttempt = 0;
  const budgetSpent = (delay) => deadline != null && Date.now() + delay >= deadline;
  for (;;) {
    try { return await fn(); }
    catch (e) {
      // Two independent budgets. A pass that is being throttled AND crossing a
      // flaky link must not have one failure mode eat the other's retries.
      // AUTH_EXPIRED now arrives pre-classified: trpc* already rode the ladder
      // and serially confirmed the session is dead. Retrying it here would only
      // multiply the delays, so this is a verdict and it propagates.
      if (e?.code === "AUTH_EXPIRED") throw e;
      if (isTransientTransportError(e)) {
        const delay = transportDelays[transportAttempt] + Math.floor(Math.random() * 250);
        if (transportAttempt >= transportDelays.length || budgetSpent(delay)) throw e;
        transportAttempt++;
        if (onTransient) onTransient();
        await sleep(delay);
        continue;
      }
      throw e;
    }
  }
}

/** A cheap read retried with growing backoff. One probe is not enough: it races
 *  the very burst it is trying to rule out. */
export async function isSessionActuallyExpired({ probes = 3 } = {}) {
  // Deliberately trpcGetRaw: the classifier calls THIS to decide, so going back
  // through it would recurse forever. Raw also means one probe, one verdict.
  for (let i = 0; i < probes; i++) {
    try { await trpcGetRaw("campaigns.getListOfCampaignsOptimized", {}, 1); return false; }
    catch (e) {
      if (e?.code !== "PARAFORM_THROTTLED") return false; // reached it, so auth is fine
      await sleep(probeDelayMs() * (i + 1) + Math.floor(Math.random() * 600));
    }
  }
  return true;
}

// ─── Membership reads ────────────────────────────────────────────────────────
// getCampaignLeads orders on a NON-UNIQUE key with no tiebreaker. These
// sequences are bulk-enrolled, so hundreds of rows share one `created_at` —
// e.g. a 240-lead sequence whose rows have just three distinct timestamps
// (blocks of 54/93/93). Postgres LIMIT/OFFSET across a tie block returns an
// arbitrary order that changes with the (offset, limit) pair, so some rows
// repeat across page boundaries and others NEVER surface — while the response
// still reports the right totalCount, so a row-count check sails through.
//
// Crucially the order is DETERMINISTIC per (cursor, limit): the same request
// twice is byte-identical. So retrying is useless, and so is varying only the
// cursor stride — an earlier version of this reader did exactly that and could
// never escape, because every call still used the server default limit of 50.
// The lever is the PAGE SIZE. Measured on the 240-lead case:
//   limit 50 -> 199 distinct   limit 100 -> 233   limit 89/83/71 -> 240
// so we walk with coprime page sizes and union until the distinct count matches
// totalCount. `limit` is server-capped at 100 (zod max) — 101 is a hard 400.
//
// Completeness is judged on DISTINCT ids with ZERO tolerance. A percentage
// tolerance is actively dangerous here: 1% would silently swallow 11 missing
// leads on the 1,124-lead sequence. 19 of 45 sequences have a tie block larger
// than the default page size, so this is not an edge case.
const LEAD_PAGE_SIZES = [100, 89, 83, 71];

/**
 * Authoritative membership oracle. The HEAVY `campaigns.getListOfCampaigns`
 * embeds `campaign_to_candidate_users` in full with NO paging, so it is immune
 * to the tie-block problem — it is the only read that can say what the true
 * membership is. It costs ~13MB / ~7s for all campaigns, so it is fetched at
 * most once per process and only when a paged walk actually came up short.
 * (Note `getListOfCampaignsOptimized` carries no `leads_count` at all.)
 */
let _oracle = null;
let _oracleAt = 0;
const ORACLE_TTL_MS = 10 * 60 * 1000;

export async function campaignMembershipOracle({ force = false } = {}) {
  if (!force && _oracle && Date.now() - _oracleAt < ORACLE_TTL_MS) return _oracle;
  const all = await withThrottleRetry(() => trpcGet("campaigns.getListOfCampaigns", {}, 1));
  const map = new Map();
  for (const c of all || []) {
    map.set(c.id, (c.campaign_to_candidate_users || []).map((m) => ({
      ccu_id: m.id,
      cu_id: m.candidate_user_id,
      candidate_email: m.candidate_email || null,
    })));
  }
  _oracle = map;
  _oracleAt = Date.now();
  return map;
}

export async function completeCampaignLeads(campaignId, { pageSizes = LEAD_PAGE_SIZES, backfill = true, deadline = null } = {}) {
  const byCcu = new Map();
  let totalCount = null;
  let apiCalls = 0;
  let pageSizeUsed = null;

  for (const limit of pageSizes) {
    pageSizeUsed = limit;
    let cursor = 0;
    for (let i = 0; i < 500; i++) {
      const page = await withThrottleRetry(() =>
        trpcGet("campaigns.getCampaignLeads", { campaign_id: campaignId, cursor, limit }, 1), { deadline });
      apiCalls++;
      const leads = page?.leads || [];
      if (totalCount === null) totalCount = Math.min(page?.totalCount ?? leads.length, 10000);
      for (const l of leads) if (l?.ccu_id && !byCcu.has(l.ccu_id)) byCcu.set(l.ccu_id, l);
      if (!leads.length || byCcu.size >= totalCount) break;
      cursor += limit;
      if (cursor >= totalCount) break;
    }
    if (totalCount !== null && byCcu.size >= totalCount) break;
  }

  // Coprime page sizes recover most tie-block casualties but not always all of
  // them. Anything still missing is resolved EXACTLY: ask the unpaginated oracle
  // who should be here, then hydrate each missing row with a `search` read,
  // which bypasses paging entirely. No lead is left to chance.
  let backfilled = 0;
  if (backfill && totalCount !== null && byCcu.size < totalCount) {
    try {
      const expected = (await campaignMembershipOracle()).get(campaignId) || [];
      for (const e of expected) {
        if (byCcu.has(e.ccu_id)) continue;
        const row = await campaignLeadBySearch(campaignId, e.candidate_email || e.cu_id);
        apiCalls++;
        if (row?.ccu_id && !byCcu.has(row.ccu_id)) { byCcu.set(row.ccu_id, row); backfilled++; }
      }
    } catch { /* oracle unavailable -> fall through and report the shortfall */ }
  }

  const leads = [...byCcu.values()];
  const shortfall = Math.max(0, (totalCount ?? leads.length) - leads.length);
  return {
    leads,
    totalCount: totalCount ?? leads.length,
    unique: leads.length,
    shortfall,
    complete: shortfall === 0, // zero tolerance: totalCount is trustworthy
    pageSizeUsed,
    backfilled,
    apiCalls,
  };
}

export async function campaignLeads(campaignId, { strict = false } = {}) {
  const read = await completeCampaignLeads(campaignId);
  if (strict && !read.complete) {
    throw new Error(`incomplete campaign membership read: ${read.unique}/${read.totalCount} distinct`);
  }
  return read.leads; // [{cu_id, ccu_id, to_use_email, is_paused, ...}]
}

/**
 * Exact single-lead read. `getCampaignLeads` accepts a `search` term and answers
 * with just the matching row(s) — crucially, WITHOUT going through the broken
 * offset pagination above. That makes it the right tool for verifying one write,
 * where walking the whole sequence is both wasteful and unreliable: a paging
 * shortfall made 31 successful pauses report "readback_unavailable" and left one
 * lead looking like it had vanished when it was simply never returned.
 */
export async function campaignLeadBySearch(campaignId, term, {
  expectedCcuId = null,
  reader = trpcGet,
} = {}) {
  if (!term) return null;
  const r = await withThrottleRetry(() =>
    reader("campaigns.getCampaignLeads", {
      campaign_id: campaignId,
      search: String(term),
    }, 1));
  const leads = Array.isArray(r?.leads) ? r.leads : [];
  if (expectedCcuId == null) return leads[0] || null;
  const target = String(expectedCcuId);
  return leads.find((lead) => String(lead?.ccu_id || "") === target) || null;
}


// After enrolling, map candidate_user_id -> campaign_to_candidate_user_id for a campaign.
export async function ccuIndex(campaignId, options) {
  const m = new Map();
  for (const L of await campaignLeads(campaignId, options)) m.set(L.cu_id, { ccuId: L.ccu_id, email: L.to_use_email || null });
  return m;
}

// Build the set of candidate_user_ids already enrolled in ANY of the recruiter's
// sequences. Used to skip anyone already in a sequence (the "don't re-message"
// rule) — this also makes re-running the same cohort a no-op (dedup/no double-email).
// One scan per enroll (paginated getCampaignLeads per sequence, bounded concurrency).
export async function enrolledElsewhereSet({ strict = false } = {}) {
  const seqs = (await trpcGet("campaigns.getListOfCampaignsOptimized", {})) || [];
  const set = new Set();
  let i = 0;
  const worker = async () => {
    while (i < seqs.length) {
      const s = seqs[i++];
      try {
        for (const L of await campaignLeads(s.id)) set.add(L.cu_id);
      } catch (error) {
        if (strict) throw error;
        // Best-effort callers retain the legacy behavior; safety-sensitive
        // sourcing callers pass strict:true and fail closed instead.
      }
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

function normalizedCandidateTags(value) {
  const tags = Array.isArray(value?.tags) ? value.tags : [];
  return tags.map((tag) => String(tag?.name ?? tag).trim().toLowerCase())
    .filter(Boolean);
}

export async function archiveImportSet(
  candidateUserIds,
  { fetchImpl = fetch } = {},
) {
  const archived = new Set();
  const ids = [...new Set(
    (candidateUserIds || [])
      .map((id) => String(id || "").trim())
      .filter(Boolean),
  )];
  let index = 0;
  const worker = async () => {
    while (index < ids.length) {
      const id = ids[index++];
      const response = await fetchImpl(
        `${BASE}/candidates/profile/${encodeURIComponent(id)}/info`,
        {
          headers: headers(),
          signal: AbortSignal.timeout(20000),
        },
      );
      if (response.status === 401) {
        const error = new Error("AUTH_EXPIRED");
        error.code = "AUTH_EXPIRED";
        throw error;
      }
      if (!response.ok) {
        throw new Error(`CANDIDATE_PROFILE_READ_FAILED_${response.status}`);
      }
      const profile = await response.json();
      if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
        throw new Error("CANDIDATE_PROFILE_READ_MALFORMED");
      }
      if (normalizedCandidateTags(profile).includes("archive-import")) {
        archived.add(id);
      }
    }
  };
  await Promise.all(Array.from({
    length: Math.min(8, ids.length || 1),
  }, worker));
  return archived;
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
