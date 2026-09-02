import { ResumeContractError, canonicalJson, normalizeEvidenceText, sha256 } from "./source-bundle.mjs";
import { ResumePipelineError } from "./pipeline-runtime.mjs";

const RENDER_REQUEST_VERSION = "raydar.resume.render-request.v1";
const RENDER_RESULT_VERSION = "raydar.resume.render-result.v1";
const EXTRACT_REQUEST_VERSION = "raydar.resume.extract-request.v1";
const EXTRACT_RESULT_VERSION = "raydar.resume.extract-result.v1";
const MAX_RENDER_RESPONSE_BYTES = 22 * 1024 * 1024;

function configuration(env = process.env) {
  const baseUrl = String(env.SUBMISSIONS_V2_RENDERER_URL || "").trim().replace(/\/+$/u, "");
  const key = String(env.SUBMISSIONS_V2_RENDERER_KEY || "").trim();
  let url = null;
  try { url = new URL(baseUrl); } catch {}
  const loopbackHttp = url?.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if ((!url || (url.protocol !== "https:" && !loopbackHttp) || url.username || url.password) || key.length < 32) {
    throw new ResumePipelineError("resume_renderer_not_configured", "The isolated resume renderer is not configured.");
  }
  return { baseUrl, key };
}

async function jsonRequest(path, payload, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  signal,
  timeoutMs = 60_000,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new ResumePipelineError("resume_renderer_transport_missing", "The isolated resume renderer transport is unavailable.");
  }
  const { baseUrl, key } = configuration(env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("renderer_deadline_exceeded")), Math.max(1_000, timeoutMs));
  const relayAbort = () => controller.abort(signal?.reason || new Error("generation_aborted"));
  if (signal) {
    if (signal.aborted) relayAbort();
    else signal.addEventListener("abort", relayAbort, { once: true });
  }
  try {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: canonicalJson(payload),
      signal: controller.signal,
    });
    const declared = Number(response.headers?.get?.("content-length") || 0);
    if (declared > MAX_RENDER_RESPONSE_BYTES) {
      throw new ResumePipelineError("resume_renderer_response_too_large", "The isolated resume renderer returned an oversized response.");
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RENDER_RESPONSE_BYTES) {
      throw new ResumePipelineError("resume_renderer_response_too_large", "The isolated resume renderer returned an oversized response.");
    }
    let body;
    try { body = JSON.parse(text); }
    catch {
      throw new ResumePipelineError("resume_renderer_response_invalid", "The isolated resume renderer returned invalid JSON.", { retryable: response.status >= 500 });
    }
    if (!response.ok || body?.ok !== true) {
      throw new ResumePipelineError(body?.error || `resume_renderer_http_${response.status}`, "The isolated resume renderer could not complete this stage.", {
        retryable: response.status >= 500 || response.status === 429,
      });
    }
    return body;
  } catch (error) {
    if (error instanceof ResumePipelineError) throw error;
    throw new ResumePipelineError("resume_renderer_transport_failed", "The isolated resume renderer request failed.", {
      retryable: !signal?.aborted,
      cause: error,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", relayAbort);
  }
}

function decodedPdf(value) {
  let bytes;
  try { bytes = Buffer.from(String(value || ""), "base64"); }
  catch { bytes = Buffer.alloc(0); }
  if (bytes.length < 8 || bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new ResumeContractError("RESUME_PDF_INVALID", "The renderer response did not contain a readable PDF");
  }
  return bytes;
}

export async function renderResumeWithService({
  renderId,
  ast,
  validatedClaimIds,
  expectedAstSha256,
  practice = false,
}, options = {}) {
  const body = await jsonRequest("/render-v2", {
    schema_version: RENDER_REQUEST_VERSION,
    render_id: String(renderId || ""),
    ast,
    validated_claim_ids: validatedClaimIds,
    expected_ast_sha256: expectedAstSha256,
    practice: Boolean(practice),
  }, options);
  if (body.schemaVersion !== RENDER_RESULT_VERSION || body.astSha256 !== expectedAstSha256 || body.practice !== Boolean(practice)) {
    throw new ResumePipelineError("resume_renderer_contract_mismatch", "The isolated resume renderer returned the wrong contract or document.");
  }
  const pdfBytes = decodedPdf(body.pdfBase64);
  const atsText = typeof body.atsText === "string" ? body.atsText : "";
  const pdfExtractedText = typeof body.pdfExtractedText === "string" ? body.pdfExtractedText : "";
  if (!normalizeEvidenceText(atsText) || !normalizeEvidenceText(pdfExtractedText)
    || sha256(pdfBytes) !== body.pdfSha256
    || sha256(atsText) !== body.atsSha256
    || sha256(pdfExtractedText) !== body.pdfTextSha256) {
    throw new ResumePipelineError("resume_renderer_digest_mismatch", "The isolated resume renderer response failed integrity validation.");
  }
  return Object.freeze({
    ...body,
    pdfBytes,
    atsText,
    pdfExtractedText,
  });
}

export async function extractPdfWithRenderer(pdfBytes, options = {}) {
  const bytes = Buffer.isBuffer(pdfBytes) ? pdfBytes : Buffer.from(pdfBytes || []);
  if (bytes.length < 8 || bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new ResumePipelineError("source_pdf_invalid", "The candidate resume is not a readable PDF.");
  }
  const body = await jsonRequest("/extract-v2", {
    schema_version: EXTRACT_REQUEST_VERSION,
    pdf_base64: bytes.toString("base64"),
  }, options);
  const text = normalizeEvidenceText(body.text);
  if (body.schemaVersion !== EXTRACT_RESULT_VERSION || body.pdfSha256 !== sha256(bytes) || !text) {
    throw new ResumePipelineError("resume_extract_contract_mismatch", "The candidate resume extraction failed integrity validation.");
  }
  return { text, pageCount: Number(body.pageCount) || null };
}

export const pipelineRendererInternals = Object.freeze({
  EXTRACT_REQUEST_VERSION,
  EXTRACT_RESULT_VERSION,
  RENDER_REQUEST_VERSION,
  RENDER_RESULT_VERSION,
  configuration,
  decodedPdf,
});
