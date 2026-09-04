import assert from "node:assert/strict";
import test from "node:test";

import {
  GROUNDING_PROMPT_VERSION,
  GROUNDING_VALIDATOR_MODEL,
} from "../api/submissions-v2/_lib/models/openai-validator.mjs";
import {
  STRATEGIST_PRIMARY_MODEL,
  STRATEGIST_PROMPT_VERSION,
} from "../api/submissions-v2/_lib/models/anthropic-strategist.mjs";
import {
  applyValidatedClaimsToAst,
  assertAtsParity,
  assertArtifactReadback,
  assertResumeAst,
  assertVisualPreflight,
  collectContentNodes,
  compressUnderfilledResume,
  createArtifactManifest,
  createRenderPlan,
  prepareResumeRender,
  verifyRenderedPdf,
} from "../resume-renderer-v2/index.mjs";

const BRAND = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";

function ast() {
  return {
    schema_version: "raydar.resume.ast.v1",
    candidate: {
      name: { id: "candidate-name", text: "Jane Doe", claim_ids: ["claim-name"], emphasis: [] },
      headline: { id: "candidate-headline", text: "Product-minded engineer", claim_ids: ["claim-title"], emphasis: [] },
      contact: [{ id: "candidate-location", text: "San Francisco, CA", claim_ids: ["claim-location"], emphasis: [] }],
    },
    summary: {
      id: "candidate-summary",
      text: "Engineer focused on reliable products and practical systems.",
      claim_ids: ["claim-title"],
      emphasis: ["reliable products"],
    },
    sections: [
      {
        id: "section-experience",
        title: "Experience",
        kind: "experience",
        placement: "main",
        entries: [{
          id: "entry-alpha",
          header: [
            { id: "alpha-company", text: "Alpha", claim_ids: ["claim-title"], emphasis: [] },
            { id: "alpha-role-dates", text: "Engineer | 2022–Present", claim_ids: ["claim-dates"], emphasis: [] },
          ],
          body: [{
            id: "alpha-outcome",
            text: "Built a scheduling system used by 20 teams.",
            claim_ids: ["claim-outcome"],
            emphasis: ["20 teams"],
          }],
        }],
      },
      {
        id: "section-skills",
        title: "Core Skills",
        kind: "skills",
        placement: "sidebar",
        entries: [{
          id: "entry-skills",
          header: [{ id: "skill-platforms", text: "Distributed systems", claim_ids: ["claim-skill"], emphasis: [] }],
          body: [],
        }],
      },
    ],
    page_preference: 1,
  };
}

const claimIds = [
  "claim-name",
  "claim-title",
  "claim-location",
  "claim-dates",
  "claim-outcome",
  "claim-skill",
];

