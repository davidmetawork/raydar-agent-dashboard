import assert from "node:assert/strict";
import test from "node:test";

import {
  PAGED_RULE_EVALUATOR_BATCH_MAX,
  PAGED_RULE_EVALUATOR_REQUEST_VERSION,
  PAGED_RULE_EVALUATOR_VERSION,
  PAGED_RULE_PREVIEW_COMMAND_VERSION,
  PAGED_RULE_RUN_COMMAND_VERSION,
  buildPagedRulePreviewCommand,
  buildPagedRuleRunCommand,
  evaluatePagedRulePage,
  pagedRuleDigest,
  verifyPagedRuleCommand,
} from "../api/applicants/_lib/rules-paged.mjs";
import { createPagedRuleEvaluatorHandler } from "../api/applicants/rules-evaluate-page.mjs";
import { createTickHandler } from "../api/applicants/rules-tick.mjs";
import { createSyncHandler } from "../api/applicants/sync.mjs";
import { compileFundedEmployerSnapshot } from "../api/applicants/_lib/funded-employers.mjs";
import { K } from "../api/applicants/_lib/kv.mjs";
import { projectApplicantProfileV2 } from "../api/applicants/_lib/paged-core/applicant-profile-contract.mjs";

const PREVIEW_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const GENERATION_ID = "33333333-3333-4333-8333-333333333333";
const APP_ID = "44444444-4444-4444-8444-444444444444";
const ROW_ID = "55555555-5555-4555-8555-555555555555";
const AT = "2026-09-08T18:00:00.000Z";
const SOURCE_OBSERVATION_ID = "source-observation-current";
const FUNDED_SNAPSHOT_ID = "funded-us-gb-ca-2026-09-05";
const rule = { id: "rule-one", version: 3, name: "Tier C", state: "live", action: "pass",
  scope: { roleIds: [] }, conditions: [{ field: "application.tier", op: "any_of", value: ["C"] }] };

function evaluatorRequest(items = [evaluatorItem()], rules = [rule]) {
  return { version: PAGED_RULE_EVALUATOR_REQUEST_VERSION, previewId: PREVIEW_ID,
    batchNumber: 1, evaluatorVersion: PAGED_RULE_EVALUATOR_VERSION,
    generationId: GENERATION_ID, generationDigest: "a".repeat(64), evaluatedAt: AT,
    rulesetDigest: pagedRuleDigest(rules), rules, items };
}

function evaluatorItem() {
  return { applicationId: APP_ID, rowVersionId: ROW_ID, rowRevision: 7,
    monitorKey: "candidate:role", inputRevision: "input-7", readinessRevision: "ready-7",
    factSetDigest: "b".repeat(64), decisionRevision: 0,
    indexPayload: { tier: "C" }, projection: null };
}

function fundedSnapshot() {
  return compileFundedEmployerSnapshot({
    snapshotId: FUNDED_SNAPSHOT_ID,
    generatedAt: "2026-09-05T10:00:00.000Z",
    criteria: {
      headquartersCountryCodes: ["US", "GB", "CA"], minimumTotalFundingUsd: 1_000_000,
      qualifyingFundingRoundTypes: ["seed", "series_a", "series_b", "series_c", "series_d"],
      qualifyingRoundAnnouncedOnOrAfter: "2011-09-05",
      qualifyingRoundAnnouncedOnOrBefore: "2026-09-05",
    },
    provenance: { sources: [{ id: "cb-us-2026-09-05", kind: "crunchbase_query_export",
      exportedAt: "2026-09-05T09:00:00.000Z", sourceFileSha256: "c".repeat(64),
      qualifyingSearch: { entity: "organizations", filters: { fundingRoundTypes: ["seed"] } },
      queryEvidenceSha256: "d".repeat(64) }] },
    entries: [{ orgId: "org-funded", name: "Funded Co", countryCode: "US",
      domain: "https://funded.example", sourceRef: "cb-us-2026-09-05",
      paraformCompanyIds: ["pf-funded"], fundingProof: { totalFundingUsd: 2_500_000,
        sourceRowId: "org-funded", qualification: { kind: "query_cohort", sourceRef: "cb-us-2026-09-05" } } }],
  }).snapshot;
}

