// The curated top-university lists behind "did their undergrad at a top
// school" rules. Every fixture that can be is a real string from the live
// queue, because the failure mode this guards is the same as school-us: a
// plausible classifier that quietly matches the wrong institution.

import assert from "node:assert/strict";
import test from "node:test";

import { factsFromProfile } from "../api/applicants/_lib/facts.mjs";
import { FIELDS, evaluateRule, normalizeRule } from "../api/applicants/_lib/rules.mjs";
import { TOP_GROUP_LABELS, normalizeSchool, topSchoolGroup } from "../api/applicants/_lib/school-top.mjs";

test("aliases match the whole normalized name, never a substring", () => {
  // The two real traps: a satellite campus containing its flagship's name,
  // and an unrelated school containing a city.
  assert.equal(topSchoolGroup("University of Michigan"), "us50");
  assert.equal(topSchoolGroup("University of Michigan-Dearborn"), null);
  assert.equal(topSchoolGroup("University of California, Berkeley"), "us50");
  assert.equal(topSchoolGroup("Berkeley City College"), null);
  assert.equal(topSchoolGroup("Harvard University"), "us50");
  assert.equal(topSchoolGroup("Harvard Business School"), null);
});

test("sub-colleges of a listed university are explicit aliases, and real ones work", () => {
  assert.equal(topSchoolGroup("UC Berkeley College of Engineering"), "us50");
  assert.equal(topSchoolGroup("University of California, Berkeley, Haas School of Business"), "us50");
});

test("normalization handles the spellings LinkedIn actually uses", () => {
  assert.equal(topSchoolGroup("The University of Texas at Austin"), "us50");
  assert.equal(topSchoolGroup("University of Illinois Urbana-Champaign"), "us50");
  assert.equal(topSchoolGroup("Washington University in St. Louis"), "us50");
  assert.equal(topSchoolGroup("Queen’s University"), "ca10");
  assert.equal(topSchoolGroup("Queens College"), null, "CUNY, not Kingston");
  assert.equal(topSchoolGroup("ETH Zürich"), "eu10");
  assert.equal(normalizeSchool("Queen's University"), "queens university");
});

test("a school on two lists takes the first group, and the labels exist", () => {
  // The IITs are top-5 India and would also be top-20 Asia; India wins.
  assert.equal(topSchoolGroup("Indian Institute of Technology, Bombay"), "in5");
  assert.equal(topSchoolGroup("IIT Delhi"), "in5");
  assert.equal(topSchoolGroup("Tsinghua University"), "asia20");
  assert.equal(topSchoolGroup("The University of Tokyo"), "asia20");
  for (const group of ["us50", "ca10", "in5", "eu10", "asia20"]) {
    assert.ok(TOP_GROUP_LABELS[group], `label for ${group}`);
  }
});

test("facts carry the group per school row, and old facts read false, not unknown", () => {
  const facts = factsFromProfile({
    education: [
      { school: "PES University", degree: "Bachelor of Technology - BTech CSE" },
      { school: "University of Southern California", degree: "Master of Science - MS Computer Science" },
    ],
  });
  assert.deepEqual(facts.schools.map((row) => row.top), [null, "us50"]);
  // A facts record built before `top` existed: every top field must read
  // false rather than skip or match.
  for (const name of ["school.topUS50", "school.topCA10", "school.topIN5", "school.topEU10", "school.topASIA20"]) {
    assert.equal(FIELDS[name].read({}, {}), false);
  }
});

const rule = (field) => normalizeRule({
  name: "top school undergrads", action: "interview", state: "live",
  conditions: [
    { field: "school.level", op: "any_of", value: ["bachelors"] },
    { field, op: "is", value: true },
  ],
}).rule;

test("the level and the list bind to the SAME school row", () => {
  // The Srinidhi shape: an American top-50 master's over a foreign bachelor's
  // must NOT satisfy "top 50 US undergrad".
  const masters = factsFromProfile({
    education: [
      { school: "University of Southern California", degree: "Master of Science - MS Computer Science" },
      { school: "PES University", degree: "Bachelor of Technology - BTech Computer Science and Engineering" },
    ],
  });
  assert.equal(evaluateRule(rule("school.topUS50"), { row: {}, facts: masters }).matched, false);

  const undergrad = factsFromProfile({
    education: [{ school: "University of California, Berkeley", degree: "Bachelor's degree Electrical Engineering and Computer Science, Film" }],
  });
  const result = evaluateRule(rule("school.topUS50"), { row: {}, facts: undergrad });
  assert.equal(result.matched, true);
  assert.equal(result.evidence.some((e) => e.matched === "University of California, Berkeley"), true,
    "the audit names the school");
});

test("each list only satisfies its own field", () => {
  const iit = factsFromProfile({
    education: [{ school: "IIT Delhi", degree: "Bachelor of Technology - BTech Computer Science" }],
  });
  assert.equal(evaluateRule(rule("school.topIN5"), { row: {}, facts: iit }).matched, true);
  assert.equal(evaluateRule(rule("school.topUS50"), { row: {}, facts: iit }).matched, false);
  assert.equal(evaluateRule(rule("school.topASIA20"), { row: {}, facts: iit }).matched, false,
    "first-group-wins means the IITs are India, not Asia");
});
