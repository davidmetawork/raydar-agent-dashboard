import assert from "node:assert/strict";
import test from "node:test";

import { buildEvidenceLedger } from "../api/submissions-v2/_lib/resume/evidence-ledger.mjs";
import { normalizeSourceBundle } from "../api/submissions-v2/_lib/resume/source-bundle.mjs";
import {
  STRATEGIST_FALLBACK_MODEL,
  STRATEGIST_MAX_OUTPUT_TOKENS,
  STRATEGIST_PRIMARY_MODEL,
  buildResumeStrategistPayload,
  runResumeStrategist,
  schemaForAnthropic,
  strategySchemaForAnthropic,
} from "../api/submissions-v2/_lib/models/anthropic-strategist.mjs";
import {
  GROUNDING_VALIDATOR_MODEL,
  runGroundingValidator,
  schemaForOpenAI,
  validateClaimsToCompletion,
} from "../api/submissions-v2/_lib/models/openai-validator.mjs";

function response(status, value) {
  return { ok: status >= 200 && status < 300, status, json: async () => value };
}

function evidenceFixture() {
  const capturedAt = "2026-08-31T18:00:00.000Z";
  const missing = (key, origin = "not_applicable") => ({
    key,
    status: "missing",
    origin,
    locator: `fixture:${key}`,
    capturedAt,
    metadata: { readOutcome: "confirmed_empty" },
  });
  const bundle = normalizeSourceBundle({
    candidateUserId: "candidate-1",
    roleId: "role-1",
    capturedAt,
    sources: [
      {
        key: "candidate_original_resume",
        status: "present",
        origin: "origin_unverified",
        sourceId: "resume-1",
        locator: "fixture:resume-1",
        capturedAt,
        content: Buffer.from("%PDF-1.7 fixture"),
        normalizedText: "Jane Doe\nEngineer at Alpha\nBuilt a scheduling system used by 20 teams.",
        metadata: { readable: true },
      },
      missing("candidate_call"),
      missing("candidate_linkedin"),
      missing("candidate_preferences"),
      missing("recruiter_supplements"),
      {
        key: "role_record",
        status: "present",
        origin: "not_applicable",
        sourceId: "role-1",
        locator: "fixture:role-1",
        capturedAt,
        text: "Product Engineer at Client Co",
        metadata: {},
      },
      {
        key: "role_context",
        status: "present",
        origin: "not_applicable",
        sourceId: "role-1",
        locator: "fixture:role-context",
        capturedAt,
        text: "Client Co values reliable product engineering.",
        metadata: {},
      },
      missing("company_context"),
      missing("role_intake"),
    ],
  });
  const ledger = buildEvidenceLedger(bundle, [
    {
      claimId: "claim-name",
      claimType: "identity",
      subject: "Candidate name",
      value: "Jane Doe",
      sourceKey: "candidate_original_resume",
      quote: "Jane Doe",
      locator: "fixture:resume-1#header",
    },
    {
      claimId: "claim-title",
      claimType: "title",
      subject: "Alpha role",
      value: "Engineer at Alpha",
      sourceKey: "candidate_original_resume",
      quote: "Engineer at Alpha",
      locator: "fixture:resume-1#experience",
    },
    {
      claimId: "claim-achievement",
      claimType: "achievement",
      subject: "Scheduling system",
      value: "Used by 20 teams",
      sourceKey: "candidate_original_resume",
      quote: "Built a scheduling system used by 20 teams.",
      locator: "fixture:resume-1#bullet-1",
    },
  ]);
  return { bundle, ledger };
}

function strategyFixture() {
  return {
    schema_version: "raydar.resume.strategy.v1",
    target_narrative: "Lead with reliable product engineering outcomes.",
    document: {
      schema_version: "raydar.resume.ast.v1",
      candidate: {
        name: { id: "candidate-name", text: "Jane Doe", claim_ids: ["claim-name"], emphasis: [] },
        headline: { id: "candidate-headline", text: "Product-minded engineer", claim_ids: ["claim-title"], emphasis: [] },
        contact: [],
      },
      summary: null,
      sections: [{
        id: "section-experience",
        title: "Experience",
        kind: "experience",
        placement: "main",
        entries: [{
          id: "entry-alpha",
          header: [{ id: "alpha-role", text: "Engineer — Alpha", claim_ids: ["claim-title"], emphasis: [] }],
          body: [{
            id: "alpha-outcome",
            text: "Built a scheduling system used by 20 teams.",
            claim_ids: ["claim-achievement"],
            emphasis: ["20 teams"],
          }],
        }],
      }],
      page_preference: 1,
    },
    selected_claim_ids: ["claim-name", "claim-title", "claim-achievement"],
    deliberate_omissions: [],
  };
}

