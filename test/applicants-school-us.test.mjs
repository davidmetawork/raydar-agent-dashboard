// "Is this school American?" — the fact behind a rule that auto-interviews a
// US degree. Every fixture here is a real string taken from the live queue on
// 2026-08-25, because the failure mode this guards is a plausible-looking
// classifier that quietly interviews the wrong continent.

import assert from "node:assert/strict";
import test from "node:test";

import { factsFromProfile } from "../api/applicants/_lib/facts.mjs";
import { FIELDS, evaluateRule, normalizeRule } from "../api/applicants/_lib/rules.mjs";
import { isDotEdu, locationNamesForeignCountry, locationSaysUS, schoolInUS } from "../api/applicants/_lib/school-us.mjs";

test(".edu is matched on the end of the hostname, never as a substring", () => {
  assert.equal(isDotEdu("https://www.iup.edu/"), true);
  assert.equal(isDotEdu("http://berkeley.edu"), true);
  assert.equal(isDotEdu("cs.stanford.edu"), true, "a bare hostname still parses");
  // Both of these are real schools in the queue, and neither is a .edu.
  assert.equal(isDotEdu("https://www.srmist.edu.in/"), false);
  assert.equal(isDotEdu("https://www.umt.edu.pk"), false);
  assert.equal(isDotEdu("http://www.sfit.ac.in/"), false);
  assert.equal(isDotEdu("http://bit.ly/CSULB-Homepage"), false, "a shortener says nothing");
  assert.equal(isDotEdu(""), false);
  assert.equal(isDotEdu(null), false);
});

test("the country is read from the LAST segment of the location", () => {
  assert.equal(locationSaysUS("Austin, Texas, United States"), true);
  assert.equal(locationSaysUS("Boston, Massachusetts, U.S.A."), true);
  assert.equal(locationSaysUS("United States"), true);
  assert.equal(locationSaysUS("Hatfield, England, United Kingdom"), false);
  assert.equal(locationSaysUS("Gurugram, Haryana, India"), false);
  // A US-sounding segment that is not the country must not carry the answer.
  assert.equal(locationSaysUS("United States Avenue, Lima, Peru"), false);
});

test("a bare state is refused, spelled out or abbreviated", () => {
  // The collisions this protects against, all real: Georgia is a country,
  // TN is Tamil Nadu before it is Tennessee, CA is Canada before California.
  assert.equal(schoolInUS({ location: "Tbilisi, Georgia" }), false);
  assert.equal(schoolInUS({ location: "Sriperumbudur, TN" }), false);
  assert.equal(schoolInUS({ location: "Toronto, ON, CA" }), false);
  assert.equal(schoolInUS({ location: "Utica, ny" }), false);
});

test("an explicit foreign country beats a .edu, because legacy .edu holders exist", () => {
  // PES University, Bengaluru holds pes.edu — registered before the 2001 rules
  // closed .edu to non-US institutions. On 2026-08-25 it auto-interviewed an
  // Indian B.Tech holder whose master's was American, which is the exact
  // person these rules exist to distinguish.
  assert.equal(schoolInUS({ website: "http://pes.edu/", location: "Bengaluru, Karnataka, India" }), false);
  assert.equal(locationNamesForeignCountry("Bengaluru, Karnataka, India"), true);
  // The veto needs a real country name, so a US school with a street address
  // or a state-only location still gets its .edu answered.
  assert.equal(locationNamesForeignCountry("1011 South Drive Sutton Hall, Suite 120"), false);
  assert.equal(locationNamesForeignCountry("Utica, ny"), false);
  assert.equal(schoolInUS({ website: "https://www.sunypoly.edu", location: "Utica, ny" }), true);
  // ... and the US itself is never foreign.
  assert.equal(locationNamesForeignCountry("Los Angeles, California, United States"), false);
  assert.equal(schoolInUS({ website: "http://www.usc.edu", location: "Los Angeles, California, United States" }), true);
});

test("either signal is enough, and neither means false rather than unknown", () => {
  // Indiana University of Pennsylvania: a street address, but a .edu site.
  assert.equal(schoolInUS({ location: "1011 South Drive Sutton Hall, Suite 120", website: "https://www.iup.edu/" }), true);
  // CSU Long Beach: a link shortener, but a location that names the country.
  assert.equal(schoolInUS({ location: "Long Beach, California, United States", website: "http://bit.ly/CSULB-Homepage" }), true);
  // Wagner College and Essex County College carry neither in Paraform.
  assert.equal(schoolInUS({ location: null, website: null }), false);
  assert.equal(schoolInUS({}), false);
  assert.equal(schoolInUS(), false);
});

