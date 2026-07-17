// Shared Para AI adapter. Runtime is fully headless: Paraform is reached only
// through its internal tRPC surface and the existing service-session cookie.

import { randomUUID } from "node:crypto";
import { authConfig, cors, requireAuth } from "../../seq/_lib/core.mjs";

export { authConfig, cors, requireAuth };

const PARAFORM_BASE = "https://www.paraform.com/api";
const TRPC_TIMEOUT_MS = Number(process.env.PARAAI_TRPC_TIMEOUT_MS || 20_000);
const MAX_CRM_PAGES = Number(process.env.PARAAI_MAX_CRM_PAGES || 6);
const CRM_PAGE_SIZE = Number(process.env.PARAAI_CRM_PAGE_SIZE || 1000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const RECRUITER_ID = process.env.RECRUITER_ID || "clskvclu80066l60fhutn6kks";
export const AGENCY_ID = process.env.AGENCY_ID || "cltyq2743004fl20fnop2ep02";
export const SEQUENCE_NAMES = Object.freeze({
  one: "New Matches - Added to Para AI (one role)",
  multiple: "New Matches - Added to Para AI (multiple)",
  none: "No Matches - Added to Para AI",
});
export const INTERNAL_NAMES = new Set([
  "david phillips",
  "noah kingsdale",
  "kyra wyman",
  "alzen flores",
  "vanessa vallador",
]);

export function paraAIConfig() {
  const auth = authConfig();
  const submissionOrigin = String(process.env.PARAAI_SUBMISSION_ORIGIN || "").trim();
  const matchReadProc = String(process.env.PARAAI_MATCH_READ_PROC || "").trim();
  return {
    ...auth,
    submitApproved: process.env.PARAAI_SUBMIT_APPROVED === "true",
    enrollApproved: process.env.PARAAI_ENROLL_APPROVED === "true",
    dryRun: process.env.PARAAI_DRY_RUN !== "false" || ["1", "true"].includes(String(process.env.DRY_RUN || "").toLowerCase()),
    submissionOrigin,
    // The current Paraform profile button sends CRM; the Talent Network page
    // sends TALENT_NETWORK_PAGE. Both values were verified in the live bundle.
    submissionOriginPinned: ["CRM", "TALENT_NETWORK_PAGE"].includes(submissionOrigin),
    matchReadProc,
    matchReadPinned: Boolean(matchReadProc),
    anthropicConfigured: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API),
    openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
    extractorConfigured: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API || process.env.OPENAI_API_KEY),
    lifecycleRegistrationConfigured: Boolean(process.env.PARAAI_LIFECYCLE_SECRET),
  };
}

let cookieCache = null;
export function clearCookieCache() { cookieCache = null; }

export async function paraformCookie() {
  if (cookieCache) return cookieCache;
  const direct = process.env.PARAFORM_SESSION_COOKIE || process.env.PARAFORM_COOKIE;
  if (direct) {
    cookieCache = direct;
    return cookieCache;
  }
  const base = String(process.env.N8N_BASE_URL || "").replace(/\/+$/, "");
  const key = process.env.N8N_API_KEY || "";
  if (!base || !key) throw new Error("no Paraform session cookie or n8n variable fallback configured");
  const response = await fetch(`${base}/api/v1/variables`, {
    headers: { "X-N8N-API-KEY": key },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`n8n variables read failed: ${response.status}`);
  const item = ((await response.json())?.data || []).find((row) => row?.key === "PARAFORM_SESSION_COOKIE");
  if (!item?.value) throw new Error("PARAFORM_SESSION_COOKIE not found in n8n variables");
  cookieCache = item.value;
  return cookieCache;
}

export async function hasParaformCookie() {
  try { return Boolean(await paraformCookie()); } catch { return false; }
}

async function paraformHeaders() {
  return {
    accept: "application/json",
    "content-type": "application/json",
    cookie: `__Secure-next-auth.session-token=${await paraformCookie()}`,
  };
}

function vendorError(response, body) {
  if (response.status === 401) {
    clearCookieCache();
    const error = new Error("AUTH_EXPIRED");
    error.code = "AUTH_EXPIRED";
    return error;
  }
  const message = body?.error?.json?.message || body?.message || `Paraform HTTP ${response.status}`;
  const error = new Error(String(message));
  error.code = body?.error?.json?.code || `HTTP_${response.status}`;
  error.status = response.status;
  return error;
}

const envelope = (json) => ({ json, meta: { values: {}, v: 1 } });

export async function trpcGet(proc, json = {}, tries = 3) {
  const url = `${PARAFORM_BASE}/trpc/${proc}?input=${encodeURIComponent(JSON.stringify(envelope(json)))}`;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: await paraformHeaders(),
        signal: AbortSignal.timeout(TRPC_TIMEOUT_MS),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.error) throw vendorError(response, body);
      return body?.result?.data?.json;
    } catch (error) {
      if (error?.code === "AUTH_EXPIRED" || attempt === tries - 1) throw error;
      await sleep(500 * (attempt + 1));
    }
  }
}