function claimPacket(text = "Built a scheduling system used by 20 teams.") {
  return [{
    id: "claim-1",
    text,
    evidence: [{
      evidenceId: "ev-1",
      sourceKey: "candidate_original_resume",
      sourceId: "resume-1",
      locator: "fixture:resume-1#bullet-1",
      exactQuote: "Built a scheduling system used by 20 teams.",
      trustRank: 500,
    }],
  }];
}

function validation(verdict = "supported", rewrite = null) {
  return {
    schema_version: "raydar.resume.grounding-validation.v1",
    results: [{
      claim_id: "claim-1",
      verdict,
      evidence_ids: verdict === "unsupported" ? [] : ["ev-1"],
      rewrite,
      reason_code: verdict === "supported"
        ? "direct_support"
        : verdict === "supportable_after_narrowing"
          ? "narrowing_required"
          : "no_candidate_evidence",
    }],
  };
}

test("strategist pins Opus 5 high and uses Opus 4.8 only after a retryable primary failure", async () => {
  const { bundle, ledger } = evidenceFixture();
  const bodies = [];
  const result = await runResumeStrategist({ bundle, ledger }, {
    apiKey: "test-key",
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length === 1) return response(529, { error: { message: "overloaded" } });
      return response(200, {
        id: "msg-fallback",
        content: [{ type: "text", text: JSON.stringify(strategyFixture()) }],
        usage: { input_tokens: 100, output_tokens: 50 },
        stop_reason: "end_turn",
      });
    },
  });
  assert.equal(bodies[0].model, STRATEGIST_PRIMARY_MODEL);
  assert.equal(bodies[0].max_tokens, STRATEGIST_MAX_OUTPUT_TOKENS);
  assert.equal(bodies[0].output_config.effort, "high");
  assert.equal(bodies[1].model, STRATEGIST_FALLBACK_MODEL);
  assert.equal(result.audit.model, STRATEGIST_FALLBACK_MODEL);
  assert.equal(result.fallbackReason, "MODEL_PROVIDER_ERROR");
  assert.equal(result.strategy.document.schema_version, "raydar.resume.ast.v1");
});

test("strategist input keeps role orientation but does not duplicate candidate evidence", () => {
  const { bundle, ledger } = evidenceFixture();
  const payload = buildResumeStrategistPayload({ bundle, ledger, versionInstructions: "Emphasize systems work." });
  const resume = payload.source_bundle.sources.find((source) => source.key === "candidate_original_resume");
  const role = payload.source_bundle.sources.find((source) => source.key === "role_context");
  assert.equal(resume.normalizedText, undefined);
  assert.match(role.normalizedText, /reliable product engineering/u);
  assert.deepEqual(payload.evidence_ledger.claims[0], {
    claim_id: ledger.claims[0].claimId,
    claim_type: ledger.claims[0].claimType,
    source_key: ledger.claims[0].sourceKey,
    exact_quote: ledger.claims[0].quote,
  });
  assert.equal(payload.evidence_ledger.clusters.length, 0);
});

test("Anthropic receives its supported schema projection while local limits remain intact", () => {
  const transformed = schemaForAnthropic({
    type: "array",
    minItems: 1,
    maxItems: 3,
    uniqueItems: true,
    items: { type: "string", minLength: 1, maxLength: 200 },
  });
  assert.deepEqual(transformed, { type: "array", items: { type: "string" } });
  const strategySchema = strategySchemaForAnthropic();
  assert.deepEqual(strategySchema.properties.document, { $ref: "#/$defs/resumeAst" });
  assert.deepEqual(strategySchema.$defs.resumeAst.properties.sections.items, { $ref: "#/$defs/section" });
  assert.deepEqual(strategySchema.$defs.section.properties.entries.items, { $ref: "#/$defs/entry" });
  assert.equal(JSON.stringify(strategySchema).includes("uniqueItems"), false);
  assert.ok(JSON.stringify(strategySchema).length < 5_000);
});

test("strategist does not fall back on nonretryable authentication failure", async () => {
  const { bundle, ledger } = evidenceFixture();
  let calls = 0;
  await assert.rejects(
    () => runResumeStrategist({ bundle, ledger }, {
      apiKey: "bad-key",
      fetchImpl: async () => { calls += 1; return response(401, {}); },
    }),
    (error) => error.code === "MODEL_PROVIDER_ERROR" && error.retryable === false,
  );
  assert.equal(calls, 1);
});