function fundedV2Item() {
  const selected = projectApplicantProfileV2({
    application: { applicationId: APP_ID, tenantScopeId: "tenant-one", personId: "person-one",
      sourceObservationId: SOURCE_OBSERVATION_ID, rowRevision: "row-7",
      appliedTo: { roleVersionId: "role-version-one", roleId: "role-one", title: "Engineer",
        hiringCompany: { roleVersion: { name: "Client Co", observedAt: AT, version: "role-version-one" } } } },
    applicationSource: { applicationId: APP_ID, sourceProvider: "workable",
      scope: { tenantScopeId: "tenant-one", personId: "person-one" },
      sourceObservationId: SOURCE_OBSERVATION_ID, state: "verified", observedAt: AT,
      normalizedHash: "f".repeat(64), factVersion: "f".repeat(64), freshness: "current", facts: {
        name: "Candidate", title: "Engineer", location: "Austin",
        provenance: { experiences: { source: "application_source", observedAt: AT } },
        experiences: [{ recordId: "experience-funded", companyId: "pf-funded",
          companyName: "Funded Co", roleTitle: "Engineer" }], education: [],
      } },
    actionability: { eligibility: "ready" },
  });
  const projection = { ...selected, key: "candidate:role", inputRevision: "input-7",
    decisionRevision: 0, factsCurrent: true };
  return { ...evaluatorItem(), factSetDigest: projection.factSetDigest,
    sourceObservationId: SOURCE_OBSERVATION_ID, projection };
}

function response() {
  return { statusCode: null, body: null, headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; } };
}

test("preview and run commands have distinct manual triggers and exact digests", () => {
  const preview = buildPagedRulePreviewCommand({ operationId: PREVIEW_ID,
    authorizerId: "david@raydar.xyz", authenticatedAt: AT,
    generation: { generationId: GENERATION_ID, digest: "a".repeat(64), sequence: 17 }, rules: [rule] });
  assert.equal(preview.version, PAGED_RULE_PREVIEW_COMMAND_VERSION);
  assert.equal(preview.trigger, "manual_preview");
  assert.equal(verifyPagedRuleCommand(preview), true);
  const run = buildPagedRuleRunCommand({ runId: RUN_ID, authorizerId: "david@raydar.xyz",
    authenticatedAt: AT, preview: { id: PREVIEW_ID, state: "ready", resultDigest: "c".repeat(64),
      rulesetDigest: preview.rulesetDigest, generationId: GENERATION_ID,
      generationDigest: "a".repeat(64), generationSequence: 17 } });
  assert.equal(run.version, PAGED_RULE_RUN_COMMAND_VERSION);
  assert.equal(run.trigger, "run_rules_now");
  assert.equal(run.previewId, preview.operationId);
  assert.equal(verifyPagedRuleCommand(run), true);
});

test("evaluator preserves Core row pins and fail-closes a missing projection", () => {
  const request = evaluatorRequest();
  const response = evaluatePagedRulePage(request);
  assert.equal(response.items[0].applicationId, APP_ID);
  assert.equal(response.items[0].rowVersionId, ROW_ID);
  assert.equal(response.items[0].readinessRevision, "ready-7");
  assert.equal(response.items[0].outcome, "no_match");
  assert.equal(response.items[0].skipReason, "profile_v2_fact_set_missing");
  const { responseDigest, ...material } = response;
  assert.equal(responseDigest, pagedRuleDigest(material));
});

test("evaluator records an unavailable pinned fact set as a per-row skip", () => {
  const item = { ...evaluatorItem(), projectionUnavailableReason: "profile_v2_fact_set_unavailable" };
  const result = evaluatePagedRulePage(evaluatorRequest([item]));
  assert.equal(result.items[0].outcome, "no_match");
  assert.equal(result.items[0].skipReason, "profile_v2_fact_set_unavailable");
  assert.deepEqual(result.items[0].evidence, { watchingMatches: [] });
});

test("funded-employer evaluation accepts exact current V2 evidence and keeps fact-set identity distinct", () => {
  const fundedRule = { id: "rule-funded", version: 4, name: "Funded employer", state: "live",
    action: "interview", scope: { roleIds: [] }, conditions: [
      { field: "employment.fundedEmployerSnapshot", op: "member_of", value: FUNDED_SNAPSHOT_ID },
    ] };
  const item = fundedV2Item();
  const result = evaluatePagedRulePage(evaluatorRequest([item], [fundedRule]), {
    fundedEmployerSnapshots: { [FUNDED_SNAPSHOT_ID]: fundedSnapshot() },
  }).items[0];

  assert.equal(result.outcome, "interview");
  assert.equal(result.ruleId, fundedRule.id);
  assert.equal(result.skipReason, null);
  assert.deepEqual(result.evidence.winner, [{
    field: "employment.fundedEmployerSnapshot", op: "member_of", source: "application_source",
    matched: "Funded Co", organizationId: "org-funded", paraformCompanyId: "pf-funded",
    identityBasis: "paraform_company_id", sourceObservationId: SOURCE_OBSERVATION_ID,
    factSetVersion: "applicant-profile-v2-fact-set-v2", factSetDigest: item.factSetDigest,
    snapshotId: FUNDED_SNAPSHOT_ID,
  }]);
  assert.equal(Object.hasOwn(result.evidence.winner[0], "sourcePayloadDigest"), false,
    "a Profile V2 fact-set digest must never impersonate a legacy source-payload digest");
});