test("fixed Template v0.2 produces deterministic template-parity HTML and ATS output", () => {
  const first = prepareResumeRender(ast(), {
    allowedClaimIds: claimIds,
    selectedClaimIds: claimIds,
    officialBrandAsset: BRAND,
  });
  const second = prepareResumeRender(ast(), {
    allowedClaimIds: claimIds,
    selectedClaimIds: claimIds,
    officialBrandAsset: BRAND,
  });
  assert.equal(first.plan.expectedPages, 1);
  assert.equal(first.htmlSha256, second.htmlSha256);
  assert.equal(first.atsSha256, second.atsSha256);
  assert.match(first.html, /PP Grafier Display/u);
  assert.match(first.html, /#7f72ff/iu);
  assert.match(first.html, /raydar-resume-template-v0\.2/u);
  assert.match(first.html, />Profile</u);
  assert.match(first.html, /data:image\/png;base64/u);
  assert.match(first.atsText, /Built a scheduling system used by 20 teams\./u);
});

test("renderer rejects filler, internal copy, and documents beyond two pages", () => {
  const filler = ast();
  filler.sections[0].title = "Why this candidate";
  assert.throws(() => assertResumeAst(filler), (error) => error.code === "RESUME_INTERNAL_OR_FILLER_COPY");

  const oversized = ast();
  oversized.sections = [{
    id: "section-long",
    title: "Experience",
    kind: "custom",
    placement: "main",
    entries: Array.from({ length: 20 }, (_, entryIndex) => ({
      id: `entry-${entryIndex}`,
      header: [{
        id: `header-${entryIndex}`,
        text: `Engineering role ${entryIndex}`,
        claim_ids: [`claim-header-${entryIndex}`],
        emphasis: [],
      }],
      body: Array.from({ length: 12 }, (_, bodyIndex) => ({
        id: `body-${entryIndex}-${bodyIndex}`,
        text: `Delivered supported technical outcome ${entryIndex}-${bodyIndex} across a complex production system with measurable operational value and careful cross-functional execution.`,
        claim_ids: [`claim-body-${entryIndex}-${bodyIndex}`],
        emphasis: [],
      })),
    })),
  }];
  const checked = assertResumeAst(oversized);
  assert.throws(() => createRenderPlan(checked), (error) => error.code === "RESUME_PAGE_LIMIT_EXCEEDED");
});

test("estimated pagination never deletes validated candidate facts", () => {
  const underfilled = ast();
  underfilled.sections = [{
    id: "section-experience",
    title: "Experience",
    kind: "experience",
    placement: "main",
    entries: Array.from({ length: 10 }, (_, entryIndex) => ({
      id: `entry-${entryIndex}`,
      header: [{
        id: `company-${entryIndex}`,
        text: `Supported Company ${entryIndex}`,
        claim_ids: [`claim-company-${entryIndex}`],
        emphasis: [],
      }, {
        id: `header-${entryIndex}`,
        text: `Engineering role ${entryIndex} | 2020-Present`,
        claim_ids: [`claim-header-${entryIndex}`],
        emphasis: [],
      }],
      body: Array.from({ length: 3 }, (_, bodyIndex) => ({
        id: `body-${entryIndex}-${bodyIndex}`,
        text: `Delivered a supported technical outcome ${entryIndex}-${bodyIndex} with measurable operational value.`,
        claim_ids: [`claim-body-${entryIndex}-${bodyIndex}`],
        emphasis: [],
      })),
    })),
  }];
  const checked = assertResumeAst(underfilled);
  const estimated = createRenderPlan(checked);
  const compressed = compressUnderfilledResume(checked);
  assert.ok([1, 2].includes(estimated.expectedPages));
  assert.deepEqual(compressed, checked);
  assert.equal(collectContentNodes(compressed).length, collectContentNodes(checked).length);
});

test("unsupported nodes disappear and validator rewrites flow into the final AST", () => {
  const checked = assertResumeAst(ast(), { allowedClaimIds: claimIds });
  const validation = [
    { id: "candidate-name", text: "Jane Doe" },
    { id: "candidate-headline", text: "Product engineer" },
    { id: "candidate-location", text: "San Francisco, CA" },
    { id: "candidate-summary", text: "Engineer focused on reliable products." },
    { id: "alpha-company", text: "Alpha" },
    { id: "alpha-role-dates", text: "Engineer | 2022–Present" },
    { id: "alpha-outcome", text: "Built a scheduling system." },
  ];
  const rewritten = applyValidatedClaimsToAst(checked, validation);
  assert.equal(rewritten.candidate.headline.text, "Product engineer");
  assert.equal(rewritten.sections.some((section) => section.id === "section-skills"), false);
  assert.equal(rewritten.sections[0].entries[0].body[0].text, "Built a scheduling system.");
});

test("validator removals drop entries whose hiring-manager context is no longer complete", () => {
  const source = ast();
  source.sections[0].entries.push({
    id: "entry-beta",
    header: [
      { id: "beta-company", text: "Beta", claim_ids: ["claim-beta-company"], emphasis: [] },
      { id: "beta-role-dates", text: "Manager | 2019-2021", claim_ids: ["claim-beta-role"], emphasis: [] },
    ],
    body: [{ id: "beta-outcome", text: "Led a supported delivery program.", claim_ids: ["claim-beta-outcome"], emphasis: [] }],
  });
  const allowed = [...claimIds, "claim-beta-company", "claim-beta-role", "claim-beta-outcome"];
  const checked = assertResumeAst(source, { allowedClaimIds: allowed });
  const validation = collectContentNodes(checked)
    .filter((node) => node.id !== "beta-company")
    .map((node) => ({ id: node.id, text: node.text }));
  const rewritten = applyValidatedClaimsToAst(checked, validation);
  assert.equal(rewritten.sections[0].entries.some((entryItem) => entryItem.id === "entry-beta"), false);
  assert.equal(rewritten.sections[0].entries.some((entryItem) => entryItem.id === "entry-alpha"), true);
});

test("PDF preflight enforces selectable text, embedded fonts, ATS parity, and page-two occupancy", () => {
  const render = prepareResumeRender(ast(), {
    allowedClaimIds: claimIds,
    selectedClaimIds: claimIds,
    officialBrandAsset: BRAND,
  });
  assert.equal(assertAtsParity(`${render.atsText}\nRaydar`, render.atsText), true);
  assert.equal(assertAtsParity(
    `${render.atsText}\nPrepared by Raydar\nPage 1 of 2\nJane Doe\nEARLIER EXPERIENCE | CONTINUED`,
    render.atsText,
  ), true);
  const verification = verifyRenderedPdf({
    pdfBytes: Buffer.from("%PDF-1.7\nfixture"),
    pdfExtractedText: render.atsText,
    atsText: render.atsText,
    plan: render.plan,
    preflight: {
      pageCount: 1,
      pageOccupancies: [0.78],
      hasOverflow: false,
      hasClipping: false,
      hasOverlap: false,
      hasMissingGlyphs: false,
      fontsEmbedded: true,
      textSelectable: true,
    },
  });
  assert.equal(verification.preflight.pageCount, 1);
  assert.throws(
    () => assertVisualPreflight({ expectedPages: 2 }, {
      pageCount: 2,
      pageOccupancies: [1, 0.2],
      hasOverflow: false,
      hasClipping: false,
      hasOverlap: false,
      hasMissingGlyphs: false,
      fontsEmbedded: true,
      textSelectable: true,
    }),
    (error) => error.code === "RESUME_PAGE_TWO_UNDERFILLED",
  );
});

test("private artifact manifest is immutable, content-addressed, and readback-gated", () => {
  const render = prepareResumeRender(ast(), {
    allowedClaimIds: claimIds,
    selectedClaimIds: claimIds,
    officialBrandAsset: BRAND,
  });
  const pdfBytes = Buffer.from("%PDF-1.7\nfixture");
  const verification = verifyRenderedPdf({
    pdfBytes,
    pdfExtractedText: render.atsText,
    atsText: render.atsText,
    plan: render.plan,
    preflight: {
      pageCount: 1,
      pageOccupancies: [0.8],
      hasOverflow: false,
      hasClipping: false,
      hasOverlap: false,
      hasMissingGlyphs: false,
      fontsEmbedded: true,
      textSelectable: true,
    },
  });
  const sourceBundle = {
    schemaVersion: "raydar.submissions-v2.source-bundle.v1",
    sourceDigest: "source-digest",
    capturedAt: "2026-08-31T18:00:00.000Z",
    readiness: { cautions: [] },
    sources: [{
      key: "candidate_original_resume",
      status: "present",
      requiredness: "critical",
      origin: "candidate_original",
      sourceId: "resume-1",
      locator: "fixture:resume-1",
      contentSha256: "content-digest",
      normalizedTextSha256: "text-digest",
    }],
  };
  const evidenceLedger = {
    sourceDigest: "source-digest",
    ledgerDigest: "ledger-digest",
    claims: claimIds.map((claimId) => ({
      claimId,
      evidenceId: `ev-${claimId}`,
      sourceKey: "candidate_original_resume",
      sourceId: "resume-1",
      locator: "fixture:resume-1",
      quote: claimId,
      quoteSha256: `quote-${claimId}`,
      trustRank: 500,
    })),
    clusters: [],
  };
  const validatedClaimPackets = collectContentNodes(render.ast).map((node) => ({
    id: node.id,
    text: node.text,
    validatedEvidenceIds: [`ev-${claimIds[0]}`],
  }));
  const manifest = createArtifactManifest({
    generationId: "generation-1",
    version: 1,
    pair: { candidateUserId: "candidate-1", roleId: "role-1" },
    sourceBundle,
    evidenceLedger,
    strategyAudit: {
      provider: "anthropic",
      model: STRATEGIST_PRIMARY_MODEL,
      effort: "high",
      promptVersion: STRATEGIST_PROMPT_VERSION,
    },
    validatorHistory: [{
      audit: {
        provider: "openai",
        model: GROUNDING_VALIDATOR_MODEL,
        effort: "high",
        promptVersion: GROUNDING_PROMPT_VERSION,
      },
    }],
    validatedClaimPackets,
    render,
    pdfVerification: verification,
    artifactPaths: {
      pdf: "submissions/resumes/v2/candidate-1/role-1/1.pdf",
      ats: "submissions/resumes/v2/candidate-1/role-1/1.txt",
      manifest: "submissions/resumes/v2/candidate-1/role-1/1.json",
    },
    createdAt: "2026-08-31T18:00:00.000Z",
  });
  assert.equal(Object.isFrozen(manifest.envelope.payload), true);
  assert.equal(manifest.promotionEligible, true);
  assert.equal(assertArtifactReadback({
    expected: manifest,
    pdfBytes,
    atsBytes: Buffer.from(render.atsText),
    manifestBytes: Buffer.from(manifest.manifestJson),
  }), true);
  assert.throws(
    () => assertArtifactReadback({
      expected: manifest,
      pdfBytes: Buffer.from("%PDF-1.7\ntampered"),
      atsBytes: Buffer.from(render.atsText),
      manifestBytes: Buffer.from(manifest.manifestJson),
    }),
    (error) => error.code === "ARTIFACT_READBACK_MISMATCH",
  );
});
