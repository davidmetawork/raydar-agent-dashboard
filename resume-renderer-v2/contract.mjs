import {
  ResumeContractError,
  canonicalJson,
  deepFreeze,
  normalizeEvidenceText,
  sha256,
} from "../api/submissions-v2/_lib/resume/source-bundle.mjs";

export const RESUME_TEMPLATE_VERSION = "raydar-resume-template-v0.1";
export const RESUME_RENDERER_VERSION = "raydar-resume-renderer-v2.1";

export const TEMPLATE_TOKENS = deepFreeze({
  page: {
    size: "US-Letter",
    widthIn: 8.5,
    heightIn: 11,
    marginIn: 0.55,
    maximumPages: 2,
    pageTwoMinimumOccupancy: 0.4,
  },
  typography: {
    displayFamily: "PP Grafier Display",
    bodyFamily: "Inter",
    primaryBodyPt: 9.2,
    supportingPt: 7.8,
    lineHeightRatio: 1.28,
    letterSpacingEm: 0,
  },
  colors: {
    ink: "#211f26",
    muted: "#6f6974",
    beigeHeader: "#f3ede3",
    warmSidebar: "#faf7f0",
    violet: "#7f72ff",
    orange: "#f06f3c",
    white: "#ffffff",
  },
  brandAssetId: "raydar-official-lockup-black-v1",
});

const ALLOWED_SECTION_KINDS = new Set([
  "experience",
  "projects",
  "education",
  "skills",
  "details",
  "metrics",
  "custom",
]);
const BANNED_CONTENT_PATTERNS = [
  /why this candidate/iu,
  /why page two/iu,
  /fit score/iu,
  /match score/iu,
  /compression applied/iu,
  /evidence (?:id|ledger|status)/iu,
  /validation (?:status|note|result)/iu,
  /readiness (?:status|gate)/iu,
  /practice status/iu,
  /example status/iu,
  /not for submission/iu,
];

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected, path) {
  if (!plainObject(value)) {
    throw new ResumeContractError("RESUME_AST_INVALID", `${path} must be an object`, { path });
  }
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new ResumeContractError("RESUME_AST_INVALID", `${path} does not match the fixed AST contract`, {
      path,
      actual,
      expected: sortedExpected,
    });
  }
}

function text(value, path, max = 2_000) {
  if (typeof value !== "string") {
    throw new ResumeContractError("RESUME_AST_INVALID", `${path} must be text`, { path });
  }
  const normalized = normalizeEvidenceText(value);
  if (!normalized || normalized.length > max) {
    throw new ResumeContractError("RESUME_AST_INVALID", `${path} is empty or too long`, { path, max });
  }
  if (BANNED_CONTENT_PATTERNS.some((pattern) => pattern.test(normalized))) {
    throw new ResumeContractError("RESUME_INTERNAL_OR_FILLER_COPY", `${path} exposes internal or filler copy`, { path });
  }
  return normalized;
}

function identifier(value, path) {
  const normalized = text(value, path, 200);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(normalized)) {
    throw new ResumeContractError("RESUME_AST_INVALID", `${path} contains an invalid identifier`, { path });
  }
  return normalized;
}

function registerId(id, ids, path) {
  if (ids.has(id)) throw new ResumeContractError("RESUME_AST_ID_DUPLICATE", `Duplicate AST id: ${id}`, { id, path });
  ids.add(id);
}

