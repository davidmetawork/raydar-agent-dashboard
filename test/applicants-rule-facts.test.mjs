import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const html = await readFile(new URL("../applicants.html", import.meta.url), "utf8");
const source = await readFile(new URL("../applicants-rule-facts.js", import.meta.url), "utf8");

function loadFactsModule() {
  const context = {
    console,
    document: { addEventListener() {} },
  };
  context.window = context;
  context.window.addEventListener = () => {};
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "applicants-rule-facts.js" });
  return context.RaydarRuleFacts;
}

test("profile rows expose friendly fact entry points and load the chooser before Rules", () => {
  assert.match(html, /Create rule from profile/);
  assert.match(html, /data-rule-fact-kind="application"/);
  assert.match(html, /data-rule-fact-kind="experience"/);
  assert.match(html, /data-rule-fact-kind="education"/);
  assert.match(html, /window\.RaydarRules\?\.refreshView\?\.\(\)/);
  assert.match(html, /href="\/applicants-rules\.css"/);
  assert.ok(
    html.indexOf('<script src="/applicants-rule-facts.js"></script>')
      < html.indexOf('<script src="/applicants-rules.js"></script>'),
    "the chooser must exist before the Rules controller hands off to it",
  );
});

test("one experience row produces only its exact company and optional approximate title", () => {
  const facts = loadFactsModule();
  const row = {
    kind: "experience",
    record: { companyId: "co_acme", companyName: "Acme", roleTitle: "Staff Engineer" },
  };
  const offered = facts.factsFor(row);
  assert.deepEqual(Array.from(offered, ({ id, checked, approximate }) => ({ id, checked, approximate: Boolean(approximate) })), [
    { id: "experience-company", checked: true, approximate: false },
    { id: "experience-title", checked: false, approximate: true },
  ]);
  const seed = facts.createSeed(row, ["experience-company", "experience-title"]);
  assert.deepEqual(JSON.parse(JSON.stringify(seed)), {
    name: "Acme experience",
    conditions: [
      { field: "job.companyId", op: "any_of", value: ["co_acme"] },
      { field: "job.title", op: "contains", value: "Staff Engineer" },
    ],
    labels: { co_acme: "Acme" },
  });
  assert.equal(facts.createSeed(row, ["experience-title"]).name, "Staff Engineer job titles");
});

test("one education row preserves the stable school id without classifying the degree in browser code", () => {
  const facts = loadFactsModule();
  const row = {
    kind: "education",
    record: { schoolId: "sch_state", school: "State University", degree: "Bachelor of Science" },
  };
  const seed = facts.createSeed(row, ["education-school", "education-degree"]);
  assert.deepEqual(JSON.parse(JSON.stringify(seed)), {
    name: "State University education",
    conditions: [
      { field: "school.id", op: "any_of", value: ["sch_state"] },
      { field: "school.degreeText", op: "contains", value: "Bachelor of Science" },
    ],
    labels: { sch_state: "State University" },
  });
  assert.equal(facts.createSeed(row, ["education-degree"]).name, "Bachelor of Science degrees");
  assert.doesNotMatch(source, /school\.level|degreeLevel|doctorate|bachelors/);
});

test("verified rich rows keep their own company and university identities at the same source indexes", () => {
  const facts = loadFactsModule();
  const profile = {
    location: "Application City", title: "Application headline",
    experiences: [{ companyId: "source-co", companyName: "Source Company", roleTitle: "Source role" }],
    education: [{ schoolId: "source-school", school: "Source University", degree: "BA" }],
    paraformProfile: {
      ruleFactsEligible: true, location: "Seattle, WA", title: "Rich headline",
      experiences: [{ companyId: "rich-co", companyName: "Rich Company", roleTitle: "Rich role", current: true }],
      education: [{ schoolId: "rich-school", school: "Rich University", degree: "MBA" }],
    },
  };
  const sources = facts.profileSources("one", null, profile);
  for (const [kind, condition, selected] of [["experience", "job.companyId", "experience-company"], ["education", "school.id", "education-school"]]) {
    const pair = sources.filter((item) => item.kind === kind);
    assert.equal(pair.length, 2);
    assert.deepEqual(Array.from(pair, (item) => item.index), [0, 0]);
    const seeds = pair.map((item) => facts.createSeed(item, [selected]));
    assert.equal(seeds[0].conditions[0].field, condition);
    assert.notEqual(seeds[0].conditions[0].value[0], seeds[1].conditions[0].value[0]);
    assert.equal(pair[0].source, "paraform");
    assert.equal(pair[1].source, "source");
  }
  const location = sources.find((item) => item.kind === "location");
  assert.equal(location.record.value, "Seattle, WA");
  assert.deepEqual(JSON.parse(JSON.stringify(facts.createSeed(location, ["applicant-location"]).conditions)), [
    { field: "applicant.location", op: "contains", value: "Seattle, WA" },
  ]);
  profile.paraformProfile.location = " ";
  assert.equal(facts.profileSources("one", null, profile).find((item) => item.kind === "location").record.value, "Application City");
  delete profile.paraformProfile.ruleFactsEligible;
  assert.equal(facts.profileSources("one", null, profile).some((item) => item.source === "paraform"), false);
});

test("company matching includes past and current jobs unless a current-role refinement is chosen", () => {
  const facts = loadFactsModule();
  for (const current of [true, false]) {
    const row = { kind: "experience", record: { companyId: "co_acme", companyName: "Acme", current } };
    assert.deepEqual(Array.from(facts.factsFor(row).filter((item) => item.checked), (item) => item.id), ["experience-company"]);
    const seed = facts.createSeed(row, ["experience-company", "experience-current"]);
    assert.equal(seed.conditions[1].field, "job.current");
    assert.equal(seed.conditions[1].value, current);
  }
  assert.equal(facts.factsFor({ kind: "experience", record: { companyId: "co_acme", current: null } }).some((item) => item.id === "experience-current"), false);
});

