import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  GROUNDING_PROMPT_VERSION,
  GROUNDING_VALIDATOR_MODEL,
} from "../api/submissions-v2/_lib/models/openai-validator.mjs";
import {
  STRATEGIST_PRIMARY_MODEL,
  STRATEGIST_PROMPT_VERSION,
} from "../api/submissions-v2/_lib/models/anthropic-strategist.mjs";
import { runResumePreparation } from "../api/submissions-v2/_lib/resume/pipeline.mjs";
import {
  extractPdfWithRenderer,
  renderResumeWithService,
} from "../api/submissions-v2/_lib/resume/pipeline-renderer.mjs";
import {
  canonicalJson,
  normalizeSourceBundle,
  sha256,
} from "../api/submissions-v2/_lib/resume/source-bundle.mjs";
import { resumeAstDigest } from "../resume-renderer-v2/index.mjs";
import { CANDIDATES, ROLES } from "./scenarios.mjs";

// Capture Node's transport before the preview runtime installs its deny-by-default
// global network guard. This transport is used only with the fixed loopback renderer.
const nativeFetch = globalThis.fetch?.bind(globalThis);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RENDERER_APP = resolve(ROOT, "submissions-preview/renderer.py");
const DEFAULT_RENDERER_PYTHON = resolve(homedir(), ".raydar/submissions-rebuild/renderer-venv/bin/python");
const DEFAULT_RENDERER_ORIGIN = "http://127.0.0.1:4526";
const SOURCE_FACTS = Object.freeze({
  originalHeadline: "Synthetic candidate-original resume",
  headline: "Software Engineer",
  employer: "Sample Systems",
  roleAndDates: "Software Engineer | 2021-2025",
  outcome: "Built reliable cloud services used by 20 teams.",
  operations: "Improved deployment reliability and incident response.",
  skills: "Python, TypeScript, distributed systems",
});

const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

function fixedRendererOrigin(value) {
  const raw = String(value || DEFAULT_RENDERER_ORIGIN).trim().replace(/\/+$/u, "");
  let url;
  try { url = new URL(raw); }
  catch { throw new Error("The preview renderer must use its fixed loopback origin."); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !new Set(["4526", "4527"]).has(url.port)
    || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("The preview renderer must use its dedicated loopback port.");
  }
  return url.origin;
}

function fixedRendererPython(value) {
  const pathname = resolve(String(value || DEFAULT_RENDERER_PYTHON));
  if (pathname !== DEFAULT_RENDERER_PYTHON) {
    throw new Error("The preview renderer Python is outside its dedicated local environment.");
  }
  return pathname;
}

function originalResumeAst(candidate) {
  const claimId = `synthetic-original-${candidate.id}`;
  return {
    claimId,
    ast: {
      schema_version: "raydar.resume.ast.v1",
      candidate: {
        name: { id: "candidate-name", text: candidate.name, claim_ids: [claimId], emphasis: [] },
        headline: { id: "candidate-headline", text: SOURCE_FACTS.originalHeadline, claim_ids: [claimId], emphasis: [] },
        contact: [],
      },
      summary: null,
      sections: [
        {
          id: "section-experience",
          title: "Experience",
          kind: "experience",
          placement: "main",
          entries: [{
            id: "entry-sample-systems",
            header: [
              { id: "sample-company", text: SOURCE_FACTS.employer, claim_ids: [claimId], emphasis: [] },
              { id: "sample-role", text: SOURCE_FACTS.roleAndDates, claim_ids: [claimId], emphasis: [] },
            ],
            body: [
              { id: "sample-outcome", text: SOURCE_FACTS.outcome, claim_ids: [claimId], emphasis: ["20 teams"] },
              { id: "sample-operations", text: SOURCE_FACTS.operations, claim_ids: [claimId], emphasis: [] },
            ],
          }],
        },
        {
          id: "section-skills",
          title: "Core Skills",
          kind: "skills",
          placement: "sidebar",
          entries: [{
            id: "entry-skills",
            header: [{ id: "sample-skills", text: SOURCE_FACTS.skills, claim_ids: [claimId], emphasis: [] }],
            body: [],
          }],
        },
      ],
      page_preference: 1,
    },
  };
}

