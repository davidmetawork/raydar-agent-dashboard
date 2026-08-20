import test from "node:test";
import assert from "node:assert/strict";

import {
  FACTS_VERSION,
  MAX_JOBS,
  MAX_SCHOOLS,
  directoryFromFacts,
  experienceMonths,
  factsFromProfile,
} from "../api/applicants/_lib/facts.mjs";
import {
  FIELDS,
  MAX_CONDITIONS,
  describeRule,
  evaluateRule,
  inScope,
  normalizeRule,
  validateCondition,
} from "../api/applicants/_lib/rules.mjs";

const NOW = Date.parse("2026-08-20T00:00:00.000Z");

// A profile in the widened shape both writers produce (schoolId, companyId,
// densityScore, possibleFake). The person is deliberately the trap case: a
// Harvard MASTER'S plus a bachelor's from somewhere else.
const HARVARD_MBA = {
  title: "Product Lead",
  location: "Boston, Massachusetts",
  about: "…",
  resumeUrl: "https://example.com/cv.pdf",
  linkedin: "someone",
  updatedAt: "2026-08-14T00:00:00.000Z",
  densityScore: 0.31,
  possibleFake: false,
  education: [
    { schoolId: "sch_harvard", school: "Harvard University", degree: "Master of Business Administration - MBA", end: "2020-01-01", talentRank: "S" },
    { schoolId: "sch_state", school: "State University", degree: "Bachelor of Science - BS Economics", end: "2016-01-01", talentRank: null },
  ],
  experiences: [
    { companyId: "co_acme", companyName: "Acme", roleTitle: "Head of Product", start: "2021-03-01", end: null, current: true, industry: "Software", talentRank: "A" },
  ],
};

// The person the flagship rule is actually for: a Harvard BACHELOR'S.
const HARVARD_UNDERGRAD = {
  ...HARVARD_MBA,
  education: [
    { schoolId: "sch_harvard", school: "Harvard University", degree: "Bachelor of Arts - AB Economics", end: "2016-01-01", talentRank: "S" },
  ],
};

// The 44%: a real applicant row with a genuinely empty Paraform record.
const NO_HISTORY = { title: null, location: null, education: [], experiences: [] };

const subject = (profile, row = {}) => ({
  facts: profile ? factsFromProfile(profile, { now: NOW }) : null,
  row: { cuId: "cu1", roleId: "role1", tier: "C", roleTitle: "Head of Product", company: "Acme Corp", appliedAt: "2026-08-10T00:00:00.000Z", ...row },
});

const rule = (conditions, extra = {}) => ({ id: "rule-1", name: "r", action: "interview", state: "live", conditions, scope: { roleIds: [] }, ...extra });

// ── facts ──────────────────────────────────────────────────────────────────

test("facts are total: every key present even for an empty profile", () => {
  const facts = factsFromProfile(NO_HISTORY, { now: NOW });
  for (const key of ["v", "at", "schools", "jobs", "schoolCount", "jobCount", "months", "hasHistory", "possibleFake", "densityScore"]) {
    assert.ok(key in facts, `facts is missing ${key}`);
  }
  assert.equal(facts.hasHistory, false);
  assert.equal(facts.months, null, "no datable roles must be null, never a misleading 0");
  assert.deepEqual(facts.schools, []);
});

test("facts survive junk without throwing", () => {
  for (const junk of [null, undefined, 42, "profile", [], { education: "no", experiences: 7 }]) {
    assert.doesNotThrow(() => factsFromProfile(junk, { now: NOW }));
    assert.equal(factsFromProfile(junk, { now: NOW }).hasHistory, false);
  }
});

test("facts carry the classified degree level and the stable ids", () => {
  const facts = factsFromProfile(HARVARD_UNDERGRAD, { now: NOW });
  assert.equal(facts.schools[0].id, "sch_harvard");
  assert.equal(facts.schools[0].level, "bachelors");
  assert.equal(facts.jobs[0].id, "co_acme");
  assert.equal(facts.currentCompanyId, "co_acme");
  assert.equal(facts.currentTitle, "Head of Product");
  assert.equal(facts.v, FACTS_VERSION);
});

test("counts are the true totals even when the lists are capped", () => {
  const many = {
    education: Array.from({ length: MAX_SCHOOLS + 4 }, (_, i) => ({ schoolId: `s${i}`, school: `S${i}`, degree: "BS" })),
    experiences: Array.from({ length: MAX_JOBS + 9 }, (_, i) => ({ companyId: `c${i}`, companyName: `C${i}`, roleTitle: "Engineer" })),
  };
  const facts = factsFromProfile(many, { now: NOW });
  assert.equal(facts.schools.length, MAX_SCHOOLS);
  assert.equal(facts.jobs.length, MAX_JOBS);
  assert.equal(facts.schoolCount, MAX_SCHOOLS + 4, "the count must be the real total");
  assert.equal(facts.jobCount, MAX_JOBS + 9);
});