test("strategist derives selected claim metadata from the validated visible document", async () => {
  const { bundle, ledger } = evidenceFixture();
  const strategy = strategyFixture();
  strategy.selected_claim_ids = ["claim-name"];
  const result = await runResumeStrategist({ bundle, ledger }, {
    apiKey: "test-key",
    fetchImpl: async () => response(200, {
      id: "msg-derived-selection",
      content: [{ type: "text", text: JSON.stringify(strategy) }],
      usage: { input_tokens: 100, output_tokens: 50 },
      stop_reason: "end_turn",
    }),
  });
  assert.deepEqual(result.strategy.selected_claim_ids, ["claim-name", "claim-title", "claim-achievement"]);
});

test("strategist deterministically repairs internal ids and drops invalid visual emphasis", async () => {
  const { bundle, ledger } = evidenceFixture();
  const strategy = strategyFixture();
  strategy.document.candidate.name.id = "duplicate id";
  strategy.document.candidate.headline.id = "duplicate id";
  strategy.document.summary = {
    id: "unsupported-summary",
    text: "Unsupported summary",
    claim_ids: ["invented-claim"],
    emphasis: [],
  };
  strategy.document.sections[0].entries[0].body[0].claim_ids = ["claim-achievement", "invented-claim"];
  strategy.document.sections[0].entries[0].body[0].emphasis = ["not exact source text"];
  const result = await runResumeStrategist({ bundle, ledger }, {
    apiKey: "test-key",
    fetchImpl: async () => response(200, {
      id: "msg-normalized-presentation",
      content: [{ type: "text", text: JSON.stringify(strategy) }],
      usage: { input_tokens: 100, output_tokens: 50 },
      stop_reason: "end_turn",
    }),
  });
  assert.equal(result.strategy.document.candidate.name.id, "candidate-name");
  assert.equal(result.strategy.document.candidate.headline.id, "candidate-headline");
  assert.equal(result.strategy.document.summary, null);
  assert.deepEqual(result.strategy.document.sections[0].entries[0].body[0].claim_ids, ["claim-achievement"]);
  assert.deepEqual(result.strategy.document.sections[0].entries[0].body[0].emphasis, []);
});

test("grounding validator pins GPT-5.4 high, retries invalid output, and never stores the request", async () => {
  const bodies = [];
  const result = await runGroundingValidator(claimPacket(), {
    apiKey: "test-key",
    sleep: async () => {},
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length === 1) return response(200, { id: "resp-invalid", output_text: "not json" });
      return response(200, {
        id: "resp-good",
        output_text: JSON.stringify(validation()),
        usage: { input_tokens: 50, output_tokens: 20, total_tokens: 70 },
      });
    },
  });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].model, GROUNDING_VALIDATOR_MODEL);
  assert.equal(bodies[0].store, false);
  assert.equal(bodies[0].reasoning.effort, "high");
  assert.equal(bodies[0].text.format.strict, true);
  assert.equal(result.validation.results[0].verdict, "supported");
});

test("OpenAI receives its supported schema projection while local validation stays strict", () => {
  const transformed = schemaForOpenAI({
    type: "array",
    minItems: 1,
    maxItems: 3,
    uniqueItems: true,
    items: { type: "string", minLength: 1, maxLength: 200 },
  });
  assert.deepEqual(transformed, { type: "array", items: { type: "string" } });
});

test("grounding validator fails closed after bounded invalid responses", async () => {
  let calls = 0;
  await assert.rejects(
    () => runGroundingValidator(claimPacket(), {
      apiKey: "test-key",
      maxAttempts: 3,
      sleep: async () => {},
      fetchImpl: async () => {
        calls += 1;
        return response(200, { output_text: JSON.stringify({ schema_version: "raydar.resume.grounding-validation.v1", results: [] }) });
      },
    }),
    (error) => error.code === "VALIDATOR_RETRIES_EXHAUSTED" && error.provider === "openai",
  );
  assert.equal(calls, 3);
});

test("a narrowing rewrite is independently revalidated before it can survive", async () => {
  const outputs = [
    validation("supportable_after_narrowing", "Built a scheduling system."),
    validation("supported", null),
  ];
  const result = await validateClaimsToCompletion(claimPacket(), {
    apiKey: "test-key",
    sleep: async () => {},
    fetchImpl: async () => response(200, { output_text: JSON.stringify(outputs.shift()) }),
  });
  assert.equal(result.claims[0].text, "Built a scheduling system.");
  assert.equal(result.claims[0].revision, 1);
  assert.deepEqual(result.claims[0].validatedEvidenceIds, ["ev-1"]);
  assert.equal(result.history.length, 2);
});