test("facts carry the school's location and its US verdict, per school row", () => {
  const facts = factsFromProfile({
    education: [
      { school: "SRM IST Chennai", degree: "Bachelor of Technology - BTech CSE", end: "2021-06-01",
        schoolLocation: "Sriperumbudur, Tamil Nadu, India", schoolWebsite: "https://www.srmist.edu.in/" },
      { school: "The University of Texas at Austin", degree: "Bachelor of Science Computer Science", end: "2024-05-01",
        schoolLocation: "Austin, Texas, United States", schoolWebsite: "https://www.utexas.edu/" },
    ],
  });
  assert.deepEqual(facts.schools.map((s) => s.inUS), [false, true]);
  assert.equal(facts.schools[1].location, "Austin, Texas, United States");
});

test("a profile written before the fields existed yields inUS false, never a match", () => {
  const facts = factsFromProfile({
    education: [{ school: "Wagner College", degree: "Bachelor's degree Computer Science", end: "2023-05-01" }],
  });
  assert.equal(facts.schools[0].inUS, false);
  assert.equal(facts.schools[0].location, null);
  assert.equal(facts.v, 1, "the version must NOT bump — a bump takes every live rule off the air");
});

const rule = (conditions) => normalizeRule({
  name: "US computer science bachelors", action: "interview", state: "live", conditions,
}).rule;

const US_CS = [
  { field: "school.level", op: "any_of", value: ["bachelors"] },
  { field: "school.degreeText", op: "contains", value: "computer science" },
  { field: "school.inUS", op: "is", value: true },
];

test("the rule reads one school row: a US bachelor's matches", () => {
  const facts = factsFromProfile({
    education: [{ school: "The University of Texas at Austin", degree: "Bachelor of Science Computer Science",
      schoolLocation: "Austin, Texas, United States", schoolWebsite: "https://www.utexas.edu/" }],
  });
  const result = evaluateRule(rule(US_CS), { row: {}, facts });
  assert.equal(result.matched, true);
  assert.equal(result.skipped, false);
});

test("an Indian B.Tech does not match, even for someone living in the US", () => {
  const facts = factsFromProfile({
    location: "San Jose, California, United States",
    education: [{ school: "SRM IST Chennai", degree: "Bachelor of Technology - BTech Computer Science",
      schoolLocation: "Sriperumbudur, Tamil Nadu, India", schoolWebsite: "https://www.srmist.edu.in/" }],
  });
  const result = evaluateRule(rule(US_CS), { row: {}, facts });
  assert.equal(result.matched, false, "this is the leak the fact exists to close");
});

test("the US test binds to the SAME school row as the degree", () => {
  // A US master's plus an Indian computer science bachelor's: neither row
  // satisfies all three conditions, so the rule must not fire.
  const facts = factsFromProfile({
    education: [
      { school: "Northern Arizona University", degree: "Master's Degree Computer Science",
        schoolLocation: "Flagstaff, Arizona, United States", schoolWebsite: "http://www.nau.edu" },
      { school: "Osmania University", degree: "Bachelor's degree Computer Science",
        schoolLocation: "Hyderabad, Telangana, India", schoolWebsite: "http://www.osmania.ac.in/" },
    ],
  });
  assert.equal(evaluateRule(rule(US_CS), { row: {}, facts }).matched, false);
});

test("the school-location text condition is offered as approximate", () => {
  assert.deepEqual(FIELDS["school.inUS"].ops, ["is"]);
  assert.equal(FIELDS["school.inUS"].group, "school");
  assert.equal(FIELDS["school.location"].approximate, true);
  const facts = factsFromProfile({
    education: [{ school: "University of South Florida", degree: "Bachelor of Science - BS Computer Science",
      schoolLocation: "Tampa, Florida, United States", schoolWebsite: "http://www.usf.edu" }],
  });
  const florida = rule([{ field: "school.location", op: "contains", value: "florida" }]);
  assert.equal(evaluateRule(florida, { row: {}, facts }).matched, true);
});