test("overlapping roles are counted once, not twice", () => {
  // Two concurrent two-year roles are two years of experience, not four.
  const overlapping = experienceMonths([
    { start: "2020-01-01", end: "2022-01-01" },
    { start: "2020-06-01", end: "2022-01-01" },
  ], NOW);
  assert.ok(Math.abs(overlapping - 24) <= 1, `expected ~24 months, got ${overlapping}`);

  const sequential = experienceMonths([
    { start: "2018-01-01", end: "2020-01-01" },
    { start: "2020-01-01", end: "2022-01-01" },
  ], NOW);
  assert.ok(Math.abs(sequential - 48) <= 1, `expected ~48 months, got ${sequential}`);
});

test("a current role runs to today; an undated end is not assumed to", () => {
  const current = experienceMonths([{ start: "2025-08-20T00:00:00.000Z", end: null, current: true }], NOW);
  assert.ok(Math.abs(current - 12) <= 1, `expected ~12 months, got ${current}`);
  // A non-current role with no end date is unknowable — counting it to today
  // would inflate every stale profile.
  assert.equal(experienceMonths([{ start: "2010-01-01", end: null, current: false }], NOW), null);
});

test("the directory only offers rows that carry a stable id", () => {
  const facts = factsFromProfile({
    education: [
      { schoolId: "sch_a", school: "A University" },
      { schoolId: null, school: "Unregistered College" },
    ],
    experiences: [{ companyId: "co_a", companyName: "A Corp" }],
  }, { now: NOW });
  const directory = directoryFromFacts(facts);
  assert.deepEqual(directory.schools, { sch_a: "A University" });
  assert.deepEqual(directory.companies, { co_a: "A Corp" });
});

// ── THE ROW-SCOPING CONTRACT ───────────────────────────────────────────────

test("'Harvard undergraduate' means one Harvard bachelor's, not two facts about one person", () => {
  const harvardUndergrad = rule([
    { field: "school.id", op: "any_of", value: ["sch_harvard"] },
    { field: "school.level", op: "any_of", value: ["bachelors"] },
  ]);

  const hit = evaluateRule(harvardUndergrad, subject(HARVARD_UNDERGRAD), { now: NOW });
  assert.equal(hit.matched, true);

  // THE TRAP: a Harvard MBA plus an unrelated bachelor's satisfies both
  // conditions separately and must still NOT match.
  const miss = evaluateRule(harvardUndergrad, subject(HARVARD_MBA), { now: NOW });
  assert.equal(miss.matched, false, "conditions must hold on the SAME school row");
  assert.equal(miss.skipped, false, "this is a real no, not an unknown");
});

test("the same scoping applies to experience rows", () => {
  const profile = {
    experiences: [
      { companyId: "co_big", companyName: "BigCo", roleTitle: "Analyst", current: false },
      { companyId: "co_small", companyName: "SmallCo", roleTitle: "Director", current: true },
    ],
  };
  const directorAtBigCo = rule([
    { field: "job.companyId", op: "any_of", value: ["co_big"] },
    { field: "job.title", op: "contains", value: "Director" },
  ]);
  assert.equal(evaluateRule(directorAtBigCo, subject(profile), { now: NOW }).matched, false);
});

test("conditions in different groups need not share a row", () => {
  const mixed = rule([
    { field: "school.id", op: "any_of", value: ["sch_harvard"] },
    { field: "job.title", op: "contains", value: "Head of Product" },
    { field: "application.tier", op: "any_of", value: ["C"] },
  ]);
  assert.equal(evaluateRule(mixed, subject(HARVARD_MBA), { now: NOW }).matched, true);
});

// ── fail closed ────────────────────────────────────────────────────────────

test("an applicant with no profile history is skipped, never matched", () => {
  const anySchool = rule([{ field: "school.level", op: "any_of", value: ["bachelors"] }]);
  const result = evaluateRule(anySchool, subject(NO_HISTORY), { now: NOW });
  assert.equal(result.matched, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "no_profile_history");
});

test("absent facts are skipped, not treated as a mismatch or a match", () => {
  const anySchool = rule([{ field: "school.level", op: "any_of", value: ["bachelors"] }]);
  const result = evaluateRule(anySchool, { facts: null, row: { tier: "C" } }, { now: NOW });
  assert.equal(result.matched, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "no_facts_yet");
});

