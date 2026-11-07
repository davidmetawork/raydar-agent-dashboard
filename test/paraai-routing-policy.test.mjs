import test from "node:test";
import assert from "node:assert/strict";

import { FUNDING_ROUNDS, PARAAI_LOCATIONS } from "../api/paraai/_lib/extract.mjs";
import { buildPreferences } from "../api/paraai/_lib/pipeline.mjs";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test("open relocation to any specific city widens to every Paraform location", () => {
  const extracted = {
    locations: [],
    paraformLocations: [],
    relocation: {
      open: true,
      scope: "I am open to relocating to any specific city for the right role.",
    },
    workplaceTypes: ["HYBRID"],
    compensation: { baseMin: 180000 },
    companyStages: ["SERIES_A"],
    sponsorship: { required: false, statuses: ["CITIZEN"] },
  };
  const rawEvidence = clone(extracted);
  const preferences = buildPreferences(extracted);

  assert.deepEqual(
    [...preferences.locations].sort(),
    [...PARAAI_LOCATIONS].sort(),
  );
  assert.deepEqual(extracted, rawEvidence, "derived routing must not rewrite extracted transcript evidence");
  assert.equal(extracted.relocation.scope, "I am open to relocating to any specific city for the right role.");
});

test("verified relocation evidence widens locations even when the scope summary is absent", () => {
  const preferences = buildPreferences({
    relocation: {
      open: true,
      scope: null,
      evidence: "I am open to relocating to Austin for the right role.",
    },
  });
  assert.deepEqual(
    [...preferences.locations].sort(),
    [...PARAAI_LOCATIONS].sort(),
  );
});

test("relocation widening fails closed when the candidate states an explicit negative", () => {
  const extracted = {
    locations: ["Texas"],
    paraformLocations: ["texas"],
    relocation: {
      open: true,
      scope: "Anywhere except New York; I would not relocate there.",
    },
    workplaceTypes: ["HYBRID"],
    compensation: { baseMin: 180000 },
    companyStages: ["SERIES_A"],
    sponsorship: { required: false, statuses: ["CITIZEN"] },
  };
  const preferences = buildPreferences(extracted);
  assert.deepEqual(preferences.locations, ["texas"]);
  assert.equal(preferences.locations.includes("new_york"), false);
});

test("stated minimum base salary gets a ten-thousand-dollar routing buffer", () => {
  const extracted = {
    paraformLocations: ["new_york"],
    workplaceTypes: ["REMOTE"],
    compensation: {
      baseMin: 180000,
      baseMinIsHardFloor: true,
      notes: "Candidate explicitly described $180,000 as their hard minimum.",
    },
    companyStages: ["SERIES_A"],
    sponsorship: { required: false, statuses: ["CITIZEN"] },
  };
  const rawEvidence = clone(extracted);
  const preferences = buildPreferences(extracted);

  assert.equal(preferences.salaryMin, 170000);
  assert.deepEqual(extracted, rawEvidence, "the stated hard minimum must remain available for audit");
  assert.equal(extracted.compensation.baseMin, 180000);
});

test("salary routing buffer is applied before the absolute two-hundred-thousand cap", () => {
  const justAboveCap = buildPreferences({
    paraformLocations: ["new_york"],
    workplaceTypes: ["REMOTE"],
    compensation: { baseMin: 205000, notes: "hard minimum" },
    companyStages: ["SERIES_A"],
    sponsorship: { required: false, statuses: ["CITIZEN"] },
  });
  assert.equal(justAboveCap.salaryMin, 195000);

  const farAboveCap = buildPreferences({
    paraformLocations: ["new_york"],
    workplaceTypes: ["REMOTE"],
    compensation: { baseMin: 400000, notes: "hard minimum" },
    companyStages: ["SERIES_A"],
    sponsorship: { required: false, statuses: ["CITIZEN"] },
  });
  assert.equal(farAboveCap.salaryMin, 200000);
});

test("explicit startup openness widens to every Paraform company stage", () => {
  const extracted = {
    paraformLocations: ["new_york"],
    workplaceTypes: ["REMOTE"],
    compensation: { baseMin: 180000 },
    companyStages: [],
    industries: {
      interested: ["Startups"],
      notInterested: [],
    },
    searchActivity: "Open to startups at any funding stage.",
    sponsorship: { required: false, statuses: ["CITIZEN"] },
  };
  const rawEvidence = clone(extracted);
  const preferences = buildPreferences(extracted);

  assert.deepEqual(
    [...preferences.idealFundingRounds].sort(),
    [...FUNDING_ROUNDS].sort(),
  );
  assert.deepEqual(extracted, rawEvidence, "startup evidence must remain raw while preferences are widened");
  assert.equal(extracted.searchActivity, "Open to startups at any funding stage.");
});

test("verified broad startup openness overrides a narrower preferred stage", () => {
  const preferences = buildPreferences({
    openToStartups: true,
    companyStages: ["SERIES_A"],
    excludedCompanyStages: ["UNKNOWN"],
  });
  assert.deepEqual(
    [...preferences.idealFundingRounds].sort(),
    [...FUNDING_ROUNDS].filter((stage) => stage !== "UNKNOWN").sort(),
  );
});

test("startup widening does not override an explicit startup negative", () => {
  const startupNegative = buildPreferences({
    paraformLocations: ["new_york"],
    workplaceTypes: ["REMOTE"],
    compensation: { baseMin: 180000 },
    companyStages: [],
    industries: {
      interested: [],
      notInterested: ["Startups"],
    },
    searchActivity: "I do not want to work at a startup.",
    sponsorship: { required: false, statuses: ["CITIZEN"] },
  });
  assert.deepEqual(startupNegative.idealFundingRounds, []);
});

test("explicit false and negated salary evidence never receive the routing buffer", () => {
  const explicitFalse = buildPreferences({
    compensation: {
      baseMin: 180000,
      baseMinIsHardFloor: false,
      notes: "This is not a hard minimum; it is only a target.",
    },
  });
  assert.equal(explicitFalse.salaryMin, 180000);

  const legacyNegated = buildPreferences({
    compensation: {
      baseMin: 180000,
      notes: "This is not a hard minimum; I am flexible.",
    },
  });
  assert.equal(legacyNegated.salaryMin, 180000);
});

test("startup wording with trailing negation never widens stages", () => {
  const preferences = buildPreferences({
    companyStages: [],
    industries: { interested: [], notInterested: [] },
    searchActivity: "I would consider different companies, but startups are not for me.",
  });
  assert.deepEqual(preferences.idealFundingRounds, []);
});

test("relocation exclusions are removed from expanded and fallback locations", () => {
  const expanded = buildPreferences({
    paraformLocations: ["texas", "new_york"],
    excludedParaformLocations: ["new_york"],
    relocation: {
      open: true,
      scope: "I can relocate broadly except New York.",
    },
  });
  assert.equal(expanded.locations.includes("new_york"), false);
  assert.equal(expanded.locations.includes("texas"), true);

  const restricted = buildPreferences({
    paraformLocations: ["texas", "new_york"],
    excludedParaformLocations: ["new_york"],
    relocation: {
      open: true,
      scope: "I would only relocate to Texas.",
    },
  });
  assert.deepEqual(restricted.locations, ["texas"]);
});
