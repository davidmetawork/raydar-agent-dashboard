import {
  ResumeContractError,
  deepFreeze,
  normalizeEvidenceText,
  sha256,
} from "../api/submissions-v2/_lib/resume/source-bundle.mjs";
import {
  RESUME_RENDERER_VERSION,
  RESUME_TEMPLATE_VERSION,
  TEMPLATE_TOKENS,
  assertResumeAst,
  createRenderPlan,
  resumeAstDigest,
} from "./contract.mjs";
import { renderAtsText, renderResumeHtml } from "./template.mjs";

export * from "./contract.mjs";
export * from "./manifest.mjs";
export * from "./template.mjs";

export function prepareResumeRender(rawAst, {
  allowedClaimIds,
  selectedClaimIds,
  officialBrandAsset,
  practice = false,
} = {}) {
  const ast = assertResumeAst(rawAst, { allowedClaimIds, selectedClaimIds });
  const plan = createRenderPlan(ast);
  const rendered = renderResumeHtml(ast, plan, { officialBrandAsset, practice });
  const ats = renderAtsText(ast);
  return deepFreeze({
    ast,
    astSha256: resumeAstDigest(ast),
    plan,
    html: rendered.html,
    htmlSha256: rendered.htmlSha256,
    atsText: ats.atsText,
    atsSha256: ats.atsSha256,
    brandAssetId: rendered.brandAssetId,
    brandAssetSha256: rendered.brandAssetSha256,
    templateVersion: RESUME_TEMPLATE_VERSION,
    rendererVersion: RESUME_RENDERER_VERSION,
    practice: Boolean(practice),
  });
}

function escapedPattern(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function substantiveTokens(value, candidateName = "") {
  let normalized = normalizeEvidenceText(value)
    .replace(/Practice\s+[—-]\s+not for submission/giu, " ")
    .replace(/EARLIER EXPERIENCE\s*\|\s*CONTINUED/giu, " ")
    .replace(/\bEarlier experience\b/giu, " ")
    .replace(/\bContinued\b/giu, " ")
    .replace(/Prepared by Raydar/giu, " ")
    .replace(/Page\s+\d+\s+of\s+\d+/giu, " ")
    .replace(/\bRaydar\b/giu, " ");
  if (candidateName) normalized = normalized.replace(new RegExp(escapedPattern(candidateName), "giu"), " ");
  return normalized.toLocaleLowerCase("en-US")
    .match(/[\p{L}\p{N}]+(?:[.+#/-][\p{L}\p{N}]+)*/gu) || [];
}

function tokenBag(value, candidateName = "") {
  const bag = new Map();
  for (const token of substantiveTokens(value, candidateName)) bag.set(token, (bag.get(token) || 0) + 1);
  return bag;
}

function sortedBag(bag) {
  return [...bag.entries()].filter(([, count]) => count > 0).sort(([left], [right]) => left.localeCompare(right));
}

export function assertAtsParity(pdfExtractedText, atsText) {
  const candidateName = normalizeEvidenceText(atsText).split("\n", 1)[0] || "";
  const pdfBag = tokenBag(pdfExtractedText, candidateName);
  const atsBag = tokenBag(atsText, candidateName);
  const normalizedPdfBag = sortedBag(pdfBag);
  const normalizedAtsBag = sortedBag(atsBag);
  if (JSON.stringify(normalizedPdfBag) !== JSON.stringify(normalizedAtsBag)) {
    throw new ResumeContractError("RESUME_ATS_PARITY_FAILED", "Normalized PDF text and ATS text differ substantively", {
      pdfTokenDigest: sha256(JSON.stringify(normalizedPdfBag)),
      atsTokenDigest: sha256(JSON.stringify(normalizedAtsBag)),
    });
  }
  return true;
}

export function assertVisualPreflight(plan, result) {
  if (!result || typeof result !== "object") {
    throw new ResumeContractError("RESUME_PREFLIGHT_REQUIRED", "A renderer preflight result is required");
  }
  const pageCount = Number(result.pageCount);
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > TEMPLATE_TOKENS.page.maximumPages) {
    throw new ResumeContractError("RESUME_PAGE_LIMIT_EXCEEDED", "Rendered resume must contain one or two pages", { pageCount });
  }
  if (pageCount !== plan.expectedPages) {
    throw new ResumeContractError("RESUME_PAGE_COUNT_MISMATCH", "Actual page count differs from deterministic render plan", {
      expected: plan.expectedPages,
      actual: pageCount,
    });
  }
  const occupancies = Array.isArray(result.pageOccupancies) ? result.pageOccupancies.map(Number) : [];
  if (occupancies.length !== pageCount || occupancies.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
    throw new ResumeContractError("RESUME_OCCUPANCY_INVALID", "Renderer must report printable occupancy for every page");
  }
  if (pageCount === 2 && occupancies[1] < TEMPLATE_TOKENS.page.pageTwoMinimumOccupancy) {
    throw new ResumeContractError("RESUME_PAGE_TWO_UNDERFILLED", "Rendered page two contains too little real resume content", {
      occupancy: occupancies[1],
    });
  }
  const failures = [
    [result.hasOverflow, "overflow"],
    [result.hasClipping, "clipping"],
    [result.hasOverlap, "overlap"],
    [result.hasMissingGlyphs, "missing_glyphs"],
  ].filter(([value]) => value === true).map(([, label]) => label);
  if (failures.length) {
    throw new ResumeContractError("RESUME_VISUAL_PREFLIGHT_FAILED", "Rendered resume failed visual preflight", { failures });
  }
  if (result.fontsEmbedded !== true || result.textSelectable !== true) {
    throw new ResumeContractError("RESUME_PDF_ACCESSIBILITY_FAILED", "Rendered PDF needs embedded fonts and selectable text");
  }
  return deepFreeze({ pageCount, pageOccupancies: occupancies });
}

export function verifyRenderedPdf({ pdfBytes, pdfExtractedText, atsText, plan, preflight }) {
  const bytes = Buffer.isBuffer(pdfBytes) ? pdfBytes : Buffer.from(pdfBytes || []);
  if (bytes.length < 8 || !bytes.subarray(0, 5).equals(Buffer.from("%PDF-", "ascii"))) {
    throw new ResumeContractError("RESUME_PDF_INVALID", "Renderer did not produce a readable PDF payload");
  }
  assertAtsParity(pdfExtractedText, atsText);
  const checkedPreflight = assertVisualPreflight(plan, preflight);
  return deepFreeze({
    pdfSha256: sha256(bytes),
    pdfByteLength: bytes.length,
    pdfTextSha256: sha256(normalizeEvidenceText(pdfExtractedText)),
    preflight: checkedPreflight,
  });
}