test("funded-employer evaluation skips mismatched, stale, unknown, and unbound V2 history evidence", () => {
  const fundedRule = { id: "rule-funded", version: 4, name: "Funded employer", state: "live",
    action: "interview", scope: { roleIds: [] }, conditions: [
      { field: "employment.fundedEmployerSnapshot", op: "member_of", value: FUNDED_SNAPSHOT_ID },
    ] };
  const snapshots = { [FUNDED_SNAPSHOT_ID]: fundedSnapshot() };
  const cases = [
    ["mismatched entry version", (projection) => {
      projection.profile.facts.experiences.entries[0].factVersion = "another-version";
    }, "employment_facts_source_mismatch"],
    ["stale history", (projection) => {
      projection.profile.facts.experiences.freshness = "stale";
      projection.profile.facts.experiences.entries[0].freshness = "stale";
    }, "employment_facts_source_mismatch"],
    ["unknown history", (projection) => {
      projection.profile.facts.experiences.freshness = "unknown";
      projection.profile.facts.experiences.entries[0].freshness = "unknown";
    }, "employment_facts_source_mismatch"],
    ["missing history version", (projection) => {
      projection.profile.facts.experiences.factVersion = null;
      projection.profile.facts.experiences.entries[0].factVersion = null;
    }, "employment_facts_source_unbound"],
  ];

  for (const [name, mutate, expectedSkip] of cases) {
    const item = fundedV2Item();
    const projection = structuredClone(item.projection);
    mutate(projection);
    const result = evaluatePagedRulePage(evaluatorRequest([{ ...item, projection }], [fundedRule]), {
      fundedEmployerSnapshots: snapshots,
    }).items[0];
    assert.equal(result.outcome, "no_match", name);
    assert.equal(result.ruleId, null, name);
    assert.equal(result.skipReason, expectedSkip, name);
    assert.deepEqual(result.evidence, { watchingMatches: [] }, name);
  }
});

test("funded-employer V2 evaluation rejects authority outside the exact paged row", () => {
  const fundedRule = { id: "rule-funded", version: 4, name: "Funded employer", state: "live",
    action: "interview", scope: { roleIds: [] }, conditions: [
      { field: "employment.fundedEmployerSnapshot", op: "member_of", value: FUNDED_SNAPSHOT_ID },
    ] };
  const cases = [
    ["source observation", { sourceObservationId: "source-observation-other" }],
    ["fact set", { factSetDigest: "e".repeat(64) }],
    ["application", { applicationId: "66666666-6666-4666-8666-666666666666" }],
  ];
  for (const [name, mismatch] of cases) {
    const item = { ...fundedV2Item(), ...mismatch };
    const result = evaluatePagedRulePage(evaluatorRequest([item], [fundedRule]), {
      fundedEmployerSnapshots: { [FUNDED_SNAPSHOT_ID]: fundedSnapshot() },
    }).items[0];
    assert.equal(result.outcome, "no_match", name);
    assert.equal(result.skipReason, "profile_v2_fact_set_missing", name);
  }
});

test("evaluator refuses any page above the server-owned 500-row bound", () => {
  const rows = Array.from({ length: PAGED_RULE_EVALUATOR_BATCH_MAX + 1 }, evaluatorItem);
  assert.throws(() => evaluatePagedRulePage(evaluatorRequest(rows)), /paged_rule_evaluator_request_invalid/);
});

test("machine evaluator authenticates before evaluating", async () => {
  let evaluated = false;
  const handler = createPagedRuleEvaluatorHandler({ authenticate: () => false,
    evaluate: () => { evaluated = true; }, loadSnapshots: async () => ({}) });
  const denied = response();
  await handler({ method: "POST", headers: {}, body: evaluatorRequest() }, denied);
  assert.equal(denied.statusCode, 401);
  assert.equal(evaluated, false);

  const allowedHandler = createPagedRuleEvaluatorHandler({ authenticate: () => true,
    evaluate: (request) => evaluatePagedRulePage(request), loadSnapshots: async () => ({}) });
  const allowed = response();
  await allowedHandler({ method: "POST", headers: {}, body: evaluatorRequest() }, allowed);
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.body.response.items.length, 1);
});