export async function trpcPost(proc, json = {}, tries = 3) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const response = await fetch(`${PARAFORM_BASE}/trpc/${proc}`, {
        method: "POST",
        headers: await paraformHeaders(),
        body: JSON.stringify(envelope(json)),
        signal: AbortSignal.timeout(TRPC_TIMEOUT_MS),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.error) throw vendorError(response, body);
      return body?.result?.data?.json;
    } catch (error) {
      if (error?.code === "AUTH_EXPIRED" || attempt === tries - 1) throw error;
      await sleep(500 * (attempt + 1));
    }
  }
}

export const normName = (value) => String(value || "").trim().toLowerCase().replace(/\s+/g, " ");

export function normLinkedin(value) {
  let raw = String(value || "").trim();
  if (!raw) return "";
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  try {
    const url = new URL(raw);
    if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) return "";
    const parts = url.pathname.split("/").filter(Boolean);
    if (!parts.length) return "";
    if (!new Set(["in", "pub"]).has(parts[0].toLowerCase())) {
      if (parts.length !== 1) return "";
      parts.unshift("in");
    }
    const handle = parts[1]?.toLowerCase();
    return handle ? `https://www.linkedin.com/in/${handle}` : "";
  } catch {
    return "";
  }
}

export function linkedinHandle(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw && !raw.includes("/") && !raw.includes("linkedin.com") && /^[a-z0-9_.%-]+$/.test(raw)) return raw;
  return normLinkedin(value).split("/").filter(Boolean).pop() || "";
}

export function phonesMatch(a, b) {
  const left = String(a || "").replace(/\D/g, "").replace(/^0+/, "");
  const right = String(b || "").replace(/\D/g, "").replace(/^0+/, "");
  if (left.length < 10 || right.length < 10 || left.slice(-10) !== right.slice(-10)) return false;
  return left.endsWith(right) || right.endsWith(left);
}

export function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "";
  return ["@paraform.com", "@raydar.xyz", "@raydargroup.com"].some((suffix) => email.endsWith(suffix)) ? "" : email;
}

export function firstEmail(value) {
  const seen = new Set();
  const visit = (node, depth = 0) => {
    if (depth > 5 || node == null) return "";
    if (typeof node === "string") return normalizeEmail(node);
    if (Array.isArray(node)) {
      for (const item of node) {
        const hit = visit(item, depth + 1);
        if (hit) return hit;
      }
      return "";
    }
    if (typeof node !== "object" || seen.has(node)) return "";
    seen.add(node);
    for (const key of ["email", "candidate_email", "to_use_email", "user_email", "emails", "user_emails"]) {
      if (key in node) {
        const hit = visit(node[key], depth + 1);
        if (hit) return hit;
      }
    }
    for (const [key, item] of Object.entries(node)) {
      if (/candidate|contact|attendee|invitee|guest|calendar|meeting/i.test(key)) {
        const hit = visit(item, depth + 1);
        if (hit) return hit;
      }
    }
    return "";
  };
  return visit(value);
}

