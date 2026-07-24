import test from "node:test";
import assert from "node:assert/strict";

import { PARAAI_LOCATIONS, extraNote } from "../api/paraai/_lib/extract.mjs";
import {
  PARAAI_NA_LOCATIONS,
  PARAAI_SALARY_DEFAULT_MIN,
  PARAAI_STAGE_ORDER,
  buildPreferenceRouting,
  buildPreferences,
} from "../api/paraai/_lib/pipeline.mjs";

const ALL_LOCATIONS = [...PARAAI_LOCATIONS];
const ALL_STAGES = [
  "PRE_SEED", "SEED", "SERIES_A", "SERIES_B", "SERIES_C", "SERIES_D_PLUS", "UNKNOWN",
];
const ALL_WORKPLACES = ["REMOTE", "HYBRID", "ON_SITE"];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test("load-bearing stage and North America orders are explicit", () => {
  assert.deepEqual(PARAAI_STAGE_ORDER, ALL_STAGES);
  assert.deepEqual(PARAAI_NA_LOCATIONS, [
    "new_york", "san_francisco", "south_bay_area", "los_angeles", "boston", "seattle",
    "texas", "chicago", "washington_dc", "denver", "florida", "minnesota", "sacramento",
    "canada",
  ]);
});

test("workplace routing distinguishes remote-only from a remote mention", () => {
  const remoteOnly = buildPreferenceRouting({
    workplaceTypes: ["REMOTE"],
    excludedWorkplaceTypes: ["HYBRID", "ON_SITE"],
  });
  assert.deepEqual(remoteOnly.preferences.workplaceTypes, ["REMOTE"]);
  assert.equal(remoteOnly.policy.workplaceSource, "screening_call");
  assert.deepEqual(remoteOnly.policy.provenance.workplaceTypes, {
    stated: ["REMOTE"],
    routed: ["REMOTE"],
    rule: "workplace_remote_only",
    excluded: ["HYBRID", "ON_SITE"],
  });

  const remoteMention = buildPreferenceRouting({ workplaceTypes: ["REMOTE"] });
  assert.deepEqual(remoteMention.preferences.workplaceTypes, ALL_WORKPLACES);
  assert.equal(remoteMention.policy.workplaceSource, "ladder_expansion");
});

test("hybrid and on-site mentions route all three, then explicit rejections subtract", () => {
  const hybrid = buildPreferenceRouting({
    workplaceTypes: ["HYBRID"],
    excludedWorkplaceTypes: ["ON_SITE"],
  });
  assert.deepEqual(hybrid.preferences.workplaceTypes, ["REMOTE", "HYBRID"]);
  assert.equal(hybrid.policy.provenance.workplaceTypes.rule, "workplace_all_three_hybrid");

  const onsite = buildPreferences({ workplaceTypes: ["ON_SITE"] });
  assert.deepEqual(onsite.workplaceTypes, ALL_WORKPLACES);

  const flexible = buildPreferenceRouting({ searchActivity: "I am flexible on workplace and work model." });
  assert.deepEqual(flexible.preferences.workplaceTypes, ALL_WORKPLACES);
  assert.equal(flexible.policy.preferenceRouting.workplaceTypes.rule, "workplace_all_three_flexible");
});

test("workplace falls back to native profile and otherwise selects all", () => {
  const native = buildPreferenceRouting({}, { workplace: ["REMOTE"] });
  assert.deepEqual(native.preferences.workplaceTypes, ["REMOTE"]);
  assert.equal(native.policy.workplaceSource, "paraform_profile");

  const unknown = buildPreferenceRouting({});
  assert.deepEqual(unknown.preferences.workplaceTypes, ALL_WORKPLACES);
  assert.equal(unknown.policy.workplaceSource, "select_all_default");
  assert.equal(unknown.policy.provenance.workplaceTypes.rule, "select_all_unknown");
});