function contentNode(raw, path, context) {
  exactKeys(raw, ["id", "text", "claim_ids", "emphasis"], path);
  const id = identifier(raw.id, `${path}.id`);
  registerId(id, context.ids, path);
  const value = text(raw.text, `${path}.text`, context.nodeTextLimit);
  if (!Array.isArray(raw.claim_ids) || !raw.claim_ids.length) {
    throw new ResumeContractError("RESUME_AST_CLAIMS_REQUIRED", `${path} needs candidate claim ids`, { path });
  }
  const claimIds = raw.claim_ids.map((claimId, index) => identifier(claimId, `${path}.claim_ids[${index}]`));
  if (new Set(claimIds).size !== claimIds.length) {
    throw new ResumeContractError("RESUME_AST_INVALID", `${path}.claim_ids contains duplicates`, { path });
  }
  for (const claimId of claimIds) {
    if (context.allowedClaimIds && !context.allowedClaimIds.has(claimId)) {
      throw new ResumeContractError("RESUME_AST_CLAIM_UNKNOWN", `${path} references an unknown claim`, { path, claimId });
    }
    context.usedClaimIds.add(claimId);
  }
  if (!Array.isArray(raw.emphasis) || raw.emphasis.length > 3) {
    throw new ResumeContractError("RESUME_AST_INVALID", `${path}.emphasis must contain at most three phrases`, { path });
  }
  const emphasis = raw.emphasis.map((phrase, index) => text(phrase, `${path}.emphasis[${index}]`, 200));
  if (new Set(emphasis).size !== emphasis.length || emphasis.some((phrase) => !value.includes(phrase))) {
    throw new ResumeContractError("RESUME_EMPHASIS_INVALID", `${path}.emphasis must be unique exact text spans`, { path });
  }
  context.emphasisPhrases.push(...emphasis);
  context.metrics.emphasisCharacters += emphasis.reduce((sum, phrase) => sum + phrase.length, 0);
  context.metrics.visibleCharacters += value.length;
  const dedupeKey = value.toLocaleLowerCase("en-US");
  if (context.visibleCopy.has(dedupeKey)) {
    throw new ResumeContractError("RESUME_FILLER_OR_REPETITION", "Resume content repeats the same visible copy", {
      path,
      textSha256: sha256(value),
    });
  }
  context.visibleCopy.add(dedupeKey);
  const node = { id, text: value, claim_ids: claimIds, emphasis };
  context.nodes.push(node);
  return node;
}

function entry(raw, path, context) {
  exactKeys(raw, ["id", "header", "body"], path);
  const id = identifier(raw.id, `${path}.id`);
  registerId(id, context.ids, path);
  if (!Array.isArray(raw.header) || !raw.header.length || raw.header.length > 5 || !Array.isArray(raw.body) || raw.body.length > 12) {
    throw new ResumeContractError("RESUME_AST_INVALID", `${path} has invalid header or body items`, { path });
  }
  return {
    id,
    header: raw.header.map((node, index) => contentNode(node, `${path}.header[${index}]`, { ...context, nodeTextLimit: 500 })),
    body: raw.body.map((node, index) => contentNode(node, `${path}.body[${index}]`, { ...context, nodeTextLimit: 1_200 })),
  };
}

function section(raw, index, context) {
  const path = `document.sections[${index}]`;
  exactKeys(raw, ["id", "title", "kind", "placement", "entries"], path);
  const id = identifier(raw.id, `${path}.id`);
  registerId(id, context.ids, path);
  const title = text(raw.title, `${path}.title`, 120);
  const kind = text(raw.kind, `${path}.kind`, 40);
  const placement = text(raw.placement, `${path}.placement`, 40);
  if (!ALLOWED_SECTION_KINDS.has(kind) || !["main", "sidebar"].includes(placement)) {
    throw new ResumeContractError("RESUME_AST_INVALID", `${path} has an invalid kind or placement`, { path, kind, placement });
  }
  if (!Array.isArray(raw.entries) || !raw.entries.length || raw.entries.length > 20) {
    throw new ResumeContractError("RESUME_AST_INVALID", `${path}.entries must contain real resume content`, { path });
  }
  return {
    id,
    title,
    kind,
    placement,
    entries: raw.entries.map((item, entryIndex) => entry(item, `${path}.entries[${entryIndex}]`, context)),
  };
}