test("facts built by an older shape are skipped rather than misread", () => {
  const stale = { ...factsFromProfile(HARVARD_UNDERGRAD, { now: NOW }), v: FACTS_VERSION + 1 };
  const result = evaluateRule(
    rule([{ field: "school.level", op: "any_of", value: ["bachelors"] }]),
    { facts: stale, row: { tier: "C" } },
    { now: NOW },
  );
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "facts_version_stale");
});

test("an unreadable degree can never satisfy a level condition", () => {
  const unreadable = { education: [{ schoolId: "sch_x", school: "X", degree: "Mechanical Engineering" }] };
  for (const wanted of [["bachelors"], ["masters"], ["certificate"]]) {
    assert.equal(
      evaluateRule(rule([{ field: "school.level", op: "any_of", value: wanted }]), subject(unreadable), { now: NOW }).matched,
      false,
    );
  }
});

test("application conditions still work for applicants with no history at all", () => {
  // This is what keeps the 44% reachable by tier/role/age rules even though
  // no education or experience rule can ever touch them.
  const recent = rule([
    { field: "application.tier", op: "any_of", value: ["C"] },
    { field: "application.ageDays", op: "at_most", value: 30 },
  ]);
  const result = evaluateRule(recent, subject(NO_HISTORY), { now: NOW });
  assert.equal(result.matched, true);
  assert.equal(result.skipped, false);
});

test("a rule with no conditions never fires", () => {
  const result = evaluateRule(rule([]), subject(HARVARD_UNDERGRAD), { now: NOW });
  assert.equal(result.matched, false);
  assert.equal(result.skipped, true);
});

test("an unknown field is skipped, never silently ignored", () => {
  const result = evaluateRule(
    rule([{ field: "school.mascot", op: "contains", value: "crimson" }]),
    subject(HARVARD_UNDERGRAD), { now: NOW },
  );
  assert.equal(result.matched, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "unknown_field");
});

// ── evidence ───────────────────────────────────────────────────────────────

test("a match records the literal fact it rested on", () => {
  const result = evaluateRule(rule([
    { field: "school.id", op: "any_of", value: ["sch_harvard"] },
    { field: "school.level", op: "any_of", value: ["bachelors"] },
  ]), subject(HARVARD_UNDERGRAD), { now: NOW });
  assert.equal(result.matched, true);
  assert.deepEqual(result.evidence.map((e) => e.field), ["school.id", "school.level"]);
  assert.equal(result.evidence[0].matched, "Harvard University");
  assert.equal(result.evidence[1].matched, "Bachelor of Arts - AB Economics");
});

// ── comparisons ────────────────────────────────────────────────────────────

test("numeric and year comparisons behave", () => {
  const facts = subject(HARVARD_MBA);
  assert.equal(evaluateRule(rule([{ field: "applicant.densityScore", op: "at_least", value: 0.3 }]), facts, { now: NOW }).matched, true);
  assert.equal(evaluateRule(rule([{ field: "applicant.densityScore", op: "at_most", value: 0.2 }]), facts, { now: NOW }).matched, false);
  assert.equal(evaluateRule(rule([{ field: "school.endYear", op: "after", value: 2018 }]), facts, { now: NOW }).matched, true);
  assert.equal(evaluateRule(rule([{ field: "school.endYear", op: "between", value: [2015, 2017] }]), facts, { now: NOW }).matched, true);
  assert.equal(evaluateRule(rule([{ field: "school.endYear", op: "between", value: [2021, 2023] }]), facts, { now: NOW }).matched, false);
});

test("contains is case-insensitive and never matches on empty", () => {
  const s = subject(HARVARD_MBA);
  assert.equal(evaluateRule(rule([{ field: "applicant.location", op: "contains", value: "MASSACHUSETTS" }]), s, { now: NOW }).matched, true);
  assert.equal(evaluateRule(rule([{ field: "applicant.location", op: "contains", value: "  " }]), s, { now: NOW }).matched, false);
});

test("boolean conditions read a known false as a real answer", () => {
  const noResume = { ...HARVARD_MBA, resumeUrl: null };
  assert.equal(evaluateRule(rule([{ field: "applicant.hasResume", op: "is", value: false }]), subject(noResume), { now: NOW }).matched, true);
  assert.equal(evaluateRule(rule([{ field: "applicant.hasResume", op: "is", value: true }]), subject(noResume), { now: NOW }).matched, false);
});

// ── scope ──────────────────────────────────────────────────────────────────

test("an unscoped rule covers every role; a scoped one does not", () => {
  assert.equal(inScope(rule([], { scope: { roleIds: [] } }), { roleId: "role9" }), true);
  assert.equal(inScope(rule([], { scope: { roleIds: ["role1"] } }), { roleId: "role1" }), true);
  assert.equal(inScope(rule([], { scope: { roleIds: ["role1"] } }), { roleId: "role9" }), false);
});