test("the unified stage ladder applies minus two through UNKNOWN", () => {
  const cases = [
    [["SEED"], ALL_STAGES],
    [["SERIES_A"], ALL_STAGES],
    [["SERIES_B"], ALL_STAGES.slice(1)],
    [["SERIES_C"], ALL_STAGES.slice(2)],
    [["SERIES_D_PLUS"], ALL_STAGES.slice(3)],
  ];
  for (const [stated, expected] of cases) {
    const routing = buildPreferenceRouting({ companyStages: stated });
    assert.deepEqual(routing.preferences.idealFundingRounds, expected);
    assert.equal(routing.policy.provenance.idealFundingRounds.rule, "stage_ladder_minus2");
  }
});

test("native stages use the same ladder and no signal selects all seven", () => {
  assert.deepEqual(
    buildPreferences({}, { last_funding_round: ["SEED"] }).idealFundingRounds,
    ALL_STAGES,
  );
  assert.deepEqual(
    buildPreferences({}, { last_funding_round: "SERIES_B" }).idealFundingRounds,
    ALL_STAGES.slice(1),
  );
  const unknown = buildPreferenceRouting({});
  assert.deepEqual(unknown.preferences.idealFundingRounds, ALL_STAGES);
  assert.equal(unknown.policy.provenance.idealFundingRounds.rule, "select_all_unknown");
});

test("broad, growth, and public stage language route through the same ordered policy", () => {
  const broad = buildPreferences({
    searchActivity: "I am flexible and have worked across all company sizes.",
  });
  assert.deepEqual(broad.idealFundingRounds, ALL_STAGES);

  const growth = buildPreferences({
    searchActivity: "I am interested in growth-stage companies.",
  });
  assert.deepEqual(growth.idealFundingRounds, ALL_STAGES.slice(1));

  const publicOnly = buildPreferences({
    searchActivity: "Only public or IPO-stage companies.",
  });
  assert.deepEqual(publicOnly.idealFundingRounds, ALL_STAGES.slice(3));
});

test("stage exclusions always subtract, including UNKNOWN", () => {
  const preferences = buildPreferences({
    companyStages: ["SERIES_C"],
    excludedCompanyStages: ["SERIES_B", "UNKNOWN"],
  });
  assert.deepEqual(preferences.idealFundingRounds, ["SERIES_A", "SERIES_C", "SERIES_D_PLUS"]);
});

test("a Berlin relocation refusal stays in the candidate's own geography", () => {
  const routing = buildPreferenceRouting(
    { relocation: { open: false, scope: "I am not willing to relocate." } },
    null,
    { currentLocation: "Berlin, Germany", country: "Germany" },
  );
  assert.deepEqual(routing.preferences.locations, ["europe"]);
  assert.equal(routing.policy.provenance.locations.rule, "location_relocation_refusal");
  assert.equal(routing.policy.locationReviewNote, null);
});

test("an unlisted non-US city falls back to its country region", () => {
  const routing = buildPreferenceRouting(
    {
      relocation: {
        open: false,
        scope: "I am not willing to relocate.",
        evidence: "I am not willing to relocate.",
      },
    },
    null,
    { currentLocation: "Krakow", country: "Poland" },
  );
  assert.deepEqual(routing.preferences.locations, ["europe"]);
  assert.equal(routing.policy.provenance.locations.rule, "location_relocation_refusal");
});

test("a refusal with wholly unknown geography selects all with a non-blocking note", () => {
  const routing = buildPreferenceRouting({
    relocation: { open: false, scope: "I cannot relocate." },
  });
  assert.deepEqual(routing.preferences.locations, ALL_LOCATIONS);
  assert.equal(routing.policy.locationSource, "select_all_default");
  assert.equal(routing.policy.provenance.locations.rule, "select_all_default");
  assert.match(routing.policy.locationReviewNote, /current geography is unknown/i);
});

test("positive US relocation routes the NA set and the word only does not block it", () => {
  const routing = buildPreferenceRouting({
    locations: ["Austin"],
    relocation: {
      open: true,
      scope: "I would only relocate to Austin for the right role.",
      evidence: "I would only relocate to Austin for the right role.",
    },
  });
  assert.deepEqual(routing.preferences.locations, PARAAI_NA_LOCATIONS);
  assert.equal(routing.policy.provenance.locations.rule, "location_na_set");
});