export function hasEmail(value, expected) {
  const wanted = normalizeEmail(expected);
  if (!wanted) return false;
  const seen = new Set();
  const visit = (node, depth = 0) => {
    if (depth > 6 || node == null) return false;
    if (typeof node === "string") return normalizeEmail(node) === wanted;
    if (Array.isArray(node)) return node.some((item) => visit(item, depth + 1));
    if (typeof node !== "object" || seen.has(node)) return false;
    seen.add(node);
    return Object.values(node).some((item) => visit(item, depth + 1));
  };
  return visit(value);
}

export function findResumeUri(value) {
  const seen = new Set();
  const visit = (node, depth = 0) => {
    if (depth > 6 || node == null) return "";
    if (Array.isArray(node)) {
      for (const item of node) {
        const hit = visit(item, depth + 1);
        if (hit) return hit;
      }
      return "";
    }
    if (typeof node !== "object" || seen.has(node)) return "";
    seen.add(node);
    for (const [key, item] of Object.entries(node)) {
      if (/^(resume_?uri|uri)$/i.test(key) && typeof item === "string" && item.trim()) return item.trim();
    }
    for (const item of Object.values(node)) {
      const hit = visit(item, depth + 1);
      if (hit) return hit;
    }
    return "";
  };
  return visit(value);
}

export function scoreIdentity(candidate, crmItem) {
  const signals = [];
  const leftLinkedin = linkedinHandle(candidate?.linkedin);
  const rightLinkedin = linkedinHandle(crmItem?.linkedin_user || crmItem?.linkedinUrl || crmItem?.linkedin_url);
  if (leftLinkedin && rightLinkedin && leftLinkedin === rightLinkedin) signals.push("linkedin");
  if (phonesMatch(candidate?.phone, crmItem?.phone_number)) signals.push("phone");

  const scheduled = Date.parse(candidate?.scheduledStart || "");
  const crmScheduled = Date.parse(
    crmItem?.candidate_calendar_meeting?.event_scheduled_at ||
    crmItem?.first_parascribe_call?.event_scheduled_at ||
    "",
  );
  if (Number.isFinite(scheduled) && Number.isFinite(crmScheduled) && Math.abs(scheduled - crmScheduled) <= 120_000) {
    signals.push("scheduled_time");
  }
  if (normName(candidate?.fullName || candidate?.name) && normName(candidate?.fullName || candidate?.name) === normName(crmItem?.name)) {
    signals.push("name");
  }
  const strong = signals.some((signal) => ["linkedin", "phone", "scheduled_time"].includes(signal));
  return { signals, ok: signals.length >= 2 && strong };
}

export function findIdentity(candidate, items) {
  const matches = (items || [])
    .map((item) => ({ item, score: scoreIdentity(candidate, item) }))
    .filter((match) => match.score.ok);
  const ids = new Set(matches.map((match) => String(match.item?.id || "")).filter(Boolean));
  if (ids.size === 1) return { match: matches[0].item, score: matches[0].score, ambiguous: false };
  return { match: null, score: null, ambiguous: ids.size > 1 };
}

export async function crmPage(cursor = 0, limit = CRM_PAGE_SIZE) {
  const filters = { sort: { field: "updated_at", direction: "desc" } };
  const configured = String(process.env.CRM_RECRUITER_IDS || "").split(",").map((item) => item.trim()).filter(Boolean);
  if (configured.length) filters.recruiters = configured;
  const result = await trpcGet("candidateUser.getCRMExternalCandidates", { filters, limit, cursor });
  return { items: result?.items || [], nextCursor: result?.next_cursor ?? null };
}