// ── validation ─────────────────────────────────────────────────────────────

test("validation rejects unknown fields, wrong operators and bad values", () => {
  assert.ok(validateCondition({ field: "nope", op: "any_of", value: ["x"] }));
  assert.ok(validateCondition({ field: "school.id", op: "contains", value: "harvard" }));
  assert.ok(validateCondition({ field: "school.level", op: "any_of", value: ["undergrad"] }));
  assert.ok(validateCondition({ field: "school.id", op: "any_of", value: [] }));
  assert.ok(validateCondition({ field: "applicant.years", op: "at_least", value: "five" }));
  assert.equal(validateCondition({ field: "school.level", op: "any_of", value: ["bachelors"] }), null);
});

test("normalizeRule enforces the shape and stamps the author", () => {
  const bad = normalizeRule({ name: "", action: "interview", conditions: [] });
  assert.equal(bad.ok, false);

  const noConditions = normalizeRule({ name: "x", action: "pass", conditions: [] });
  assert.equal(noConditions.ok, false);

  const wrongAction = normalizeRule({ name: "x", action: "reject", conditions: [{ field: "application.tier", op: "any_of", value: ["C"] }] });
  assert.equal(wrongAction.ok, false);

  const tooMany = normalizeRule({
    name: "x", action: "pass",
    conditions: Array.from({ length: MAX_CONDITIONS + 1 }, () => ({ field: "application.tier", op: "any_of", value: ["C"] })),
  });
  assert.equal(tooMany.ok, false);

  const good = normalizeRule(
    { name: "  Ivy undergrads  ", action: "interview", state: "watching", conditions: [{ field: "school.level", op: "any_of", value: ["bachelors"] }] },
    { now: () => "2026-08-20T00:00:00.000Z", by: "David@Raydar.xyz" },
  );
  assert.equal(good.ok, true);
  assert.equal(good.rule.name, "Ivy undergrads");
  assert.equal(good.rule.state, "watching");
  assert.equal(good.rule.updatedBy, "David@Raydar.xyz");
  assert.deepEqual(good.rule.scope, { roleIds: [] });
});

test("a rule may not be saved straight into a state that does not exist", () => {
  const result = normalizeRule({ name: "x", action: "pass", state: "armed", conditions: [{ field: "application.tier", op: "any_of", value: ["C"] }] });
  assert.equal(result.ok, false);
});

// ── plain English ──────────────────────────────────────────────────────────

test("a rule describes itself in names, not ids", () => {
  const lines = describeRule(
    rule([
      { field: "school.id", op: "any_of", value: ["sch_harvard"] },
      { field: "school.level", op: "any_of", value: ["bachelors"] },
      { field: "application.ageDays", op: "at_most", value: 30 },
    ]),
    { sch_harvard: "Harvard University" },
  );
  assert.deepEqual(lines, [
    "Attended Harvard University",
    "Degree level is bachelors",
    "Days since applied is at most 30",
  ]);
});

test("every field in the catalog is describable and has at least one operator", () => {
  for (const [name, field] of Object.entries(FIELDS)) {
    assert.ok(field.ops.length > 0, `${name} offers no operators`);
    assert.ok(typeof field.label === "string" && field.label, `${name} has no label`);
    assert.equal(typeof field.read, "function", `${name} has no read`);
  }
});

test("a rule stays readable when the picker directory has not caught up", () => {
  // The directory is built from prewarmed profiles and lags; a rule naming a
  // school nobody has been warmed for yet would otherwise render its raw id to
  // the whole team.
  const saved = normalizeRule({
    name: "Harvard undergrads",
    action: "interview",
    labels: { sch_harvard: "Harvard University" },
    conditions: [{ field: "school.id", op: "any_of", value: ["sch_harvard"] }],
  });
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.rule.labels, { sch_harvard: "Harvard University" });
  assert.deepEqual(describeRule(saved.rule), ["Attended Harvard University"]);
  // A live directory still wins, so a renamed school reads correctly.
  assert.deepEqual(
    describeRule(saved.rule, { sch_harvard: "Harvard College" }),
    ["Attended Harvard College"],
  );
});

test("labels are sanitised and never unbounded", () => {
  const saved = normalizeRule({
    name: "x", action: "pass",
    labels: { good: "Fine", bad: 42, "": "empty id", other: "" },
    conditions: [{ field: "application.tier", op: "any_of", value: ["C"] }],
  });
  assert.deepEqual(saved.rule.labels, { good: "Fine" });
});
