import test from "node:test";
import assert from "node:assert/strict";
import { factsFromProfile } from "../api/applicants/_lib/facts.mjs";
import { evaluateRule } from "../api/applicants/_lib/rules.mjs";

const rule = (inUS = true) => ({ conditions: [
  { field: "school.level", op: "any_of", value: ["bachelors"] },
  { field: "school.degreeText", op: "contains", value: "computer science" },
  { field: "school.inUS", op: "is", value: inUS },
] });
const evaluate = (education, inUS = true) => evaluateRule(rule(inUS), {
  row: {}, facts: factsFromProfile({ education, experiences: [] }),
});

test("source school names with official US evidence restore a matching degree", () => {
  for (const school of ["University of Utah", "Rowan University"]) {
    const education = [{ school, degree: "B.S. — Computer Science" }];
    const facts = factsFromProfile({ education });
    assert.equal(facts.schools[0].inUS, true);
    assert.equal(facts.schools[0].countryEvidence.status, "us");
    assert.match(facts.schools[0].countryEvidence.source, /nces\.ed\.gov/);
    assert.equal(evaluate(education).matched, true);
  }
});

test("country and qualifying degree must still belong to the same education row", () => {
  const result = evaluate([
    { school: "University of Utah", degree: "Master of Science — Computer Science" },
    { school: "Example Foreign Institute", schoolLocation: "Bengaluru, India", degree: "Bachelor of Science — Computer Science" },
  ]);
  assert.equal(result.matched, false);
  assert.equal(result.skipped, false);
});

test("an unknown school country cannot satisfy either a positive or a negative country condition", () => {
  for (const country of [true, false]) {
    const result = evaluate([{ school: "Unverified Example Institute", degree: "Bachelor of Science — Computer Science" }], country);
    assert.equal(result.matched, false);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "school_country_unverified");
  }
});

test("an unrelated unknown school does not inflate relevant missing-country counts", () => {
  const result = evaluate([{ school: "Unverified Example Institute", degree: "Master of Science — Computer Science" }]);
  assert.equal(result.matched, false);
  assert.equal(result.skipped, false);
});

test("legacy, malformed, and contradictory country facts cannot establish a country", () => {
  for (const school of [
    { inUS: false }, { inUS: true },
    { inUS: false, countryEvidence: { status: "garbage" } },
    { inUS: true, countryEvidence: { status: "foreign" } },
    { inUS: false, countryEvidence: { status: "us" } },
  ]) {
    for (const inUS of [true, false]) {
      const facts = factsFromProfile({ education: [{ school: "University of Utah", degree: "B.S. — Computer Science" }] });
      facts.schools[0] = { ...facts.schools[0], countryEvidence: undefined, ...school };
      const result = evaluateRule(rule(inUS), { row: {}, facts });
      assert.equal(result.matched, false);
      assert.equal(result.reason, "school_country_unverified");
    }
  }
});

test("explicit foreign country beats an official US name or .edu website", () => {
  for (const schoolLocation of ["India", "Bengaluru, India"]) {
    const education = [{ school: "University of Utah", schoolWebsite: "https://utah.edu", schoolLocation, degree: "B.S. — Computer Science" }];
    assert.equal(evaluate(education).matched, false);
    assert.equal(factsFromProfile({ education }).schools[0].countryEvidence.status, "foreign");
  }
});

test("source facts never invent a Paraform school ID from the country registry", () => {
  const school = factsFromProfile({ education: [{ school: "Harvard University", degree: "A.B. — Physics, with Secondary in Computer Science" }] }).schools[0];
  assert.equal(school.level, "bachelors");
  assert.equal(school.inUS, true);
  assert.equal(school.id, null);
});

test("bare Georgia is ambiguous and cannot override verified US institution evidence", () => {
  const education = [{ school: "University of Georgia", schoolLocation: "Georgia",
    schoolWebsite: "https://www.uga.edu", degree: "B.S. — Computer Science" }];
  assert.equal(evaluate(education).matched, true);
  assert.equal(evaluate([{ ...education[0], schoolLocation: "Georgia." }]).matched, true);
  assert.equal(evaluate(education, false).matched, false);
  assert.equal(evaluate([{ ...education[0], schoolLocation: "Tbilisi, Georgia" }]).matched, false);
});

test("an explicit combined bachelor's and master's retains both levels on its own school row", () => {
  const education = [{ school: "University of Utah", degree: "BS / MS — Computer Science" }];
  const facts = factsFromProfile({ education });
  assert.equal(facts.schools[0].level, "masters");
  assert.deepEqual(facts.schools[0].levels, ["masters", "bachelors"]);
  assert.equal(evaluate(education).matched, true);
  assert.equal(evaluate([{ school: "University of Utah", degree: "M.B.A. — Computer Science" }]).matched, false);
});