test("manual tick creates a preview command before any run command", async () => {
  const commands = {};
  const manifest = { generationId: GENERATION_ID, generationDigest: "a".repeat(64), viewSequence: 17 };
  const ruleDoc = { rev: 1, pausedAll: false, rules: [rule] };
  const handler = createTickHandler({ corsHandler: () => false, authHandler: async () => true,
    kvReady: () => true, pagedRulesEnabled: () => true,
    readPagedManifest: async () => manifest,
    readPagedOperation: async () => null,
    readJson: async (key) => key === K.rules ? ruleDoc : null,
    writeHash: async (_key, value) => Object.assign(commands, value),
    now: () => Date.parse(AT) });
  const first = response();
  await handler({ method: "POST", headers: {}, body: { generationId: GENERATION_ID,
    generationDigest: "a".repeat(64) }, applicantActor: { email: "david@raydar.xyz" } }, first);
  assert.equal(first.statusCode, 202);
  assert.equal(first.body.phase, "preview");
  assert.equal(Object.values(commands)[0].trigger, "manual_preview");
  assert.equal(Object.values(commands).some((command) => command.trigger === "run_rules_now"), false);
});

test("ready preview plus explicit follow-up creates the bound run command", async () => {
  const commands = {};
  const rulesetDigest = pagedRuleDigest([rule]);
  const handler = createTickHandler({ corsHandler: () => false, authHandler: async () => true,
    kvReady: () => true, pagedRulesEnabled: () => true,
    readPagedManifest: async () => ({ generationId: GENERATION_ID,
      generationDigest: "a".repeat(64), viewSequence: 17 }),
    readPagedOperation: async () => ({ kind: "preview", id: PREVIEW_ID, state: "ready",
      resultDigest: "c".repeat(64), rulesetDigest, generationId: GENERATION_ID,
      generationDigest: "a".repeat(64), generationSequence: 17,
      authorizerId: "david@raydar.xyz", authenticatedAt: AT }),
    readJson: async (key) => key === K.rules ? { rev: 1, pausedAll: false, rules: [rule] } : null,
    writeHash: async (_key, value) => Object.assign(commands, value),
    now: () => Date.parse(AT) });
  const res = response();
  await handler({ method: "POST", headers: {}, body: { generationId: GENERATION_ID,
    generationDigest: "a".repeat(64), previewId: PREVIEW_ID, runId: RUN_ID },
  applicantActor: { email: "david@raydar.xyz" } }, res);
  assert.equal(res.statusCode, 202);
  assert.equal(res.body.phase, "run");
  assert.equal(commands[RUN_ID].trigger, "run_rules_now");
  assert.equal(commands[RUN_ID].previewId, PREVIEW_ID);
});

test("sync accepts exact paged command acks and atomically stores decision requests", async () => {
  const previous = process.env.APPHUB_SYNC_KEY;
  process.env.APPHUB_SYNC_KEY = "paged-rule-test";
  try {
    const command = buildPagedRulePreviewCommand({ operationId: PREVIEW_ID,
      authorizerId: "david@raydar.xyz", authenticatedAt: AT,
      generation: { generationId: GENERATION_ID, digest: "a".repeat(64), sequence: 17 }, rules: [rule] });
    const state = { [K.ruleRunCommands]: { [PREVIEW_ID]: command }, [K.ruleRunAcks]: {} };
    const stored = [];
    const handler = createSyncHandler({ kvReady: () => true,
      readHash: async (key) => ({ ...(state[key] || {}) }),
      writeHash: async (key, value) => { state[key] = { ...(state[key] || {}), ...value }; },
      saveRequest: async (key, request) => { stored.push({ key, request }); return true; }, now: () => AT });
    const acked = response();
    await handler({ method: "POST", query: {}, headers: { authorization: "Bearer paged-rule-test" },
      body: { ruleRunAcks: { [PREVIEW_ID]: { status: "preview_queued", operationId: PREVIEW_ID,
        commandDigest: command.commandDigest } } } }, acked);
    assert.equal(acked.statusCode, 200);
    assert.equal(acked.body.acks[PREVIEW_ID].status, "preview_queued");

    const request = { inboxVersion: "applicant-core-graph-decisions-v2", requestId: `${RUN_ID}:${APP_ID}`,
      key: "candidate:role", actorType: "rule",
      ruleRun: { version: "applicant-core-paged-rule-run-v1" },
      viewAuthority: { version: "applicant-paged-decision-authority-v1" } };
    const decisions = response();
    await handler({ method: "POST", query: {}, headers: { authorization: "Bearer paged-rule-test" },
      body: { pagedRuleDecisions: [{ outboxId: 9, requestId: request.requestId, request }] } }, decisions);
    assert.equal(decisions.statusCode, 200);
    assert.equal(decisions.body.receipts[0].disposition, "stored");
    assert.equal(stored.length, 1);
  } finally {
    if (previous == null) delete process.env.APPHUB_SYNC_KEY;
    else process.env.APPHUB_SYNC_KEY = previous;
  }
});