function modelDocument(candidate, claimId) {
  return {
    schema_version: "raydar.resume.ast.v1",
    candidate: {
      name: { id: "candidate-name", text: candidate.name, claim_ids: [claimId], emphasis: [] },
      headline: { id: "candidate-headline", text: SOURCE_FACTS.headline, claim_ids: [claimId], emphasis: [] },
      contact: [],
    },
    summary: null,
    sections: [
      {
        id: "section-experience",
        title: "Experience",
        kind: "experience",
        placement: "main",
        entries: [{
          id: "entry-sample-systems",
          header: [
            { id: "sample-company", text: SOURCE_FACTS.employer, claim_ids: [claimId], emphasis: [] },
            { id: "sample-role", text: SOURCE_FACTS.roleAndDates, claim_ids: [claimId], emphasis: [] },
          ],
          body: [
            { id: "sample-outcome", text: SOURCE_FACTS.outcome, claim_ids: [claimId], emphasis: ["20 teams"] },
            { id: "sample-operations", text: SOURCE_FACTS.operations, claim_ids: [claimId], emphasis: [] },
          ],
        }],
      },
      {
        id: "section-skills",
        title: "Core Skills",
        kind: "skills",
        placement: "sidebar",
        entries: [{
          id: "entry-skills",
          header: [{ id: "sample-skills", text: SOURCE_FACTS.skills, claim_ids: [claimId], emphasis: [] }],
          body: [],
        }],
      },
    ],
    page_preference: 1,
  };
}

function missingSource(key, capturedAt) {
  return {
    key,
    status: "missing",
    origin: "not_applicable",
    locator: `preview:${key}`,
    capturedAt,
    metadata: { readOutcome: "confirmed_empty" },
  };
}

function classificationFor(event) {
  const text = String(event?.candidate_authored_text || "").trim();
  const roles = Array.isArray(event?.offered_roles) ? event.offered_roles : [];
  if (!text || !roles.length) {
    throw Object.assign(new Error("The synthetic reply is missing candidate text or an exact role."), {
      code: "classification_failed",
      attempts: [{ model: "preview-deterministic-v1", outcome: "failed", reason: "preview_input_incomplete", cost_usd: 0 }],
      spent: 0,
    });
  }
  const negative = /^no\b|not interested|no thank/iu.test(text);
  const question = /\?/u.test(text) || /\b(?:salary|compensation|location|remote|visa|sponsor)\b/iu.test(text);
  const label = negative ? "not_interested" : question ? "needs_review" : "interested";
  return {
    decisions: roles.map((role) => ({
      role_id: role.role_id,
      label,
      quote: text,
      review_reason: label === "needs_review" ? "candidate_question" : null,
      negative_reason: label === "not_interested" ? text : null,
    })),
    attempts: [{ model: "preview-deterministic-v1", outcome: "accepted", reason: null, cost_usd: 0 }],
    cost_usd: 0,
    duration_ms: 0,
  };
}