test("international openness routes all 21 and explicit exclusions still subtract", () => {
  const routing = buildPreferenceRouting({
    locations: ["London"],
    relocation: { open: true, scope: "I am open to London and anywhere internationally." },
    excludedParaformLocations: ["australia"],
  });
  assert.deepEqual(
    routing.preferences.locations,
    ALL_LOCATIONS.filter((location) => location !== "australia"),
  );
  assert.equal(routing.policy.provenance.locations.rule, "location_all_21");

  const canada = buildPreferenceRouting({ paraformLocations: ["canada"] });
  assert.deepEqual(canada.preferences.locations, ALL_LOCATIONS);
});

test("international candidate open to US-remote gets NA plus the home region", () => {
  const routing = buildPreferenceRouting(
    {
      locations: ["US remote"],
      workplaceTypes: ["REMOTE"],
      relocation: { open: null, scope: "Open to US remote roles." },
    },
    null,
    { currentLocation: "Lahore, Pakistan", country: "Pakistan" },
  );
  assert.deepEqual(routing.preferences.locations, [...PARAAI_NA_LOCATIONS, "asia"]);
  assert.equal(routing.policy.provenance.locations.rule, "location_us_remote_plus_home");
});

test("no location discussion uses profile locations and includes mapped current metro", () => {
  const routing = buildPreferenceRouting(
    {},
    { locations: ["texas"] },
    { currentLocation: "New York, NY", country: "United States" },
  );
  assert.deepEqual(routing.preferences.locations, ["texas", "new_york"]);
  assert.equal(routing.policy.locationSource, "paraform_profile");
});

test("location aliases and current-location fallbacks preserve geography", () => {
  const bayArea = buildPreferenceRouting(
    { relocation: { open: false, scope: "I will not relocate." } },
    null,
    { currentLocation: "Silicon Valley, CA", country: "United States" },
  );
  assert.deepEqual(bayArea.preferences.locations, ["south_bay_area", "san_francisco"]);

  const nashville = buildPreferenceRouting(
    { relocation: { open: false, scope: "I will not relocate." } },
    null,
    { currentLocation: "Nashville, TN" },
  );
  assert.deepEqual(nashville.preferences.locations, PARAAI_NA_LOCATIONS);

  const london = buildPreferenceRouting(
    {
      locations: ["London"],
      relocation: { open: false, scope: "I cannot relocate outside London." },
    },
  );
  assert.deepEqual(london.preferences.locations, ["uk"]);
});

test("location exclusions subtract from defaults, expansions, and current mapping", () => {
  const routing = buildPreferenceRouting(
    {
      relocation: { open: true, scope: "Open to relocating within the US." },
      excludedParaformLocations: ["new_york", "canada"],
    },
    null,
    { currentLocation: "New York, NY", country: "United States" },
  );
  assert.deepEqual(
    routing.preferences.locations,
    PARAAI_NA_LOCATIONS.filter((location) => !["new_york", "canada"].includes(location)),
  );
});

test("salary precedence is call, profile, then the configured 120k default", () => {
  const stated = buildPreferenceRouting(
    { compensation: { baseMin: 24_000, currency: "USD" } },
    { salary_min: 180_000 },
  );
  assert.equal(stated.preferences.salaryMin, 24_000);
  assert.equal(stated.policy.salarySource, "screening_call");
  assert.deepEqual(stated.policy.provenance.salaryMin, {
    stated: 24_000,
    routed: 24_000,
    rule: "salary_stated",
    currency: "USD",
  });

  const native = buildPreferenceRouting({}, { salary_min: 150_000 });
  assert.equal(native.preferences.salaryMin, 150_000);
  assert.equal(native.policy.salarySource, "paraform_profile");

  const fallback = buildPreferenceRouting({});
  assert.equal(fallback.preferences.salaryMin, PARAAI_SALARY_DEFAULT_MIN);
  assert.equal(fallback.policy.salarySource, "default_120k");
  assert.equal(fallback.policy.provenance.salaryMin.rule, "salary_default_120k");
});