export async function scanCrm({ stopWhen } = {}) {
  const items = [];
  let cursor = 0;
  for (let page = 0; page < MAX_CRM_PAGES; page++) {
    const result = await crmPage(cursor, CRM_PAGE_SIZE);
    items.push(...result.items);
    if (stopWhen?.(result.items, items)) break;
    if (!result.items.length || result.nextCursor == null) break;
    cursor = result.nextCursor;
  }
  return items;
}

export async function findCrmCandidate(candidateUserId) {
  const wanted = String(candidateUserId || "");
  if (!wanted) return null;
  const rows = await scanCrm({ stopWhen: (page) => page.some((item) => String(item?.id) === wanted) });
  return rows.find((item) => String(item?.id) === wanted) || null;
}

export async function candidateDetails(candidateUserId) {
  const [byId, profile] = await Promise.all([
    trpcGet("candidateUser.getCandidateUserById", { candidate_user_id: candidateUserId }).catch(() => null),
    trpcGet("candidateUser.getCandidateProfileInfo", { candidateUserId }).catch(() => null),
  ]);
  return { byId, profile };
}

export async function candidatePreferences(candidateUserId) {
  if (!candidateUserId) return null;
  return trpcGet("candidateUserPreference.getCandidateUserPrefs", { candidate_user_id: candidateUserId });
}

export async function directSubmitQuota(recruiterId = RECRUITER_ID) {
  const input = recruiterId && recruiterId !== RECRUITER_ID ? { recruiterId } : {};
  return trpcGet("agency.getTalentNetworkDirectSubmitQuota", input);
}

export function candidateAlreadySubmitted(value) {
  const rows = [value, value?.byId, value?.profile].filter(Boolean);
  const visit = (node, depth = 0) => {
    if (!node || typeof node !== "object" || depth > 5) return false;
    if (node.talent_network_submitted_at || node.talentNetworkSubmittedAt) return true;
    if (node.has_application_submission_ever === true || node.hasApplicationSubmissionEver === true) return true;
    const status = String(node.matching_pool_status || node.matchingPoolStatus || "").toUpperCase();
    if (status && !["NONE", "NOT_SUBMITTED", "INELIGIBLE", "OFF_MARKET"].includes(status)) return true;
    return Object.values(node).some((item) => visit(item, depth + 1));
  };
  return rows.some((row) => visit(row));
}

export function hasFutureScheduledStep(value, now = Date.now()) {
  const dateKeys = new Set(["scheduled_at", "event_scheduled_at", "next_step_at", "interview_at", "starts_at", "start_at"]);
  const visit = (node, depth = 0) => {
    if (!node || typeof node !== "object" || depth > 5) return false;
    for (const [key, item] of Object.entries(node)) {
      if (dateKeys.has(key.toLowerCase())) {
        const time = Date.parse(String(item || ""));
        if (Number.isFinite(time) && time > now) return true;
      }
      if (visit(item, depth + 1)) return true;
    }
    return false;
  };
  return visit(value);
}

