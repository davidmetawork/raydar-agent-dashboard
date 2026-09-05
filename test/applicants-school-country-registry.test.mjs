import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeSchoolCountryName,
  resolveSchoolCountryEvidence,
} from "../api/applicants/_lib/school-country-registry.mjs";

test("resolves exact active IPEDS institutions deterministically", () => {
  const utah = resolveSchoolCountryEvidence({ name: "University of Utah" });
  assert.deepEqual(utah, {
    country: "United States",
    match: "ipeds_exact_name",
    sourceURL: "https://nces.ed.gov/ipeds/datacenter/data/HD2024.zip",
    sourceVersion: "IPEDS HD2024",
    evidence: "NCES IPEDS Directory information exact normalized institution name or whole official alias",
    nameNormalized: "university of utah",
    unitid: "230764",
    name: "University of Utah",
    state: "UT",
    website: "www.utah.edu/",
    ipedsActivityStatus: "active",
  });

  const rowan = resolveSchoolCountryEvidence({ name: "Rowan University" });
  assert.equal(rowan?.country, "United States");
  assert.equal(rowan?.unitid, "184782");
  assert.equal(rowan?.state, "NJ");
});

test("whole official aliases match, while ambiguous aliases fail closed", () => {
  const virginiaTech = resolveSchoolCountryEvidence({ name: "Virginia Tech" });
  assert.equal(virginiaTech?.match, "ipeds_whole_alias");
  assert.equal(virginiaTech?.name, "Virginia Polytechnic Institute and State University");

  const formerRowanName = resolveSchoolCountryEvidence({ name: "Rowan College of New Jersey" });
  const formerRowanNameTwo = resolveSchoolCountryEvidence({ name: "Glassboro State College" });
  assert.equal(formerRowanName?.unitid, "184782");
  assert.equal(formerRowanNameTwo?.unitid, "184782");

  const southernChristian = resolveSchoolCountryEvidence({ name: "Southern Christian University" });
  const regions = resolveSchoolCountryEvidence({ name: "Regions University" });
  assert.equal(southernChristian?.unitid, "100690");
  assert.equal(regions?.unitid, "100690");

  // HD2024 has both Missouri and Pennsylvania institutions named Westminster
  // College. An unqualified typed name cannot select either one.
  assert.equal(resolveSchoolCountryEvidence({ name: "Westminster College" }), null);
});

test("foreign country text vetoes an otherwise exact US name or website", () => {
  assert.equal(resolveSchoolCountryEvidence({
    name: "University of Utah",
    location: "New Delhi, India",
    website: "https://www.utah.edu/",
  }), null);
  assert.equal(resolveSchoolCountryEvidence({
    name: "University of Utah", location: "India", website: "https://pes.edu/",
  }), null, "a bare foreign country vetoes the exact US name and .edu");
  assert.equal(resolveSchoolCountryEvidence({
    name: "University of Georgia", location: "Georgia", website: "https://www.uga.edu/",
  })?.country, "United States", "a bare Georgia remains the ambiguous state form, not a foreign veto");
});

test("historical state/DC institutions remain country-only evidence", () => {
  const result = resolveSchoolCountryEvidence({ name: "Birmingham-Southern College" });
  assert.equal(result?.country, "United States");
  assert.equal(result?.ipedsActivityStatus, "historical_or_other");
  assert.equal(result?.unitid, "100937");
});

test("parenthetical foreign campuses remain unmatched", () => {
  assert.equal(normalizeSchoolCountryName("Carnegie Mellon University (Qatar)"), "carnegie mellon university qatar");
  assert.equal(resolveSchoolCountryEvidence({ name: "Carnegie Mellon University (Qatar)" }), null);
  assert.equal(resolveSchoolCountryEvidence({ name: "Carnegie Mellon University", location: "Doha, Qatar" }), null);
});

test("missing names and territories never become automatic US-state matches", () => {
  assert.equal(resolveSchoolCountryEvidence(), null);
  assert.equal(resolveSchoolCountryEvidence({ name: "" }), null);
  // Puerto Rico is intentionally outside the data selection until the saved
  // rule's meaning of US is separately decided.
  assert.equal(resolveSchoolCountryEvidence({ name: "University of Puerto Rico-Mayaguez" }), null);
});

test("reviewed generic system aliases prove country only", () => {
  const result = resolveSchoolCountryEvidence({ name: "University of Washington" });
  assert.equal(result?.country, "United States");
  assert.equal(result?.match, "reviewed_country_only_alias");
  assert.equal(result?.unitid, null);
  assert.equal(result?.state, null);
});