export function assertResumeAst(raw, {
  allowedClaimIds = null,
  selectedClaimIds = null,
} = {}) {
  exactKeys(raw, ["schema_version", "candidate", "summary", "sections", "page_preference"], "document");
  if (raw.schema_version !== "raydar.resume.ast.v1") {
    throw new ResumeContractError("RESUME_AST_VERSION_INVALID", "Resume AST version is invalid");
  }
  if (![1, 2].includes(raw.page_preference)) {
    throw new ResumeContractError("RESUME_AST_INVALID", "page_preference must be one or two");
  }
  const context = {
    ids: new Set(),
    allowedClaimIds: allowedClaimIds ? new Set(allowedClaimIds) : null,
    usedClaimIds: new Set(),
    nodes: [],
    visibleCopy: new Set(),
    metrics: { visibleCharacters: 0, emphasisCharacters: 0 },
    emphasisPhrases: [],
    nodeTextLimit: 2_000,
  };
  exactKeys(raw.candidate, ["name", "headline", "contact"], "document.candidate");
  if (!Array.isArray(raw.candidate.contact) || raw.candidate.contact.length > 5) {
    throw new ResumeContractError("RESUME_AST_INVALID", "document.candidate.contact must be an array of at most five items");
  }
  const candidate = {
    name: contentNode(raw.candidate.name, "document.candidate.name", { ...context, nodeTextLimit: 240 }),
    headline: contentNode(raw.candidate.headline, "document.candidate.headline", { ...context, nodeTextLimit: 320 }),
    contact: raw.candidate.contact.map((node, index) => contentNode(
      node,
      `document.candidate.contact[${index}]`,
      { ...context, nodeTextLimit: 320 },
    )),
  };
  const summary = raw.summary === null
    ? null
    : contentNode(raw.summary, "document.summary", { ...context, nodeTextLimit: 1_200 });
  if (!Array.isArray(raw.sections) || !raw.sections.length || raw.sections.length > 12) {
    throw new ResumeContractError("RESUME_AST_INVALID", "Resume requires one to twelve content sections");
  }
  const sections = raw.sections.map((item, index) => section(item, index, context));
  if (!sections.some((item) => item.placement === "main")) {
    throw new ResumeContractError("RESUME_MAIN_CONTENT_REQUIRED", "Resume requires hiring-manager-facing main content");
  }
  if (context.emphasisPhrases.length > 8
    || (context.metrics.emphasisCharacters / Math.max(1, context.metrics.visibleCharacters)) > 0.25) {
    throw new ResumeContractError("RESUME_EMPHASIS_EXCESSIVE", "Resume emphasis must remain restrained");
  }
  if (selectedClaimIds) {
    const selected = new Set(selectedClaimIds);
    const unknown = [...context.usedClaimIds].filter((id) => !selected.has(id));
    const unused = [...selected].filter((id) => !context.usedClaimIds.has(id));
    if (unknown.length || unused.length) {
      throw new ResumeContractError("RESUME_SELECTED_CLAIMS_MISMATCH", "Strategy claim selection must exactly match the rendered AST", {
        unknown,
        unused,
      });
    }
  }
  const ast = {
    schema_version: raw.schema_version,
    candidate,
    summary,
    sections,
    page_preference: raw.page_preference,
  };
  return deepFreeze(ast);
}

export function collectContentNodes(ast) {
  const nodes = [ast.candidate.name, ast.candidate.headline, ...ast.candidate.contact];
  if (ast.summary) nodes.push(ast.summary);
  for (const section of ast.sections) {
    for (const entryItem of section.entries) nodes.push(...entryItem.header, ...entryItem.body);
  }
  return nodes;
}

export function draftClaimsFromAst(ast, ledger) {
  const claimMap = new Map(ledger?.claims?.map((claim) => [claim.claimId, claim]) || []);
  return deepFreeze(collectContentNodes(ast).map((node) => {
    const evidence = [];
    for (const claimId of node.claim_ids) {
      const claim = claimMap.get(claimId);
      if (!claim) throw new ResumeContractError("RESUME_AST_CLAIM_UNKNOWN", `AST references unknown claim: ${claimId}`);
      evidence.push({
        evidenceId: claim.evidenceId,
        sourceKey: claim.sourceKey,
        sourceId: claim.sourceId,
        locator: claim.locator,
        exactQuote: claim.quote,
        trustRank: claim.trustRank,
      });
    }
    return {
      id: node.id,
      text: node.text,
      evidence: [...new Map(evidence.map((item) => [item.evidenceId, item])).values()],
    };
  }));
}

function rewrittenNode(node, validated) {
  const claim = validated.get(node.id);
  if (!claim) return null;
  const nextText = normalizeEvidenceText(claim.text);
  const emphasis = node.emphasis.filter((phrase) => nextText.includes(phrase));
  return { ...node, text: nextText, emphasis };
}

