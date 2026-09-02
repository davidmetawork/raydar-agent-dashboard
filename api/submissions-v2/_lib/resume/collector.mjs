import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

import {
  paraformCookie,
  paraformCookieName,
  trpcGet,
} from "../../../paraai/_lib/core.mjs";
import {
  normalizeSourceBundle,
  normalizeEvidenceText,
} from "./source-bundle.mjs";

const PARAFORM_API = "https://www.paraform.com/api";
const MAX_RESUME_BYTES = 15 * 1024 * 1024;
const MAX_INTAKE_FALLBACK_MEETINGS = 8;
const EXPECTED_SOURCE_STALE_MS = 365 * 24 * 60 * 60 * 1_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clean = (value, limit = 8_000) => String(value ?? "").trim().slice(0, limit);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function safeIso(value) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function newestTimestamp(value, seen = new Set(), depth = 0) {
  if (!value || typeof value !== "object" || seen.has(value) || depth > 5) return null;
  seen.add(value);
  let newest = 0;
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:updated|modified|captured|fetched|created)_?at$/iu.test(key)) {
      const parsed = Date.parse(child || "");
      if (Number.isFinite(parsed)) newest = Math.max(newest, parsed);
    } else if (child && typeof child === "object") {
      const nested = newestTimestamp(child, seen, depth + 1);
      if (nested) newest = Math.max(newest, Date.parse(nested));
    }
  }
  return newest ? new Date(newest).toISOString() : null;
}

function deterministicJson(value) {
  const walk = (item, seen = new Set()) => {
    if (item == null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number") return Number.isFinite(item) ? item : null;
    if (item instanceof Date) return item.toISOString();
    if (Array.isArray(item)) return item.map((child) => walk(child, seen));
    if (typeof item !== "object" || seen.has(item)) return null;
    seen.add(item);
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, walk(item[key], seen)]));
  };
  return JSON.stringify(walk(value));
}

function failureKind(error) {
  const message = clean(error?.code || error?.message || error, 500);
  if (/AUTH_EXPIRED/iu.test(message)) return "auth_expired";
  if (/PROC_UNAUTHORIZED|FORBIDDEN|DENIED|HTTP_?40[13]/iu.test(message)) return "denied";
  return "unreadable";
}

function statusFor(value, { failed = null, partial = false, sourceUpdatedAt = null, now = Date.now() } = {}) {
  if (failed) return failureKind(failed) === "denied" ? "denied" : "unreadable";
  if (value == null || value === "" || (Array.isArray(value) && !value.length)) return "missing";
  if (partial) return "partial";
  if (sourceUpdatedAt && now - Date.parse(sourceUpdatedAt) > EXPECTED_SOURCE_STALE_MS) return "stale";
  return "present";
}

function sourceOutcome({
  key,
  value,
  locator,
  capturedAt,
  failed = null,
  partial = false,
  origin = "not_applicable",
  sourceId = null,
  sourceUpdatedAt = null,
  metadata = {},
  accuracyImpact,
  remediation,
  now,
}) {
  const status = statusFor(value, { failed, partial, sourceUpdatedAt, now });
  return {
    key,
    status,
    origin,
    sourceId,
    locator,
    capturedAt,
    sourceUpdatedAt,
    content: value == null ? null : value,
    normalizedText: value == null ? "" : normalizeEvidenceText(
      typeof value === "string" ? value : deterministicJson(value),
    ),
    accuracyImpact,
    remediation,
    metadata: {
      ...metadata,
      ...(failed ? { readFailed: true, safeErrorCode: clean(failed?.code || failed?.message || "read_failed", 120) } : {}),
    },
  };
}

function transcriptTurns(record) {
  const rows = Array.isArray(record?.recording_transcript)
    ? record.recording_transcript
    : Array.isArray(record?.transcript)
      ? record.transcript
      : [];
  const output = [];
  for (const row of rows) {
    const speaker = clean(row?.speaker || row?.speaker_name || row?.role || "Speaker", 200);
    const direct = clean(row?.text || row?.transcript || row?.content, 20_000);
    const words = Array.isArray(row?.words)
      ? row.words.map((word) => clean(typeof word === "string" ? word : word?.text, 500)).filter(Boolean).join(" ")
      : "";
    const text = normalizeEvidenceText(direct || words);
    if (text) output.push(`${speaker}: ${text}`);
  }
  return output;
}

