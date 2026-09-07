import test from "node:test";
import assert from "node:assert/strict";
import { factsFromProfile } from "../api/applicants/_lib/facts.mjs";
import { evaluateRule } from "../api/applicants/_lib/rules.mjs";
import { normalizeRichProfile, richBindingsForSnapshot } from "../api/applicants/_lib/rich-profile.mjs";
import { richRuleFactsFromProfile, selectRuleFacts } from "../api/applicants/_lib/rich-rule-facts.mjs";

const AT = "2026-09-07T00:00:00.000Z";
const NOW = Date.parse(AT);
const binding = { sourceObservationId: "obs-1", candidateUserId: "candidate-1", connectionReceiptId: "receipt-1" };
const row = { key: "person:role", cuId: "person", sourceObservationId: binding.sourceObservationId, richProfileBinding: binding };
function fixture(extra = {}) {
  const profile = normalizeRichProfile({ ...binding, profileEnrichedAt: AT, title: "Provider headline", location: "Seattle",
    experiences: [{ companyId: "rich-co", companyName: "Rich company", roleTitle: "Engineer" }],
    education: [{ schoolId: "harvard", school: "Harvard University", degree: "MBA" }], ...extra }, { cachedAt: AT });
  return { row, now: NOW, sourceFacts: factsFromProfile({ title: "Source headline", location: "Boston",
    resumeUrl: "https://example.test/resume", experiences: [{ companyId: "source-co", companyName: "Source company", roleTitle: "Designer", current: true }],
    education: [{ schoolId: "berkeley", school: "University of California, Berkeley", degree: "BS" }] }),
    richFacts: richRuleFactsFromProfile(profile, { now: NOW }),
    richReceipt: { ...binding, source: "paraform", v: 1, profileEnrichedAt: AT, richProfileRetainedUntil: profile.richProfileRetainedUntil } };
}
const condition = (field, value, op = "any_of") => ({ field, op, value });
function evaluate(input, conditions) {
  const selected = selectRuleFacts(input);
  return evaluateRule({ conditions }, { row: input.row, facts: selected.facts, profileFactsPending: selected.projectionPending }, { now: NOW });
}

test("rich and source identities remain independent and same-row degree conditions cannot join them", () => {
  const f = fixture();
  for (const [id, source] of [["rich-co", "paraform"], ["source-co", "source"]]) {
    const result = evaluate(f, [condition("job.companyId", [id])]);
    assert.equal(result.matched, true);
    assert.equal(result.evidence[0].source, source);
  }
  assert.equal(evaluate(f, [condition("school.id", ["harvard"]), condition("school.level", ["bachelors"])]).matched, false);
  assert.equal(evaluate(f, [condition("school.id", ["harvard"]), condition("school.level", ["masters"])]).matched, true);
  assert.equal(evaluate(f, [condition("job.companyId", ["rich-co"]), condition("job.title", "Designer", "contains")]).matched, false);
});

test("unknown current status cannot match past and rich names never borrow source IDs", () => {
  const f = fixture();
  assert.equal(selectRuleFacts(f).facts.jobs[0].current, null);
  assert.equal(evaluate(f, [condition("job.companyId", ["rich-co"]), condition("job.current", false, "is")]).matched, false);
  const missingId = fixture({ experiences: [{ companyName: "Source company", current: true }] });
  assert.equal(selectRuleFacts(missingId).facts.currentCompanyId, null);
});

test("visible scalar preferences and fallback keep provenance without inflating person counts", () => {
  const rich = selectRuleFacts(fixture()).facts;
  assert.equal(rich.location, "Seattle"); assert.equal(rich.provenance.location, "paraform");
  assert.equal(rich.jobCount, 1); assert.equal(rich.schoolCount, 1);
  assert.equal(rich.hasResume, true);
  assert.deepEqual(rich.allCompanies.map((job) => job.id), ["source-co"]);
  const blank = selectRuleFacts(fixture({ location: "  ", title: null })).facts;
  assert.equal(blank.location, "Boston"); assert.equal(blank.provenance.location, "source");
  assert.equal(blank.title, "Source headline");
  const noSource = selectRuleFacts({ ...fixture(), sourceFacts: null }).facts;
  assert.equal(noSource.hasResume, null); assert.equal(noSource.hasLinkedin, null);
});

test("a stale projection is explicit pending; foreign, expired and conflicted receipts cannot authorize rich facts", () => {
  for (const patch of [{ projectionVersion: 0 }, { receiptVersion: 0 }, { profileEnrichedAt: "2026-09-06T00:00:00Z" }, { candidateUserId: "someone-else" }]) {
    const f = fixture(); f.richFacts = { ...f.richFacts, ...patch };
    assert.equal(selectRuleFacts(f).projectionPending, true);
    assert.equal(evaluate(f, [condition("school.id", ["harvard"])]).reason, "rich_profile_facts_pending");
    assert.equal(evaluate(f, [condition("applicant.hasResume", true, "is")]).matched, true);
  }
  for (const patch of [{ candidateUserId: "someone-else" }, { richProfileRetainedUntil: AT }]) {
    const f = fixture(); f.richReceipt = { ...f.richReceipt, ...patch };
    assert.equal(selectRuleFacts(f).richEligible, false);
    assert.equal(evaluate(f, [condition("school.id", ["harvard"])]).matched, false);
  }
  const f = fixture();
  f.bindings = richBindingsForSnapshot({ queue: [row, { ...row, key: "person:other-role", richProfileBinding: { ...binding, candidateUserId: "someone-else" } }] });
  assert.equal(selectRuleFacts(f).richEligible, false);
});

test("long retained histories remain selectable and any truncated nonmatch reports incomplete coverage", () => {
  const experiences = Array.from({ length: 60 }, (_, i) => ({ companyId: `co-${i}`, companyName: `Company ${i}` }));
  const education = Array.from({ length: 30 }, (_, i) => ({ schoolId: `sch-${i}`, school: `School ${i}` }));
  const f = fixture({ experiences, education });
  assert.equal(evaluate(f, [condition("job.companyId", ["co-59"])]).matched, true);
  assert.equal(evaluate(f, [condition("school.id", ["sch-29"])]).matched, true);
  const source = { row, now: NOW, sourceFacts: factsFromProfile({ experiences, education }) };
  assert.equal(evaluate(source, [condition("job.companyId", ["co-14"])]).matched, true);
  assert.equal(evaluate(source, [condition("school.id", ["sch-8"])]).matched, true);
  source.sourceFacts.jobs = source.sourceFacts.jobs.slice(0, 14);
  assert.equal(evaluate(source, [condition("job.companyId", ["co-59"])]).reason, "profile_history_incomplete");
});