test("only a verified hard floor gets the 10k buffer, before the 200k cap", () => {
  const verified = buildPreferenceRouting({
    compensation: {
      baseMin: 180_000,
      baseMinIsHardFloor: true,
      baseMinEvidence: "My hard minimum is $180,000.",
    },
  });
  assert.equal(verified.preferences.salaryMin, 170_000);
  assert.equal(verified.policy.salaryRoutingBuffer, 10_000);
  assert.equal(verified.policy.provenance.salaryMin.rule, "salary_hard_floor_minus_10k");

  const unverified = buildPreferenceRouting({
    compensation: { baseMin: 180_000, notes: "hard minimum" },
  });
  assert.equal(unverified.preferences.salaryMin, 180_000);
  assert.equal(unverified.policy.salaryWasWidened, false);

  const capped = buildPreferenceRouting({
    compensation: { baseMin: 400_000, baseMinIsHardFloor: true },
  });
  assert.equal(capped.preferences.salaryMin, 200_000);
  assert.equal(capped.policy.salaryWasCapped, true);
});

test("OTE is never routed below salary minimum", () => {
  const preferences = buildPreferences({
    compensation: { baseMin: 150_000, ote: 140_000 },
  });
  assert.equal(preferences.ote, 150_000);
  assert.equal(buildPreferenceRouting(
    {},
    { salary_min: 120_000, ote: 250_000 },
  ).preferences.ote, undefined);
});

test("visa uses explicit strict mapping, then native profile", () => {
  assert.deepEqual(
    buildPreferences({ sponsorship: { required: true, statuses: ["VISA"] } }).requiresSponsorship,
    ["Available"],
  );
  assert.deepEqual(
    buildPreferences({ sponsorship: { required: false, statuses: ["GREEN_CARD"] } }).requiresSponsorship,
    ["Not available"],
  );
  const native = buildPreferenceRouting({}, { visa: ["Available"] });
  assert.deepEqual(native.preferences.requiresSponsorship, ["Available"]);
  assert.equal(native.policy.visaSource, "paraform_profile");
});

test("US geography defaults visa to Not available even for an unmappable city", () => {
  const routing = buildPreferenceRouting(
    {},
    null,
    { currentLocation: "Nashville", country: "United States" },
  );
  assert.deepEqual(routing.preferences.requiresSponsorship, ["Not available"]);
  assert.equal(routing.policy.visaSource, "visa_default_us");
  assert.equal(routing.policy.provenance.requiresSponsorship.rule, "visa_default_us");
  assert.equal(routing.policy.sponsorshipReviewReason, null);
});

test("US work-authorization context can establish the visa default", () => {
  const routing = buildPreferenceRouting({
    sponsorship: { kind: "Authorized to work in the United States" },
  });
  assert.deepEqual(routing.preferences.requiresSponsorship, ["Not available"]);
  assert.equal(routing.policy.visaSource, "visa_default_us");
});

test("international no-signal visa stays empty with the exact review reason", () => {
  const routing = buildPreferenceRouting(
    {},
    null,
    { currentLocation: "Berlin, Germany", country: "Germany" },
  );
  assert.deepEqual(routing.preferences.requiresSponsorship, []);
  assert.equal(routing.policy.sponsorshipReviewReason, "sponsorship unknown for international candidate");
});

test("routing records stated-routed-rule provenance without mutating extraction", () => {
  const extracted = {
    paraformLocations: ["new_york"],
    workplaceTypes: ["HYBRID"],
    companyStages: ["SERIES_C"],
    compensation: { baseMin: 180_000, currency: "USD" },
    sponsorship: { required: false, statuses: ["CITIZEN"] },
  };
  const original = clone(extracted);
  const routing = buildPreferenceRouting(extracted);

  assert.equal(routing.policy.preferenceRouting, routing.policy.provenance);
  for (const field of [
    "workplaceTypes", "idealFundingRounds", "locations", "salaryMin", "requiresSponsorship",
  ]) {
    assert.equal(Object.hasOwn(routing.policy.preferenceRouting[field], "stated"), true);
    assert.equal(Object.hasOwn(routing.policy.preferenceRouting[field], "routed"), true);
    assert.equal(typeof routing.policy.preferenceRouting[field].rule, "string");
  }
  const note = extraNote(extracted, routing.policy.preferenceRouting);
  assert.match(note, /Para AI preference routing/);
  assert.match(note, /USD 180,000 → USD 180,000 \(salary_stated\)/);
  assert.deepEqual(extracted, original);
});
