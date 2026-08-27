import { createHash, randomUUID } from "node:crypto";

import { get as getBlob, put as putBlob } from "@vercel/blob";

import {
  getResume,
  paraformCookie,
  paraformCookieName,
  trpcGet,
  trpcPostWithDates,
} from "../../paraai/_lib/core.mjs";
import {
  acquireRowLock,
  appendLedgerEvent,
  readLedger,
  readRowsSnapshot,
  releaseRowLock,
  rowHash,
  writeRowsSnapshot,
} from "./store.mjs";
import { codedError } from "./path-a.mjs";
import { createPacedReader } from "./sync.mjs";

const PARAFORM_BASE = "https://www.paraform.com/api";
const RESUME_BUCKET = "paraform-resumes-new";
const RESUME_UPLOAD_ORIGIN = "https://storage.googleapis.com";
const RESUME_DATE_FIELD = "fields.resume_uploaded_at.value";
const MAX_RESUME_BYTES = 15 * 1024 * 1024;
const MAX_ARTIFACTS_PER_ROW = 30;
export const PROFILE_REPLACEMENT_COPY = "this replaces their profile resume.";

const text = (value, limit = 8_000) => String(value ?? "")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, limit);
const digest = (value) => createHash("sha256")
  .update(Buffer.isBuffer(value) || value instanceof Uint8Array ? value : String(value ?? ""))
  .digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function dateText(value) {
  if (!value) return "";
  if (typeof value === "string") return text(value, 120);
  const year = value?.year || value?.date?.year;
  const month = value?.month || value?.date?.month;
  if (!year) return "";
  return month ? `${String(month).padStart(2, "0")}/${year}` : String(year);
}

function rangeText(value = {}) {
  const direct = text(value.dates || value.date_range || value.duration, 160);
  if (direct) return direct;
  const start = dateText(value.start_date || value.startDate || value.started_at || value.from);
  const end = dateText(value.end_date || value.endDate || value.ended_at || value.to)
    || (value.current || value.is_current ? "Present" : "");
  return [start, end].filter(Boolean).join(" – ");
}

function factList(value = {}) {
  const explicit = [value.facts, value.bullets, value.highlights, value.responsibilities]
    .find(Array.isArray);
  if (explicit) {
    return explicit.map((item) => text(
      typeof item === "object" ? item?.text || item?.description || item?.value : item,
      800,
    )).filter(Boolean).slice(0, 30);
  }
  return text(value.description || value.summary || value.detail, 8_000)
    .split(/(?<=[.!?])\s+|[\r\n]+/u)
    .map((item) => text(item, 800))
    .filter(Boolean)
    .slice(0, 30);
}

function experienceArrays(value, depth = 0, seen = new Set()) {
  if (!value || typeof value !== "object" || depth > 4 || seen.has(value)) return [];
  seen.add(value);
  const found = [];
  for (const key of ["experiences", "experience", "positions", "work_experience", "workExperience", "employment_history"]) {
    if (Array.isArray(value[key])) found.push({ key, rows: value[key] });
  }
  for (const key of ["candidate", "candidate_user", "candidateUser", "profile", "data", "linkedin", "linkedin_profile"]) {
    found.push(...experienceArrays(value[key], depth + 1, seen));
  }
  return found;
}