export async function fetchCall(botId) {
  const base = String(process.env.RAYDAR_CALLS_API || "https://raydar-calls.vercel.app/api/call");
  const url = `${base}${base.includes("?") ? "&" : "?"}bot=${encodeURIComponent(botId)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.botId) throw new Error(body?.error || `call lookup failed: ${response.status}`);
  return body;
}

export function isSuccessfulCall(call) {
  const verdict = String(call?.verdict?.verdict || call?.verdict?.value || call?.verdict || "").toLowerCase();
  if (verdict !== "success") return false;
  const userChars = Number(call?.verdict?.userChars ?? call?.metrics?.userChars ?? 80);
  const density = Number(call?.verdict?.speechDensity ?? call?.metrics?.speechDensity ?? 0.6);
  return userChars >= 80 && density >= 0.6;
}

export async function getResume(candidateUserId) {
  return trpcGet("candidateUser.getMostRecentResume", { candidate_user_id: candidateUserId });
}

export async function resumeContact(resumeUri, { trpcGetImpl = trpcGet } = {}) {
  if (!resumeUri) return null;
  return trpcGetImpl("candidateUser.extractResumeContactFields", { resumeUri });
}

export async function uploadResume(
  { bytes, fileName },
  { trpcGetImpl = trpcGet, fetchImpl = fetch, resumeContactImpl = resumeContact, uuidImpl = randomUUID } = {},
) {
  if (!bytes?.length) throw new Error("resume PDF is empty");
  const presign = await trpcGetImpl("file.getResumeUploadUrl", { fileName: uuidImpl() });
  if (!presign?.url || !presign?.resumeUri) throw new Error("resume presign returned no upload target");
  const form = new FormData();
  for (const [key, value] of Object.entries(presign.fields || {})) form.append(key, String(value));
  form.append("file", new Blob([bytes], { type: "application/pdf" }), fileName);
  const response = await fetchImpl(presign.url, { method: "POST", body: form, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`resume upload failed: ${response.status}`);
  return { resumeUri: presign.resumeUri, contact: await resumeContactImpl(presign.resumeUri).catch(() => null) };
}

export async function listSequences() {
  return (await trpcGet("campaigns.getListOfCampaignsOptimized", {})) || [];
}

export async function resolveSequence(name, sequences = null) {
  const rows = sequences || await listSequences();
  return rows.find((row) => row?.name === name) || null;
}

export async function campaignLeadsAll(campaignId) {
  const first = await trpcGet("campaigns.getCampaignLeads", { campaign_id: campaignId });
  const leads = [...(first?.leads || [])];
  const total = Math.min(Number(first?.totalCount ?? leads.length), 10_000);
  const pageSize = leads.length || 50;
  for (let cursor = pageSize; cursor < total; cursor += pageSize) {
    const page = (await trpcGet("campaigns.getCampaignLeads", { campaign_id: campaignId, cursor }))?.leads || [];
    if (!page.length) throw new Error(`incomplete campaign membership read: ${leads.length}/${total}`);
    leads.push(...page);
  }
  if (leads.length < total) throw new Error(`incomplete campaign membership read: ${leads.length}/${total}`);
  return leads;
}

export async function findLead(campaignId, candidateUserId) {
  return (await campaignLeadsAll(campaignId)).find((lead) => String(lead?.cu_id) === String(candidateUserId)) || null;
}

export async function targetMembership(candidateUserId) {
  const sequences = await listSequences();
  const targets = Object.values(SEQUENCE_NAMES).map((name) => ({ name, sequence: sequences.find((row) => row?.name === name) || null }));
  const memberships = [];
  for (const target of targets) {
    if (!target.sequence?.id) continue;
    const lead = await findLead(target.sequence.id, candidateUserId);
    if (lead) memberships.push({ sequence: target.sequence, lead });
  }
  return { sequences, targets, memberships };
}

export async function registerLifecycleEnrollment({ botId, candidate, candidateUserId, ccuId, email, sequenceId, sequenceName, enrolledAt }) {
  const secret = process.env.PARAAI_LIFECYCLE_SECRET || "";
  if (!secret) throw new Error("lifecycle registration secret not configured");
  const base = String(process.env.LIFECYCLE_API_URL || "https://raydar-lifecycle.vercel.app").replace(/\/+$/, "");
  const response = await fetch(`${base}/api/register`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ botId, candidate, candidateUserId, ccuId, email, sequenceId, sequenceName, enrolledAt }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) throw new Error(body?.error || `lifecycle registration failed: ${response.status}`);
  return body;
}

export async function notifySlack(text) {
  const token = process.env.SLACK_BOT_TOKEN || "";
  const channel = process.env.PARAAI_SLACK_CHANNEL || process.env.SLACK_CHANNEL_ID_ALERTS || "";
  if (token && channel) {
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ channel, text }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json().catch(() => null);
    if (body?.ok) return true;
  }
  const webhook = process.env.SLACK_WEBHOOK_URL || "";
  if (!webhook) return false;
  const response = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(10_000),
  });
  return response.ok;
}