export async function createPreviewProviders({ sql, env, blobs, config } = {}) {
  if (typeof sql !== "function") throw new TypeError("preview sql is required");
  if (!env || typeof env !== "object") throw new TypeError("preview env is required");
  if (!blobs?.putPrivateObject || !blobs?.readPrivateObject) throw new TypeError("preview private storage is required");
  if (typeof nativeFetch !== "function") throw new Error("The native loopback renderer transport is unavailable.");

  const rendererOrigin = fixedRendererOrigin(config?.rendererOrigin);
  const rendererPython = fixedRendererPython(config?.pythonPath);
  const rendererKey = randomBytes(32).toString("base64url");
  Object.assign(env, {
    SUBMISSIONS_V2_RENDERER_URL: rendererOrigin,
    SUBMISSIONS_V2_RENDERER_KEY: rendererKey,
  });
  await Promise.all([
    access(RENDERER_APP, fsConstants.R_OK),
    access(rendererPython, fsConstants.X_OK),
  ]);

  const rendererFetch = (input, init = {}) => {
    let url;
    try { url = new URL(typeof input === "string" || input instanceof URL ? input : input?.url); }
    catch { throw Object.assign(new Error("The preview blocked a malformed provider request."), { code: "preview_network_denied", retryable: false }); }
    if (url.origin !== rendererOrigin) {
      throw Object.assign(new Error("The preview blocked an external provider request."), { code: "preview_network_denied", retryable: false });
    }
    return nativeFetch(input, { ...init, redirect: "error" });
  };

  const renderer = spawn(rendererPython, [RENDERER_APP], {
    cwd: ROOT,
    env: {
      PATH: "/usr/bin:/bin",
      PORT: new URL(rendererOrigin).port,
      SUBMISSIONS_V2_RENDERER_KEY: rendererKey,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let rendererError = null;
  let stderr = "";
  renderer.on("error", (error) => { rendererError = error; });
  renderer.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_000); });

  async function ready({ timeoutMs = 120_000 } = {}) {
    const deadline = Date.now() + Math.max(1_000, Number(timeoutMs) || 120_000);
    let lastError = null;
    while (Date.now() < deadline) {
      if (rendererError) throw rendererError;
      if (renderer.exitCode !== null) {
        throw new Error(`The preview renderer exited during startup.${stderr ? ` ${stderr.trim()}` : ""}`);
      }
      try {
        const response = await rendererFetch(`${rendererOrigin}/health`, { signal: AbortSignal.timeout(2_000) });
        const health = await response.json();
        if (response.ok && health?.ok === true && health?.service === "raydar-resume-renderer-v2"
          && health?.authConfigured === true) {
          const challenge = await rendererFetch(`${rendererOrigin}/extract-v2`, {
            method: "POST",
            headers: { authorization: `Bearer ${rendererKey}`, "content-type": "application/json" },
            body: canonicalJson({ schema_version: "raydar.resume.extract-request.v1", pdf_base64: "bm90IGEgcGRm" }),
            signal: AbortSignal.timeout(2_000),
          });
          const challengeBody = await challenge.json();
          if (challenge.status !== 422 || challengeBody?.error !== "SOURCE_PDF_MAGIC_INVALID") {
            throw new Error("The process on the preview renderer port did not prove this startup identity.");
          }
          await sleep(25);
          if (renderer.exitCode !== null) throw new Error("The preview renderer lost its loopback port during startup.");
          return health;
        }
      } catch (error) { lastError = error; }
      await sleep(100);
    }
    throw new Error(`The preview renderer did not become ready.${lastError?.message ? ` ${lastError.message}` : ""}`);
  }

  async function close() {
    if (renderer.exitCode !== null) return;
    renderer.kill("SIGTERM");
    const exited = await Promise.race([
      new Promise((resolveExit) => renderer.once("exit", () => resolveExit(true))),
      sleep(2_000).then(() => false),
    ]);
    if (!exited && renderer.exitCode === null) renderer.kill("SIGKILL");
  }

  let health;
  try { health = await ready(); }
  catch (error) { await close(); throw error; }
  const pdfs = new Map();

  async function syntheticOriginalPdf(candidate) {
    if (!pdfs.has(candidate.id)) {
      pdfs.set(candidate.id, (async () => {
        const source = originalResumeAst(candidate);
        const rendered = await renderResumeWithService({
          renderId: `preview-original-${candidate.id}`,
          ast: source.ast,
          validatedClaimIds: [source.claimId],
          expectedAstSha256: resumeAstDigest(source.ast),
          practice: false,
        }, { env, fetchImpl: rendererFetch });
        return rendered.pdfBytes;
      })());
    }
    return pdfs.get(candidate.id);
  }

  async function extractPdf(bytes, options = {}) {
    return extractPdfWithRenderer(bytes, { ...options, env, fetchImpl: rendererFetch });
  }

  async function collectSources({ candidateUserId, roleId, knownRaydarDigests = [] } = {}, options = {}) {
    const candidate = CANDIDATES.find((item) => item.id === candidateUserId);
    const role = ROLES.find((item) => item.id === roleId);
    if (!candidate) throw Object.assign(new Error("Unknown synthetic candidate."), { code: "preview_candidate_unknown", retryable: false });
    if (!role) throw Object.assign(new Error("Unknown synthetic role."), { code: "preview_role_unknown", retryable: false });
    const missingOriginal = (await sql`select value from preview.provider_state where key=${`missing_original:${candidate.id}`}`)[0]?.value === true;
    const pdf = missingOriginal ? null : await syntheticOriginalPdf(candidate);
    const extracted = missingOriginal ? null : await (options.extractResumeImpl || extractPdf)(pdf);
    const capturedAt = new Date(typeof options.now === "function" ? options.now() : Date.now()).toISOString();
    return normalizeSourceBundle({
      candidateUserId,
      roleId,
      knownRaydarDigests,
      capturedAt,
      sources: [
        missingOriginal ? missingSource("candidate_original_resume", capturedAt) : {
          key: "candidate_original_resume",
          status: "present",
          origin: "candidate_original",
          sourceId: `preview-original-${candidate.id}`,
          locator: `preview:candidate:${candidate.id}:original-resume`,
          capturedAt,
          content: pdf,
          normalizedText: extracted.text,
          metadata: { readable: true, pageCount: extracted.pageCount, synthetic: true },
        },
        missingSource("candidate_call", capturedAt),
        missingSource("candidate_linkedin", capturedAt),
        missingSource("candidate_preferences", capturedAt),
        missingSource("recruiter_supplements", capturedAt),
        {
          key: "role_record",
          status: "present",
          origin: "not_applicable",
          sourceId: role.id,
          locator: `preview:role:${role.id}`,
          capturedAt,
          text: `${role.title} at ${role.company}`,
          metadata: { active: role.active, synthetic: true },
        },
        {
          key: "role_context",
          status: "present",
          origin: "not_applicable",
          sourceId: role.id,
          locator: `preview:role:${role.id}:context`,
          capturedAt,
          text: `${role.company} is seeking a ${role.title} to build reliable products.`,
          metadata: { synthetic: true },
        },
        {
          key: "company_context",
          status: "present",
          origin: "not_applicable",
          sourceId: role.id,
          locator: `preview:company:${role.company}`,
          capturedAt,
          text: `${role.company} is a synthetic company used only for this local preview.`,
          metadata: { synthetic: true },
        },
        {
          key: "role_intake",
          status: "present",
          origin: "not_applicable",
          sourceId: role.id,
          locator: `preview:role:${role.id}:intake`,
          capturedAt,
          text: `Prioritize reliable software delivery for the ${role.title} role.`,
          metadata: { synthetic: true },
        },
      ],
    });
  }

  async function strategist({ bundle, ledger }) {
    const candidateId = bundle?.pair?.candidateUserId;
    const failure = (await sql`select value from preview.provider_state where key=${`fail_resume:${candidateId}`}`)[0]?.value;
    if (failure === true) {
      throw Object.assign(new Error("The synthetic resume model failed as requested."), {
        code: "preview_resume_failure",
        safeMessage: "The synthetic resume model failed as requested.",
        retryable: false,
      });
    }
    const candidate = CANDIDATES.find((item) => item.id === candidateId);
    const claimId = ledger?.claims?.[0]?.claimId;
    if (!candidate || !claimId) throw new Error("Synthetic resume evidence is incomplete.");
    const document = modelDocument(candidate, claimId);
    const audit = {
      provider: "preview-deterministic",
      model: STRATEGIST_PRIMARY_MODEL,
      effort: "high",
      promptVersion: STRATEGIST_PROMPT_VERSION,
      durationMs: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      providerRequestId: null,
      stopReason: "synthetic",
      synthetic: true,
    };
    return {
      strategy: {
        schema_version: "raydar.resume.strategy.v1",
        target_narrative: "Present the candidate's synthetic software delivery evidence.",
        document,
        selected_claim_ids: [claimId],
        deliberate_omissions: [],
      },
      audit,
      attempts: [audit],
      fallbackReason: null,
    };
  }

  async function validator(draftClaims) {
    const claims = draftClaims.map((claim) => ({
      ...claim,
      validatedEvidenceIds: [...new Set(claim.evidence.map((item) => item.evidenceId))],
    }));
    const audit = {
      provider: "preview-deterministic",
      model: GROUNDING_VALIDATOR_MODEL,
      effort: "high",
      promptVersion: GROUNDING_PROMPT_VERSION,
      durationMs: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
      providerRequestId: null,
      synthetic: true,
    };
    return {
      claims,
      removed: [],
      history: [{
        round: 0,
        batch: 0,
        audit,
        attempts: [audit],
        validation: {
          schema_version: "raydar.resume.grounding-validation.v1",
          results: claims.map((claim) => ({
            claim_id: claim.id,
            verdict: "supported",
            evidence_ids: claim.validatedEvidenceIds,
            rewrite: null,
            reason_code: "direct_support",
          })),
        },
      }],
    };
  }

  async function runResume(context, options = {}) {
    return runResumePreparation(context, {
      ...options,
      env,
      fetchImpl: rendererFetch,
      collectSources,
      strategist,
      validator,
      renderer: (request, rendererOptions = {}) => renderResumeWithService(request, {
        ...rendererOptions,
        env,
        fetchImpl: rendererFetch,
      }),
      extractPdf,
      putObject: blobs.putPrivateObject.bind(blobs),
      readObject: blobs.readPrivateObject.bind(blobs),
    });
  }

  async function exactRole(roleId) {
    const rows = await sql`
      select role_id, company_name, role_title, search_key, active, destination_url,
             owner_email, provider_updated_at, last_confirmed_at, source_digest
        from submissions_v2.role_index where role_id=${roleId}
    `;
    const row = rows[0];
    const confirmedAt = new Date().toISOString();
    if (!row || row.active !== true) return { role: null, active: false, confirmed_at: confirmedAt };
    return {
      active: true,
      confirmed_at: confirmedAt,
      role: {
        role_id: row.role_id,
        company_name: row.company_name,
        role_title: row.role_title,
        search_key: row.search_key,
        active: true,
        paraform_url: row.destination_url,
        owner_email: row.owner_email,
        provider_updated_at: row.provider_updated_at,
        source_digest: row.source_digest,
      },
    };
  }

  async function proofReader(pairs, { now = new Date() } = {}) {
    const proofs = [];
    for (const pair of pairs || []) {
      const key = `proof:${pair.candidate_user_id}:${pair.role_id}`;
      const value = (await sql`select value from preview.provider_state where key=${key}`)[0]?.value;
      if (!value) continue;
      if (value.candidateUserId !== pair.candidate_user_id || value.roleId !== pair.role_id
        || typeof value.applicationId !== "string") {
        throw Object.assign(new Error("Synthetic submission proof did not match the exact candidate-role pair."), {
          code: "submission_application_identity_conflict",
          retryable: true,
        });
      }
      if (!new Set(["SUBMITTED", "INTERVIEWING", "INTERVIEW", "ACCEPTED", "REJECTED", "HIRED", "OFFER", "OFFERED"]).has(String(value.status || "").toUpperCase())) continue;
      const observedAt = Number.isFinite(Date.parse(value.submittedAt)) ? new Date(value.submittedAt).toISOString() : new Date(now).toISOString();
      const authoritativePath = "preview.provider_state";
      proofs.push({
        pairId: pair.id,
        applicationId: value.applicationId,
        authoritativePath,
        evidenceDigest: sha256(canonicalJson({ authoritativePath, ...value })),
        observedAt,
        checkedAt: new Date(now).toISOString(),
      });
    }
    return proofs;
  }

  async function notify(text, { destinationId } = {}) {
    const digest = sha256(String(text));
    const receipt = `preview-notification-${digest.slice(0, 24)}`;
    const value = { receipt, destinationId: String(destinationId || ""), text: String(text), deliveredAt: new Date().toISOString() };
    await sql`
      insert into preview.provider_state(key,value) values (${`notification:${digest}`},${sql.json(value)})
      on conflict(key) do update set value=excluded.value,updated_at=clock_timestamp()
    `;
    return { receipt, channel: value.destinationId };
  }

  return {
    classifier: async (event) => classificationFor(event),
    runResume,
    collectSources,
    extractPdf,
    proofReader,
    exactRole,
    notify,
    ready,
    close,
    renderer: { origin: rendererOrigin, health },
  };
}

export const previewProviderInternals = Object.freeze({
  classificationFor,
  fixedRendererOrigin,
  fixedRendererPython,
  missingSource,
  modelDocument,
  originalResumeAst,
});