export function normalizeCareerHistory(...sources) {
  const rows = [];
  const seen = new Set();
  for (const source of sources) {
    for (const group of experienceArrays(source)) {
      for (const [index, value] of group.rows.entries()) {
        if (!value || typeof value !== "object") continue;
        const title = text(
          value.title
          || value.position
          || value.role
          || value.job_title
          || value.jobTitle,
          240,
        );
        // getCRMExternalCandidates uses experiences[].name for company. Point
        // and LinkedIn reads use company_name or company.name instead.
        const company = text(
          value.company_name
          || value.companyName
          || value.company?.name
          || value.organization_name
          || value.organization?.name
          || (group.key === "experiences" ? value.name : ""),
          240,
        );
        if (!title && !company) continue;
        const dates = rangeText(value);
        const key = `${title.toLowerCase()}\0${company.toLowerCase()}\0${dates.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({
          id: text(value.id || value.experience_id || value.position_id, 160)
            || `career-${rows.length + index + 1}`,
          title: title || "Role",
          company: company || "Company",
          location: text(value.location?.name || value.location_name || value.location, 240),
          dates,
          facts: factList(value),
        });
      }
    }
  }
  return rows.slice(0, 80);
}

export function selectResumeId(...values) {
  for (const raw of values) {
    const value = Array.isArray(raw) ? raw[0] : raw;
    const options = [
      value?.resume_id,
      value?.latest_application_resume_id,
      value?.resume?.id,
      value?.file_id,
      value?.resume_upload_id,
      value?.candidate?.resume_id,
      value?.candidate_user?.resume_id,
    ];
    const selected = options.map((item) => text(item, 160)).find(Boolean);
    if (selected) return selected;
  }
  return null;
}

export function validatePresignTarget(result, resumeId) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw codedError("PRESIGN_RESPONSE_INVALID", "Paraform returned an invalid resume upload target", 502);
  }
  let url;
  try { url = new URL(result.url); } catch {
    throw codedError("PRESIGN_URL_INVALID", "Paraform returned an invalid resume upload URL", 502);
  }
  if (url.protocol !== "https:" || url.origin !== RESUME_UPLOAD_ORIGIN) {
    throw codedError("PRESIGN_ORIGIN_NOT_ALLOWED", "Paraform returned an unexpected resume upload origin", 502);
  }
  if (!result.fields || typeof result.fields !== "object" || Array.isArray(result.fields)) {
    throw codedError("PRESIGN_FIELDS_INVALID", "Paraform returned invalid resume upload fields", 502);
  }
  const echoedId = result.resumeUri ?? resumeId;
  if (String(result.fields.key || "") !== resumeId || String(echoedId) !== resumeId) {
    throw codedError("PRESIGN_OBJECT_KEY_MISMATCH", "Paraform's upload key did not match the new resume", 502);
  }
  return { url: url.href, fields: result.fields };
}

async function liveRow(body, { readSnapshotImpl = readRowsSnapshot } = {}) {
  const snapshot = await readSnapshotImpl();
  if (!snapshot || snapshot.trustworthy === false) {
    throw codedError("SUBMISSIONS_SNAPSHOT_UNHEALTHY", "the cached list is not trustworthy", 503);
  }
  const row = (snapshot.rows || []).find((item) => item.key === body?.key) || null;
  if (!row) throw codedError("SUBMISSION_ROW_NOT_FOUND", "submission row not found", 404);
  if ((body.candidateUserId != null && row.candidateUserId !== body.candidateUserId)
    || (body.roleId != null && row.roleId !== body.roleId)) {
    throw codedError("SUBMISSION_ROW_CHANGED", "the row identity changed", 409);
  }
  return row;
}

async function patchSnapshotLedger(row, ledger, deps = {}) {
  const read = deps.readSnapshotImpl || readRowsSnapshot;
  const write = deps.writeSnapshotImpl || writeRowsSnapshot;
  const snapshot = await read().catch(() => null);
  if (!snapshot) return;
  await write({
    ...snapshot,
    rows: (snapshot.rows || []).map((item) => item.key === row.key
      ? { ...item, ledger }
      : item),
  });
}

function blobReady(env = process.env) {
  if (!text(env.BLOB_READ_WRITE_TOKEN, 2_000)) {
    throw codedError("RESUME_BLOB_NOT_CONFIGURED", "private resume storage is not configured", 503);
  }
}

async function blobBytes(pathname, { getBlobImpl = getBlob, env = process.env } = {}) {
  if (getBlobImpl === getBlob) blobReady(env);
  const result = await getBlobImpl(pathname, { access: "private", useCache: false });
  if (!result || result.statusCode !== 200 || !result.stream) {
    throw codedError("RESUME_ARTIFACT_NOT_FOUND", "the stored resume artifact could not be read", 404);
  }
  return Buffer.from(await new Response(result.stream).arrayBuffer());
}

async function putPrivate(pathname, body, contentType, {
  putBlobImpl = putBlob,
  env = process.env,
} = {}) {
  if (putBlobImpl === putBlob) blobReady(env);
  const result = await putBlobImpl(pathname, body, {
    access: "private",
    addRandomSuffix: false,
    contentType,
    cacheControlMaxAge: 60,
  });
  if (!result?.pathname) throw codedError("RESUME_BLOB_WRITE_FAILED", "the resume artifact was not stored", 503);
  return result.pathname;
}

export async function downloadResumeFile(resumeId, {
  fetchImpl = fetch,
  cookieImpl = paraformCookie,
  cookieNameImpl = paraformCookieName,
} = {}) {
  if (!resumeId) return null;
  const cookie = await cookieImpl();
  const response = await fetchImpl(
    `${PARAFORM_BASE}/resumeUpload/signedURL?resume_id=${encodeURIComponent(resumeId)}`,
    {
      headers: { cookie: `${cookieNameImpl(cookie)}=${cookie}` },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw codedError("SOURCE_RESUME_READ_FAILED", `Paraform resume read failed: ${response.status}`, 503);
  }
  const contentType = String(response.headers?.get?.("content-type") || "");
  let fileResponse = response;
  if (!/(?:application\/pdf|application\/octet-stream)/i.test(contentType)) {
    const raw = await response.text();
    let body = null;
    try { body = JSON.parse(raw); } catch {}
    const signedUrl = body?.url || body?.signedUrl || body?.signed_url
      || (/^https:\/\//u.test(raw.trim()) ? raw.trim() : null);
    if (!signedUrl) throw codedError("SOURCE_RESUME_SIGNED_URL_INVALID", "Paraform returned no resume file", 503);
    const parsed = new URL(signedUrl);
    if (parsed.protocol !== "https:") throw codedError("SOURCE_RESUME_SIGNED_URL_INVALID", "Paraform returned an unsafe resume URL", 503);
    fileResponse = await fetchImpl(signedUrl, { signal: AbortSignal.timeout(30_000) });
    if (!fileResponse.ok) {
      throw codedError("SOURCE_RESUME_DOWNLOAD_FAILED", `resume download failed: ${fileResponse.status}`, 503);
    }
  }
  const declared = Number(fileResponse.headers?.get?.("content-length") || 0);
  if (declared > MAX_RESUME_BYTES) throw codedError("SOURCE_RESUME_TOO_LARGE", "source resume is too large", 413);
  const bytes = Buffer.from(await fileResponse.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_RESUME_BYTES || bytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw codedError("SOURCE_RESUME_NOT_PDF", "source resume is not a readable PDF", 422);
  }
  return bytes;
}

function firstValue(...values) {
  return values.map((item) => text(item, 500)).find(Boolean) || "";
}

function candidateForRenderer(row, profile = {}, linkedin = {}) {
  const candidate = profile?.candidate || {};
  const linked = linkedin?.candidate || linkedin?.profile || linkedin || {};
  const emails = Array.isArray(profile?.emails) ? profile.emails : [];
  return {
    name: firstValue(candidate.name, profile.name, linked.name, row.candidateName) || "Candidate",
    headline: firstValue(linked.headline, profile.headline, candidate.headline),
    email: firstValue(
      ...emails.map((item) => typeof item === "object" ? item.email || item.value : item),
      candidate.email,
      profile.email,
    ),
    phone: firstValue(candidate.phone_number, profile.phone_number, linked.phone_number),
    location: firstValue(linked.location_name, linked.location?.name, profile.location_name, profile.location),
    linkedin: firstValue(candidate.linkedin_url, candidate.linkedin_user, profile.linkedin_url, linked.linkedin_url),
  };
}

function roleForRenderer(row, detailed = {}, basic = {}, requirements = {}) {
  const company = detailed?.company || basic?.company || {};
  return {
    title: firstValue(detailed.title, detailed.name, basic.title, basic.name, row.roleName),
    company: firstValue(company.name, detailed.company_name, basic.company_name, row.companyName),
    description: firstValue(detailed.description, detailed.job_description, basic.description),
    requirements: text(
      typeof requirements === "string" ? requirements : JSON.stringify(requirements || {}),
      12_000,
    ),
  };
}

async function readGenerationInputs(row, deps = {}) {
  const pace = createPacedReader({ paceMs: deps.paceMs ?? 1_400, sleepImpl: deps.sleepImpl || sleep });
  const get = deps.trpcGetImpl || trpcGet;
  const read = (procedure, input) => pace(() => get(procedure, input));
  const profile = await read("candidateUser.getCandidateUserById", { candidate_user_id: row.candidateUserId });
  const linkedin = await read("candidateUser.getLinkedInCandidate", { candidateUserId: row.candidateUserId }).catch(() => null);
  const resume = await pace(() => (deps.getResumeImpl || getResume)(row.candidateUserId));
  const detailed = await read("role.getRoleByIdDetailed", { role_id: row.roleId }).catch(() => null);
  const basic = await read("role.getBasicRoleInfo", { role_id: row.roleId }).catch(() => null);
  const requirements = await read("role.getRoleRequirements", { role_id: row.roleId }).catch(() => null);
  const careerHistory = normalizeCareerHistory(profile, linkedin);
  return {
    profile,
    linkedin,
    resume,
    careerHistory,
    candidate: candidateForRenderer(row, profile, linkedin),
    role: roleForRenderer(row, detailed, basic, requirements),
  };
}

async function callRenderer(payload, { fetchImpl = fetch, env = process.env } = {}) {
  const url = text(env.RESUME_RENDERER_URL, 2_000).replace(/\/+$/u, "");
  const key = text(env.RESUME_RENDERER_KEY, 2_000);
  if (!url || !key) {
    throw codedError("RESUME_RENDERER_NOT_CONFIGURED", "the branded resume renderer is not configured", 503);
  }
  const response = await fetchImpl(`${url}/render`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(150_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.ok !== true) {
    const error = codedError(
      body?.error || "RESUME_RENDER_FAILED",
      body?.error === "NO_CAREER_HISTORY"
        ? "No career history is available, so Resume is disabled for this row."
        : "the branded resume could not be rendered",
      body?.error === "NO_CAREER_HISTORY" ? 409 : 503,
      body?.detail || null,
    );
    throw error;
  }
  const pdf = Buffer.from(String(body.pdfBase64 || ""), "base64");
  if (!pdf.length || pdf.length > MAX_RESUME_BYTES || pdf.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw codedError("RESUME_RENDER_INVALID_PDF", "the renderer returned an invalid PDF", 502);
  }
  if (digest(pdf) !== body.pdfSha256 || digest(body.atsText) !== body.atsSha256) {
    throw codedError("RESUME_RENDER_DIGEST_MISMATCH", "the rendered artifact failed its integrity check", 502);
  }
  return { ...body, pdf, pdfBase64: undefined };
}

function artifactList(ledger) {
  return Array.isArray(ledger?.resumeArtifacts) ? ledger.resumeArtifacts : [];
}

function artifactFromLedger(ledger, artifactId) {
  return artifactList(ledger).find((item) => item.id === artifactId) || null;
}

function publicArtifact(row, artifact) {
  const query = new URLSearchParams({
    key: row.key,
    artifact: artifact.id,
  });
  return {
    id: artifact.id,
    version: artifact.version,
    createdAt: artifact.createdAt,
    source: artifact.source,
    mode: artifact.mode,
    pages: artifact.pages,
    attachedAt: artifact.attachedAt || null,
    pdfUrl: `/api/submissions/resume?${query}&format=pdf`,
    atsUrl: `/api/submissions/resume?${query}&format=ats`,
  };
}

async function storeRenderedArtifact(row, ledger, rendered, wrapper, deps = {}) {
  const artifactId = randomUUID();
  const createdAt = new Date().toISOString();
  const versions = artifactList(ledger).map((item) => Number(item.version) || 0);
  const version = Math.max(0, ...versions) + 1;
  const prefix = `submissions/resumes/v1/${rowHash(row.candidateUserId, row.roleId)}/${version}-${artifactId}`;
  const [pdfPath, atsPath] = await Promise.all([
    putPrivate(`${prefix}.pdf`, rendered.pdf, "application/pdf", deps),
    putPrivate(`${prefix}.txt`, rendered.atsText, "text/plain; charset=utf-8", deps),
  ]);
  const manifestBody = {
    schemaVersion: 1,
    artifactId,
    version,
    createdAt,
    sourceResumeId: wrapper.sourceResumeId || null,
    sourceResumeSha256: wrapper.sourceResumeSha256 || null,
    document: rendered.document,
    rendererManifest: rendered.manifest,
    pdfSha256: rendered.pdfSha256,
    atsSha256: rendered.atsSha256,
  };
  const manifestPath = await putPrivate(
    `${prefix}.json`,
    JSON.stringify(manifestBody),
    "application/json; charset=utf-8",
    deps,
  );
  return {
    id: artifactId,
    version,
    createdAt,
    source: text(rendered.source, 240),
    mode: rendered.mode === "tailored" ? "tailored" : "plain_untailored",
    model: text(rendered.model, 160) || null,
    pages: Number(rendered.pages) || null,
    pdfPath,
    atsPath,
    manifestPath,
    pdfSha256: rendered.pdfSha256,
    atsSha256: rendered.atsSha256,
    sourceResumeIdHash: wrapper.sourceResumeId ? digest(wrapper.sourceResumeId) : null,
  };
}

async function loadStoredManifest(artifact, deps = {}) {
  const bytes = await blobBytes(artifact.manifestPath, deps);
  try { return JSON.parse(bytes.toString("utf8")); } catch {
    throw codedError("RESUME_MANIFEST_INVALID", "the stored resume manifest is invalid", 502);
  }
}

export async function generateResume(body, deps = {}) {
  const row = await liveRow(body, deps);
  const token = await (deps.acquireLockImpl || acquireRowLock)(row.candidateUserId, row.roleId);
  if (!token) throw codedError("SUBMISSION_ROW_BUSY", "another action is already running for this row", 409);
  try {
    const ledger = await (deps.readLedgerImpl || readLedger)(row.candidateUserId, row.roleId);
    let rendered;
    let sourceResumeId = null;
    let sourceResumeSha256 = null;
    if (body.action === "revise") {
      const sourceArtifact = artifactFromLedger(ledger, text(body.artifactId, 160));
      if (!sourceArtifact) throw codedError("RESUME_ARTIFACT_NOT_FOUND", "resume artifact not found", 404);
      const stored = await loadStoredManifest(sourceArtifact, deps);
      rendered = await (deps.rendererImpl || callRenderer)({
        editedDocument: body.document,
        manifest: stored.rendererManifest,
      }, deps);
      sourceResumeId = stored.sourceResumeId || null;
      sourceResumeSha256 = stored.sourceResumeSha256 || null;
    } else {
      const inputs = await (deps.readInputsImpl || readGenerationInputs)(row, deps);
      sourceResumeId = selectResumeId(inputs.resume, inputs.profile);
      const sourcePdf = sourceResumeId
        ? await (deps.downloadResumeImpl || downloadResumeFile)(sourceResumeId, deps)
        : null;
      if (!inputs.careerHistory.length && !sourcePdf) {
        const nextLedger = await (deps.appendLedgerImpl || appendLedgerEvent)(row.candidateUserId, row.roleId, "resume_unavailable_no_career_history", {
          by: body.by,
          resumeUnavailableReason: "no_career_history",
          detail: "Resume disabled because no source career history was available",
        });
        await patchSnapshotLedger(row, nextLedger, deps);
        throw codedError("NO_CAREER_HISTORY", "No career history is available, so Resume is disabled for this row.", 409);
      }
      sourceResumeSha256 = sourcePdf ? digest(sourcePdf) : null;
      rendered = await (deps.rendererImpl || callRenderer)({
        candidate: inputs.candidate,
        role: inputs.role,
        careerHistory: inputs.careerHistory,
        sourceResumePdfBase64: sourcePdf?.toString("base64") || null,
        education: [],
        skills: [],
      }, deps);
    }
    const artifact = await storeRenderedArtifact(row, ledger, rendered, {
      sourceResumeId,
      sourceResumeSha256,
    }, deps);
    const nextArtifacts = [...artifactList(ledger), artifact].slice(-MAX_ARTIFACTS_PER_ROW);
    const nextLedger = await (deps.appendLedgerImpl || appendLedgerEvent)(row.candidateUserId, row.roleId, "resume_rendered", {
      by: body.by,
      resumeArtifacts: nextArtifacts,
      currentResumeArtifactId: artifact.id,
      resumeUnavailableReason: null,
      detail: `Version ${artifact.version} rendered and stored for preview`,
    });
    await patchSnapshotLedger(row, nextLedger, deps);
    return {
      ok: true,
      artifact: publicArtifact(row, artifact),
      document: rendered.document,
      replacementCopy: PROFILE_REPLACEMENT_COPY,
    };
  } finally {
    await (deps.releaseLockImpl || releaseRowLock)(row.candidateUserId, row.roleId, token).catch(() => {});
  }
}

export async function loadResume(body, deps = {}) {
  const row = await liveRow(body, deps);
  const ledger = await (deps.readLedgerImpl || readLedger)(row.candidateUserId, row.roleId);
  const artifact = artifactFromLedger(ledger, text(body.artifactId || ledger?.currentResumeArtifactId, 160));
  if (!artifact) return { ok: true, artifact: null, document: null, replacementCopy: PROFILE_REPLACEMENT_COPY };
  const stored = await loadStoredManifest(artifact, deps);
  return {
    ok: true,
    artifact: publicArtifact(row, artifact),
    document: stored.document,
    replacementCopy: PROFILE_REPLACEMENT_COPY,
  };
}

export async function replaceProfileResume({ candidateUserId, pdfBytes }, deps = {}) {
  if (!pdfBytes?.length || pdfBytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw codedError("RESUME_NOT_PDF", "stored resume is not a PDF", 422);
  }
  const resumeId = randomUUID();
  const get = deps.trpcGetImpl || trpcGet;
  const post = deps.trpcPostWithDatesImpl || trpcPostWithDates;
  const presign = await get("file.getSignedUploadUrl", {
    bucketName: RESUME_BUCKET,
    fileName: resumeId,
  });
  const target = validatePresignTarget(presign, resumeId);
  const form = new FormData();
  for (const [key, value] of Object.entries(target.fields)) form.append(key, String(value));
  form.append("file", new Blob([pdfBytes], { type: "application/pdf" }), `${resumeId}.pdf`);
  const uploaded = await (deps.fetchImpl || fetch)(target.url, {
    method: "POST",
    body: form,
    redirect: "error",
    signal: AbortSignal.timeout(120_000),
  });
  if (!uploaded.ok) throw codedError("RESUME_UPLOAD_FAILED", `Paraform resume upload failed: ${uploaded.status}`, 503);

  let writeError = null;
  try {
    await post("candidateUser.updateCandidateUser", {
      candidate_user_id: candidateUserId,
      fields: {
        resume_id: { value: resumeId, allow_overwrite: true },
        resume_uploaded_at: { value: new Date().toISOString(), allow_overwrite: true },
      },
    }, [RESUME_DATE_FIELD]);
  } catch (error) {
    // A timeout has no write verdict. Never replay this mutation; one exact
    // read-back below decides whether the replacement landed.
    writeError = error;
  }
  const readback = await (deps.getResumeImpl || getResume)(candidateUserId).catch(() => null);
  if (selectResumeId(readback) === resumeId) return { resumeId, writeReturned: !writeError };
  if (writeError) {
    throw codedError(
      "RESUME_ATTACH_AMBIGUOUS",
      "Paraform did not return a write verdict and read-back did not prove the replacement. Do not retry.",
      503,
    );
  }
  throw codedError("RESUME_ATTACH_READBACK_FAILED", "Paraform did not read back the new profile resume", 502);
}

export async function attachResume(body, deps = {}) {
  const row = await liveRow(body, deps);
  if (body.confirmProfileReplacement !== true || body.confirmationCopy !== PROFILE_REPLACEMENT_COPY) {
    throw codedError(
      "RESUME_REPLACEMENT_CONFIRMATION_REQUIRED",
      `Confirm exactly: ${PROFILE_REPLACEMENT_COPY}`,
      409,
    );
  }
  const token = await (deps.acquireLockImpl || acquireRowLock)(row.candidateUserId, row.roleId);
  if (!token) throw codedError("SUBMISSION_ROW_BUSY", "another action is already running for this row", 409);
  try {
    const ledger = await (deps.readLedgerImpl || readLedger)(row.candidateUserId, row.roleId);
    const artifact = artifactFromLedger(ledger, text(body.artifactId, 160));
    if (!artifact || ledger?.currentResumeArtifactId !== artifact?.id) {
      throw codedError("RESUME_ARTIFACT_STALE", "preview the latest resume version before attaching", 409);
    }
    if (artifact.attachedAt) return { ok: true, alreadyAttached: true, artifact: publicArtifact(row, artifact) };
    const stored = await loadStoredManifest(artifact, deps);
    const current = await (deps.getResumeImpl || getResume)(row.candidateUserId);
    const currentResumeId = selectResumeId(current);
    if ((stored.sourceResumeId || null) !== (currentResumeId || null)) {
      throw codedError(
        "RESUME_PROFILE_CHANGED",
        "the candidate's profile resume changed after generation; regenerate before attaching",
        409,
      );
    }
    const pdfBytes = await blobBytes(artifact.pdfPath, deps);
    let replacement;
    try {
      replacement = await (deps.replaceProfileImpl || replaceProfileResume)({
        candidateUserId: row.candidateUserId,
        pdfBytes,
      }, deps);
    } catch (error) {
      if (error?.code === "RESUME_ATTACH_AMBIGUOUS") {
        const nextLedger = await (deps.appendLedgerImpl || appendLedgerEvent)(row.candidateUserId, row.roleId, "resume_profile_replace_ambiguous", {
          by: body.by,
          detail: "No retry: write verdict and read-back were both inconclusive",
        });
        await patchSnapshotLedger(row, nextLedger, deps);
      }
      throw error;
    }
    const attachedAt = new Date().toISOString();
    const nextArtifacts = artifactList(ledger).map((item) => item.id === artifact.id
      ? { ...item, attachedAt, attachedResumeIdHash: digest(replacement.resumeId) }
      : item);
    const attachedArtifact = nextArtifacts.find((item) => item.id === artifact.id);
    const nextLedger = await (deps.appendLedgerImpl || appendLedgerEvent)(row.candidateUserId, row.roleId, "resume_profile_replaced_verified", {
      by: body.by,
      resumeArtifacts: nextArtifacts,
      currentResumeArtifactId: artifact.id,
      attachedResumeIdHash: digest(replacement.resumeId),
      resumeAttachedAt: attachedAt,
      detail: `Version ${artifact.version} replaced the profile resume and read back exactly`,
    });
    await patchSnapshotLedger(row, nextLedger, deps);
    return { ok: true, attached: true, artifact: publicArtifact(row, attachedArtifact) };
  } finally {
    await (deps.releaseLockImpl || releaseRowLock)(row.candidateUserId, row.roleId, token).catch(() => {});
  }
}

export async function readArtifactForHttp(body, deps = {}) {
  const row = await liveRow(body, deps);
  const ledger = await (deps.readLedgerImpl || readLedger)(row.candidateUserId, row.roleId);
  const artifact = artifactFromLedger(ledger, text(body.artifact, 160));
  if (!artifact) throw codedError("RESUME_ARTIFACT_NOT_FOUND", "resume artifact not found", 404);
  const format = body.format === "ats" ? "ats" : "pdf";
  const bytes = await blobBytes(format === "ats" ? artifact.atsPath : artifact.pdfPath, deps);
  return {
    bytes,
    contentType: format === "ats" ? "text/plain; charset=utf-8" : "application/pdf",
    filename: format === "ats" ? `raydar-resume-v${artifact.version}.txt` : `raydar-resume-v${artifact.version}.pdf`,
  };
}

export { liveRow, readGenerationInputs, callRenderer, blobBytes, putPrivate };