function intakeTurns(record) {
  const full = clean(record?.transcription, 250_000);
  if (full.length >= 200) return { text: normalizeEvidenceText(full.replace(/<[^>]+>/gu, " ")), partial: false };
  const rebuilt = transcriptTurns({ recording_transcript: record?.transcription_json }).join("\n");
  if (rebuilt.length >= 200) return { text: rebuilt, partial: false };
  const summary = normalizeEvidenceText(clean(record?.shorten_transcript, 80_000).replace(/<[^>]+>/gu, " "));
  return summary ? { text: summary, partial: true } : null;
}

function resumeIdFrom(...values) {
  for (const value of values) {
    const selected = [
      value?.resume_id,
      value?.latest_application_resume_id,
      value?.resume?.id,
      value?.file_id,
      value?.resume_upload_id,
      value?.candidate?.resume_id,
      value?.candidate_user?.resume_id,
    ].map((item) => clean(item, 160)).find(Boolean);
    if (selected) return selected;
  }
  return null;
}

async function responseBytes(response) {
  const declared = Number(response.headers?.get?.("content-length") || 0);
  if (declared > MAX_RESUME_BYTES) throw Object.assign(new Error("resume_too_large"), { code: "resume_too_large" });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_RESUME_BYTES || bytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw Object.assign(new Error("resume_not_pdf"), { code: "resume_not_pdf" });
  }
  return bytes;
}

function privateAddress(address) {
  const value = String(address || "").toLowerCase();
  if (isIP(value) === 4) {
    const [a, b, c] = value.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0 && c === 0)
      || (a === 192 && b === 0 && c === 2) || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)
      || a >= 224;
  }
  if (isIP(value) === 6) {
    const ipv4Tail = value.includes(".") ? value.slice(value.lastIndexOf(":") + 1) : null;
    const normalized = ipv4Tail && isIP(ipv4Tail) === 4
      ? `${value.slice(0, value.lastIndexOf(":") + 1)}${(Number(ipv4Tail.split(".")[0]) * 256 + Number(ipv4Tail.split(".")[1])).toString(16)}:${(Number(ipv4Tail.split(".")[2]) * 256 + Number(ipv4Tail.split(".")[3])).toString(16)}`
      : value;
    const halves = normalized.split("::");
    if (halves.length > 2) return true;
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
    const missing = 8 - left.length - right.length;
    const words = halves.length === 2 ? [...left, ...Array(Math.max(0, missing)).fill("0"), ...right] : left;
    if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/u.test(word))) return true;
    const bytes = Buffer.alloc(16);
    words.forEach((word, index) => bytes.writeUInt16BE(Number.parseInt(word, 16), index * 2));
    const mapped = bytes.subarray(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
    if (mapped) return privateAddress(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
    const globalUnicast = (bytes[0] & 0xe0) === 0x20;
    const documentation = bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8;
    const special2001 = bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] < 0x02;
    return !globalUnicast || documentation || special2001;
  }
  return true;
}

function allowedResumeHosts(env = process.env) {
  return new Set(String(env.SUBMISSIONS_V2_RESUME_DOWNLOAD_HOSTS || "").split(",")
    .map((value) => value.trim().toLowerCase()).filter((value) => /^[a-z0-9.-]+$/u.test(value)));
}

async function validatedResumeUrl(value, { env = process.env, lookupImpl = dnsLookup } = {}) {
  let url;
  try { url = new URL(value); } catch {}
  const hosts = allowedResumeHosts(env);
  if (!url || url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !hosts.has(url.hostname.toLowerCase())) {
    throw Object.assign(new Error("resume_signed_url_invalid"), { code: "resume_signed_url_invalid" });
  }
  const resolved = await lookupImpl(url.hostname, { all: true, verbatim: true });
  if (!Array.isArray(resolved) || !resolved.length || resolved.some((row) => privateAddress(row.address))) {
    throw Object.assign(new Error("resume_signed_url_address_rejected"), { code: "resume_signed_url_address_rejected" });
  }
  return url;
}