test("missing company IDs default to the full company name with title and current role optional", () => {
  const facts = loadFactsModule();
  const row = { kind: "experience", record: { companyName: "North Oak Holdings", roleTitle: "Revenue Advisor", current: true } };
  const offered = facts.factsFor(row);
  assert.deepEqual(Array.from(offered, ({ id, checked }) => ({ id, checked })), [
    { id: "experience-company-name", checked: true },
    { id: "experience-title", checked: false },
    { id: "experience-current", checked: false },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(facts.createSeed(row, ["experience-company-name"]))), {
    name: "North Oak Holdings experience",
    conditions: [{ field: "job.companyName", op: "equals", value: "North Oak Holdings" }], labels: {},
  });
  assert.deepEqual(JSON.parse(JSON.stringify(facts.createSeed(row, ["experience-company-name", "experience-title", "experience-current"]).conditions)), [
    { field: "job.companyName", op: "equals", value: "North Oak Holdings" },
    { field: "job.title", op: "contains", value: "Revenue Advisor" },
    { field: "job.current", op: "is", value: true },
  ]);
  assert.equal(facts.createSeed(row, []).conditions.length, 0);
});

test("company-name choices require a complete non-placeholder name", () => {
  const facts = loadFactsModule();
  for (const companyName of [null, "", "  ", "—", "N/A", "na", "none", "null", "undefined", "UNKNOWN", "Unknown   Company", "not provided", "Not Available", "Acme…", "Acme...Labs", "x".repeat(160), "x".repeat(161)]) {
    const row = { kind: "experience", record: { companyName, roleTitle: "Engineer" } };
    assert.deepEqual(Array.from(facts.factsFor(row), (item) => item.id), ["experience-title"], String(companyName));
    assert.equal(facts.createSeed(row, ["experience-company-name"]).conditions.length, 0);
  }
  const longName = "x".repeat(159);
  const offered = facts.factsFor({ kind: "experience", record: { companyName: longName } });
  assert.equal(offered[0].condition.value, longName);
});

test("the chooser can only create an unsaved seed", () => {
  assert.doesNotMatch(source, /\/api\/applicants\/rules-tick/);
  assert.doesNotMatch(source, /fetch\s*\(/);
  assert.doesNotMatch(source, /op\s*:\s*["']save["']/);
  assert.match(source, /Nothing is saved or run here\./);
  assert.match(source, /window\.RaydarRules\?\.fromApplicant\(cuId, row, seed\)/);
  assert.match(source, /profileModal\.inert = true/);
  assert.match(html, /window\.RaydarRuleFacts\?\.close\?\.\(\)/);
});


test("a university without an ID defaults to its complete name, with degree optional", () => {
  const facts = loadFactsModule();
  const row = { kind: "education", record: { school: "University of Central Missouri", degree: "Master’s — Computer Science" } };
  const offered = facts.factsFor(row);
  assert.deepEqual(Array.from(offered, ({ id, checked }) => ({ id, checked })), [
    { id: "education-school-name", checked: true }, { id: "education-degree", checked: false },
  ]);
  const seed = JSON.parse(JSON.stringify(facts.createSeed(row, ["education-school-name"])));
  assert.deepEqual(seed, { name: "University of Central Missouri education", conditions: [
    { field: "school.name", op: "equals", value: "University of Central Missouri" },
  ], labels: {} });
  for (const length of [159, 160, 161]) {
    const long = { kind: "education", record: { school: "x".repeat(length) } };
    assert.equal(facts.factsFor(long).some((item) => item.id === "education-school-name"), length < 160);
  }
});

test("V2 chooser uses the selected immutable record and seals its digest", () => {
  const facts = loadFactsModule();
  const row = { key: "v2:one", inputRevision: "input-one", decisionRevision: 4 };
  const profileV2 = {
    factSetDigest: "a".repeat(64), factsCurrent: true, inputRevision: "input-one", decisionRevision: 4,
    application: { applicationId: "11111111-1111-4111-8111-111111111111", sourceObservationId: "obs-one", rowRevision: "row-one",
      appliedTo: { roleId: "role-one", title: "Platform Engineer" } },
    profile: { facts: {
      title: { value: "Versioned title" }, location: { value: "Versioned City" },
      experiences: { entries: [{ recordId: "work-one", companyId: "company-one", companyName: "One Co", roleTitle: "Engineer", current: true }] },
      education: { entries: [{ recordId: "edu-one", schoolId: "school-one", school: "One University", degree: "BA" }] },
    } },
  };
  const sources = facts.profileSources("one", row, { profileV2,
    experiences: [{ companyId: "legacy-company", companyName: "Legacy Co" }] });
  assert.equal(sources.some((source) => source.source === "source"), false, "legacy source details remain nonactionable when V2 differs");
  const education = sources.find((source) => source.kind === "education");
  const seed = JSON.parse(JSON.stringify(facts.createSeed(education, ["education-school", "education-degree"])));
  assert.deepEqual(seed.conditions, [
    { field: "school.id", op: "any_of", value: ["school-one"] },
    { field: "school.degreeText", op: "contains", value: "BA" },
  ]);
  assert.deepEqual(seed.profileFactSeed, {
    version: "applicant-profile-v2-rule-seed-v1", key: "v2:one",
    applicationId: "11111111-1111-4111-8111-111111111111", sourceObservationId: "obs-one", rowRevision: "row-one",
    inputRevision: "input-one", decisionRevision: 4, factSetDigest: "a".repeat(64),
    selection: { kind: "education", index: 0, recordId: "edu-one", selectedFactIds: ["education-school", "education-degree"] },
  });
});