export function applyValidatedClaimsToAst(ast, validatedClaims) {
  const validated = new Map((validatedClaims || []).map((claim) => [claim.id, claim]));
  if (validated.size !== validatedClaims?.length) {
    throw new ResumeContractError("VALIDATED_CLAIMS_DUPLICATE", "Validated claim ids must be unique");
  }
  const name = rewrittenNode(ast.candidate.name, validated);
  const headline = rewrittenNode(ast.candidate.headline, validated);
  if (!name || !headline) {
    throw new ResumeContractError("RESUME_IDENTITY_VALIDATION_FAILED", "Validated resume must retain candidate name and headline");
  }
  const sections = ast.sections.map((sectionItem) => ({
    ...sectionItem,
    entries: sectionItem.entries.map((entryItem) => ({
      ...entryItem,
      header: entryItem.header.map((node) => rewrittenNode(node, validated)).filter(Boolean),
      body: entryItem.body.map((node) => rewrittenNode(node, validated)).filter(Boolean),
    })).filter((entryItem) => entryItem.header.length || entryItem.body.length),
  })).filter((sectionItem) => sectionItem.entries.length);
  const raw = {
    ...ast,
    candidate: {
      name,
      headline,
      contact: ast.candidate.contact.map((node) => rewrittenNode(node, validated)).filter(Boolean),
    },
    summary: ast.summary ? rewrittenNode(ast.summary, validated) : null,
    sections,
  };
  const usedClaimIds = new Set(collectContentNodes(raw).flatMap((node) => node.claim_ids));
  return assertResumeAst(raw, { allowedClaimIds: usedClaimIds });
}

function lineCount(value, charactersPerLine) {
  return Math.max(1, Math.ceil(normalizeEvidenceText(value).length / charactersPerLine));
}

export function createRenderPlan(ast) {
  const HEADER_UNITS = 8;
  const STANDARD_PAGE_UNITS = 54;
  const COMPACT_PAGE_UNITS = 64;
  let topUnits = HEADER_UNITS;
  if (ast.summary) topUnits += lineCount(ast.summary.text, 88) + 1.5;
  const columnUnits = { main: 0, sidebar: 0 };
  for (const section of ast.sections) {
    const chars = section.placement === "sidebar" ? 35 : 82;
    let sectionUnits = 2.2;
    for (const entryItem of section.entries) {
      sectionUnits += 1;
      for (const node of entryItem.header) sectionUnits += lineCount(node.text, chars);
      for (const node of entryItem.body) sectionUnits += lineCount(node.text, chars) + 0.35;
    }
    columnUnits[section.placement] += sectionUnits;
  }
  const units = topUnits + Math.max(columnUnits.main, columnUnits.sidebar);
  const roundedUnits = Math.ceil(units * 10) / 10;
  if (roundedUnits <= STANDARD_PAGE_UNITS) {
    const density = roundedUnits < 32 ? "airy" : "standard";
    return deepFreeze({
      expectedPages: 1,
      density,
      estimatedUnits: roundedUnits,
      estimatedOccupancies: [Math.min(1, roundedUnits / STANDARD_PAGE_UNITS)],
      compressionApplied: false,
    });
  }
  if (roundedUnits <= COMPACT_PAGE_UNITS) {
    return deepFreeze({
      expectedPages: 1,
      density: "compact",
      estimatedUnits: roundedUnits,
      estimatedOccupancies: [Math.min(1, roundedUnits / COMPACT_PAGE_UNITS)],
      compressionApplied: true,
    });
  }
  if (roundedUnits > STANDARD_PAGE_UNITS * 2) {
    throw new ResumeContractError("RESUME_PAGE_LIMIT_EXCEEDED", "Resume cannot exceed two US-letter pages", {
      estimatedUnits: roundedUnits,
    });
  }
  const secondPageOccupancy = (roundedUnits - STANDARD_PAGE_UNITS) / STANDARD_PAGE_UNITS;
  if (secondPageOccupancy < TEMPLATE_TOKENS.page.pageTwoMinimumOccupancy) {
    throw new ResumeContractError(
      "RESUME_PAGE_TWO_UNDERFILLED",
      "Content must be compressed to one page or expanded with relevant evidence before using page two",
      { estimatedUnits: roundedUnits, secondPageOccupancy },
    );
  }
  return deepFreeze({
    expectedPages: 2,
    density: "standard",
    estimatedUnits: roundedUnits,
    estimatedOccupancies: [1, Math.min(1, secondPageOccupancy)],
    compressionApplied: true,
  });
}

export function resumeAstDigest(ast) {
  return sha256(canonicalJson(ast));
}