export async function downloadCandidateResume(resumeId, {
  fetchImpl = globalThis.fetch,
  cookieImpl = paraformCookie,
  cookieNameImpl = paraformCookieName,
  lookupImpl = dnsLookup,
  env = process.env,
} = {}) {
  if (!resumeId) return null;
  const cookie = await cookieImpl();
  const response = await fetchImpl(`${PARAFORM_API}/resumeUpload/signedURL?resume_id=${encodeURIComponent(resumeId)}`, {
    headers: { cookie: `${cookieNameImpl(cookie)}=${cookie}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw Object.assign(new Error(`resume_signed_url_http_${response.status}`), { code: "resume_signed_url_failed" });
  const contentType = clean(response.headers?.get?.("content-type"), 200).toLowerCase();
  if (/(?:application\/pdf|application\/octet-stream)/u.test(contentType)) return responseBytes(response);
  const raw = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch {}
  const signedUrl = parsed?.url || parsed?.signedUrl || parsed?.signed_url || (/^https:\/\//u.test(raw.trim()) ? raw.trim() : null);
  if (!signedUrl) throw Object.assign(new Error("resume_signed_url_invalid"), { code: "resume_signed_url_invalid" });
  let url = await validatedResumeUrl(signedUrl, { env, lookupImpl });
  let file;
  for (let redirect = 0; redirect < 3; redirect += 1) {
    file = await fetchImpl(url, { signal: AbortSignal.timeout(30_000), redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(file.status)) break;
    const location = file.headers?.get?.("location");
    if (!location) throw Object.assign(new Error("resume_download_redirect_invalid"), { code: "resume_download_redirect_invalid" });
    url = await validatedResumeUrl(new URL(location, url).toString(), { env, lookupImpl });
  }
  if ([301, 302, 303, 307, 308].includes(file?.status)) throw Object.assign(new Error("resume_download_redirect_limit"), { code: "resume_download_redirect_limit" });
  if (!file.ok) throw Object.assign(new Error(`resume_download_http_${file.status}`), { code: "resume_download_failed" });
  return responseBytes(file);
}

export async function extractResumePdf(pdfBytes, {
  fetchImpl = globalThis.fetch,
  env = process.env,
} = {}) {
  const base = clean(env.SUBMISSIONS_V2_RENDERER_URL, 2_000).replace(/\/+$/u, "");
  const key = clean(env.SUBMISSIONS_V2_RENDERER_KEY, 2_000);
  let rendererUrl = null;
  try { rendererUrl = new URL(base); } catch {}
  const loopbackHttp = rendererUrl?.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(rendererUrl.hostname);
  if (!rendererUrl || (rendererUrl.protocol !== "https:" && !loopbackHttp) || rendererUrl.username || rendererUrl.password || !key) {
    throw Object.assign(new Error("resume_extractor_not_configured"), { code: "resume_extractor_not_configured" });
  }
  const response = await fetchImpl(`${base}/extract-v2`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ pdf_base64: Buffer.from(pdfBytes).toString("base64") }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await response.json().catch(() => null);
  const text = normalizeEvidenceText(body?.text || body?.extracted_text);
  if (!response.ok || body?.ok !== true || !text) {
    throw Object.assign(new Error(clean(body?.error || "resume_extract_failed", 200)), { code: clean(body?.error || "resume_extract_failed", 120) });
  }
  if (body.pdf_sha256 && body.pdf_sha256 !== sha256(pdfBytes)) {
    throw Object.assign(new Error("resume_extract_digest_mismatch"), { code: "resume_extract_digest_mismatch" });
  }
  return { text, pageCount: Number(body.page_count || body.pageCount) || null };
}

function pacedGet({ getImpl, paceMs, sleepImpl }) {
  let lastAt = 0;
  return async (procedure, input) => {
    const wait = Math.max(0, lastAt + paceMs - Date.now());
    if (wait) await sleepImpl(wait);
    lastAt = Date.now();
    return getImpl(procedure, input);
  };
}

async function settled(read, procedure, input) {
  try { return { value: await read(procedure, input), error: null }; }
  catch (error) {
    if (failureKind(error) === "auth_expired") throw error;
    return { value: null, error };
  }
}

async function candidateCall(candidateUserId, read) {
  const meetings = await settled(read, "candidateUserMeeting.getSelectableMeetingsForCandidateUserId", { candidate_user_id: candidateUserId });
  if (meetings.error) return meetings;
  const candidates = (Array.isArray(meetings.value) ? meetings.value : meetings.value?.items || [])
    .map((meeting) => ({ meeting, turns: transcriptTurns(meeting) }))
    .sort((left, right) => right.turns.join("\n").length - left.turns.join("\n").length);
  for (const item of candidates) {
    if (item.turns.length) return { value: { meeting: item.meeting, text: item.turns.join("\n") }, error: null };
    const id = item.meeting?.id || item.meeting?.call_id || item.meeting?.meeting_id;
    if (!id) continue;
    const detail = await settled(read, "candidateUserMeeting.getCallById", { id });
    const turns = transcriptTurns(detail.value);
    if (turns.length) return { value: { meeting: detail.value, text: turns.join("\n") }, error: null };
  }
  return { value: null, error: null };
}

async function roleIntake(roleId, read) {
  const latest = await settled(read, "meetings.getLatestProcessedMeeting", { role_id: roleId });
  const latestIsIntake = latest.value && (latest.value.type === "INTAKE_CALL" || latest.value.is_intake_call_for_this_role);
  const latestContent = latestIsIntake ? intakeTurns(latest.value) : null;
  if (latestContent) return { value: { meeting: latest.value, ...latestContent }, error: null };
  const listed = await settled(read, "meetings.getAllIntakeAndOnboardingCallsByRoleId", { role_id: roleId });
  if (listed.error) return listed;
  const meetings = (Array.isArray(listed.value) ? listed.value : [])
    .filter((meeting) => meeting && (meeting.type === "INTAKE_CALL" || meeting.type == null))
    .sort((left, right) => Date.parse(right.scheduled_at || 0) - Date.parse(left.scheduled_at || 0))
    .slice(0, MAX_INTAKE_FALLBACK_MEETINGS);
  let best = null;
  for (const summary of meetings) {
    const id = summary.id || summary.meeting_id;
    if (!id) continue;
    const detail = await settled(read, "meetings.getMeetingById", { meeting_id: id });
    if (detail.error || detail.value?.type !== "INTAKE_CALL") continue;
    const content = intakeTurns(detail.value);
    if (content && (!best || content.text.length > best.text.length)) best = { meeting: detail.value, ...content };
  }
  return { value: best, error: latest.error || null };
}

const ROLE_READS = Object.freeze([
  ["detailed", "role.getRoleByIdDetailed"],
  ["basic", "role.getBasicRoleInfo"],
  ["requirements", "role.getRoleRequirements"],
  ["years", "role.getRoleYearOfExperiences"],
  ["salary", "role.getRoleSalaryLimit"],
  ["hiring_manager", "role.getHiringManagerInfo"],
  ["owner", "role.getRoleOwner"],
  ["scraped_company", "role.getScrapedCompanyByRoleId"],
  ["company", "company.getCompanyByRoleId"],
  ["faqs", "forum.getRoleFaqs"],
  ["filters", "candidates.getCandidateFiltersByRoleId"],
  ["interview_stages", "role.getInterviewStagesSetup"],
  ["interviewing_by_round", "role.getInterviewingByRound"],
]);

export async function collectResumeSourceBundle({
  candidateUserId,
  roleId,
  supplements = [],
  knownRaydarDigests = [],
}, {
  trpcGetImpl = trpcGet,
  downloadResumeImpl = null,
  extractResumeImpl = extractResumePdf,
  env = process.env,
  fetchImpl = globalThis.fetch,
  paceMs = 400,
  sleepImpl = sleep,
  now = Date.now,
} = {}) {
  const capturedAt = new Date(now()).toISOString();
  const read = pacedGet({ getImpl: trpcGetImpl, paceMs: Math.max(0, Number(paceMs) || 0), sleepImpl });
  const byId = await settled(read, "candidateUser.getCandidateUserById", { candidate_user_id: candidateUserId });
  if (!byId.value) {
    const error = byId.error || Object.assign(new Error("candidate_identity_missing"), { code: "candidate_identity_missing" });
    throw Object.assign(error, { code: error.code || "candidate_identity_missing" });
  }
  const profile = await settled(read, "candidateUser.getCandidateProfileInfo", { candidateUserId });
  const resumeMeta = await settled(read, "candidateUser.getMostRecentResume", { candidate_user_id: candidateUserId });
  const resumeId = resumeIdFrom(resumeMeta.value, byId.value, profile.value);
  let resumeBytes = null;
  let resumeExtract = null;
  let resumeError = resumeMeta.error;
  if (resumeId && !resumeError) {
    try {
      const download = downloadResumeImpl || ((id) => downloadCandidateResume(id, { env, fetchImpl }));
      resumeBytes = await download(resumeId);
      resumeExtract = await extractResumeImpl(resumeBytes);
    } catch (error) { resumeError = error; }
  }
  const call = await candidateCall(candidateUserId, read);
  const linkedin = await settled(read, "candidateUser.getLinkedInCandidate", { candidateUserId });
  const preferences = await settled(read, "candidateUserPreference.getCandidateUserPrefs", { candidate_user_id: candidateUserId });
  const roleResults = {};
  for (const [key, procedure] of ROLE_READS) roleResults[key] = await settled(read, procedure, { role_id: roleId });
  const intake = await roleIntake(roleId, read);

  const roleRecord = {
    detailed: roleResults.detailed.value,
    basic: roleResults.basic.value,
    years: roleResults.years.value,
    salary: roleResults.salary.value,
    hiring_manager: roleResults.hiring_manager.value,
    owner: roleResults.owner.value,
  };
  const roleContext = {
    requirements: roleResults.requirements.value,
    faqs: roleResults.faqs.value,
    filters: roleResults.filters.value,
    interview_stages: roleResults.interview_stages.value,
    interviewing_by_round: roleResults.interviewing_by_round.value,
  };
  const companyContext = {
    scraped_company: roleResults.scraped_company.value,
    company: roleResults.company.value,
  };
  const roleFailures = Object.fromEntries(ROLE_READS.filter(([key]) => roleResults[key].error).map(([key]) => [key, clean(roleResults[key].error?.code || roleResults[key].error?.message, 120)]));
  const supplementText = supplements.map((item) => item?.normalizedText || item?.text).filter(Boolean).join("\n\n");
  const resumePdfDigest = resumeBytes ? sha256(resumeBytes) : null;
  const resumeOrigin = resumeExtract?.text
    ? (new Set(knownRaydarDigests.map((value) => clean(value, 128).toLowerCase())).has(resumePdfDigest)
      ? "raydar_generated"
      : "origin_unverified")
    : "not_applicable";
  const linkedinUpdatedAt = newestTimestamp(linkedin.value);
  const preferenceUpdatedAt = newestTimestamp(preferences.value);
  const sources = [
    sourceOutcome({
      key: "candidate_original_resume", value: resumeExtract?.text || null,
      locator: `paraform:candidate:${candidateUserId}:resume`, capturedAt,
      failed: resumeError, origin: resumeOrigin,
      sourceId: resumeId, metadata: {
        readable: Boolean(resumeExtract?.text), pageCount: resumeExtract?.pageCount || null,
        pdfSha256: resumePdfDigest,
      },
      accuracyImpact: "Without the candidate's original resume, truthful resume preparation cannot proceed.",
      remediation: "Add the candidate's original resume in Paraform, then Recheck.", now: now(),
    }),
    sourceOutcome({
      key: "candidate_call", value: call.value?.text || null,
      locator: `paraform:candidate:${candidateUserId}:calls`, capturedAt, failed: call.error,
      sourceId: call.value?.meeting?.id || call.value?.meeting?.call_id || null,
      sourceUpdatedAt: safeIso(call.value?.meeting?.event_scheduled_at || call.value?.meeting?.scheduled_at),
      accuracyImpact: "Candidate nuance and spoken context may be missing.",
      remediation: "Confirm or add the relevant candidate context if it materially changes the resume.", now: now(),
    }),
    sourceOutcome({
      key: "candidate_linkedin", value: linkedin.value,
      locator: `paraform:candidate:${candidateUserId}:linkedin`, capturedAt, failed: linkedin.error,
      sourceUpdatedAt: linkedinUpdatedAt,
      accuracyImpact: "Recent experience or education may not be represented.",
      remediation: "Refresh the cached LinkedIn profile in Paraform when useful.", now: now(),
    }),
    sourceOutcome({
      key: "candidate_preferences", value: preferences.value,
      locator: `paraform:candidate:${candidateUserId}:preferences`, capturedAt, failed: preferences.error,
      sourceUpdatedAt: preferenceUpdatedAt,
      accuracyImpact: "Confirmed preferences may be absent from orientation.",
      remediation: "Add sourced preference context only if it should affect the resume.", now: now(),
    }),
    sourceOutcome({
      key: "recruiter_supplements", value: supplementText || null,
      locator: `raydar:submissions-v2:${candidateUserId}:${roleId}:supplements`, capturedAt,
      sourceId: supplements.length ? supplements.map((item) => item.id).filter(Boolean).join(",") : null,
      accuracyImpact: null, remediation: "Add pair-specific sourced context when needed.", now: now(),
    }),
    sourceOutcome({
      key: "role_record", value: Object.values(roleRecord).some(Boolean) ? roleRecord : null,
      locator: `paraform:role:${roleId}:record`, capturedAt,
      failed: Object.values(roleRecord).some(Boolean) ? null : roleResults.detailed.error || roleResults.basic.error,
      metadata: { readFailures: roleFailures },
      accuracyImpact: "The role's core context may be incomplete.",
      remediation: "Review the role record in Paraform if the orientation appears incomplete.", now: now(),
    }),
    sourceOutcome({
      key: "role_context", value: Object.values(roleContext).some(Boolean) ? roleContext : null,
      locator: `paraform:role:${roleId}:context`, capturedAt,
      failed: Object.values(roleContext).some(Boolean) ? null : roleResults.requirements.error,
      metadata: { readFailures: roleFailures },
      accuracyImpact: "Requirements or interview nuance may be incomplete.",
      remediation: "Review role requirements and FAQs in Paraform when useful.", now: now(),
    }),
    sourceOutcome({
      key: "company_context", value: Object.values(companyContext).some(Boolean) ? companyContext : null,
      locator: `paraform:role:${roleId}:company`, capturedAt,
      failed: Object.values(companyContext).some(Boolean) ? null : roleResults.company.error || roleResults.scraped_company.error,
      metadata: { readFailures: roleFailures },
      accuracyImpact: "Company orientation may be less specific.",
      remediation: "Add sourced company context only if it materially changes emphasis.", now: now(),
    }),
    sourceOutcome({
      key: "role_intake", value: intake.value?.text || null,
      locator: `paraform:role:${roleId}:intake`, capturedAt, failed: intake.error,
      partial: Boolean(intake.value?.partial), sourceId: intake.value?.meeting?.id || null,
      sourceUpdatedAt: safeIso(intake.value?.meeting?.scheduled_at),
      metadata: { summaryFallback: Boolean(intake.value?.partial) },
      accuracyImpact: "The hiring team's nuanced priorities may be incomplete.",
      remediation: "Recover the full intake transcript when possible.", now: now(),
    }),
  ];
  return normalizeSourceBundle({ candidateUserId, roleId, sources, knownRaydarDigests, capturedAt });
}

export const collectorInternals = Object.freeze({
  allowedResumeHosts,
  deterministicJson,
  failureKind,
  intakeTurns,
  privateAddress,
  resumeIdFrom,
  sourceOutcome,
  statusFor,
  transcriptTurns,
  validatedResumeUrl,
});
