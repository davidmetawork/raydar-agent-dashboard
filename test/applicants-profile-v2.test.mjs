import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { applicantProblemsV2, applicantRowsV2FromSnapshot } from "../api/applicants/_lib/profile-v2.mjs";
import { createFeedHandler } from "../api/applicants/feed.mjs";
import { createProfileHandler } from "../api/applicants/profile.mjs";
import { createProblemsHandler } from "../api/applicants/problems.mjs";
import { publishInto, sourceReceiptsFor } from "./helpers/applicant-generation.mjs";
import { K } from "../api/applicants/_lib/kv.mjs";

const AT = "2026-09-07T12:00:00.000Z";
const KEY = "candidatev2:rolev2";
const queueRow = { key: KEY, cuId: "candidatev2", profileKey: "candidatev2", sourceObservationId: "obs-v2", name: "V2 Applicant", roleTitle: "Legacy title", company: "Legacy Co" };
const v2 = {
  application: { applicationId: "application-v2", tenantScopeId: "tenant-v2", personId: "person-v2", sourceObservationId: "obs-v2", rowRevision: "row-2",
    appliedTo: { roleVersionId: "role-version-v2", roleId: "role-v2", title: "Applied Platform Engineer",
      hiringCompany: { name: "Applied Co", source: "role_version", observedAt: AT, version: "role-version-v2", state: "verified" } } },
  profile: { facts: {
    name: { value: "V2 Applicant", source: "paraform_linkedin", observedAt: AT, factVersion: "p-2", freshness: "current", state: "verified" },
    title: { value: "Cached LinkedIn Headline", source: "paraform_linkedin", observedAt: AT, factVersion: "p-2", freshness: "current", state: "verified" },
    location: { value: "Austin", source: "resume", observedAt: AT, factVersion: "r-2", freshness: "stale", state: "fallback" },
    experiences: { entries: [{ recordId: "experience-v2", companyId: "company-v2", roleTitle: "Provider role", companyName: "Provider Co", description: "Full provider role detail", logo: "https://storage.googleapis.com/paraform-company-logo-urls/company-logos/company-v2.png", source: "paraform_linkedin", observedAt: AT, factVersion: "p-2", freshness: "current", state: "verified" }], source: "paraform_linkedin", observedAt: AT, factVersion: "p-2", freshness: "current", state: "verified" },
    education: { entries: [{ recordId: "school-v2", schoolId: "school-v2", school: "Provider University", degree: "BS", description: "Full school detail", logo: "https://storage.googleapis.com/paraform-company-logo-urls/company-logos/school-v2.png", source: "paraform_linkedin", observedAt: AT, factVersion: "p-2", freshness: "current", state: "verified" }], source: "paraform_linkedin", observedAt: AT, factVersion: "p-2", freshness: "current", state: "verified" },
  }, paraform: { source: "paraform_linkedin", state: "available", validity: "usable" }, resume: { source: "resume", state: "available", validity: "usable" },
    selectedResume: { artifactId: "resume-v2", digest: "digest-v2", parserVersion: "parser-v2", state: "available" } },
  actionability: { eligibility: "waiting", reasons: ["profile_pending"], readinessRevision: "ready-2", canCreateApproval: true, approvalState: "required" },
  invitation: { state: "queued", reasonCode: "invitation_queued", reason: "The worker is preparing the invitation", requestedAt: AT, ageSeconds: 301, nextAttemptAt: "2026-09-07T12:05:00.000Z", providerAcceptedAt: null },
  problems: [{ code: "applied_hiring_company_unknown", state: "open", applicationId: "application-v2", domain: "application",
    nextAction: "Confirm the exact role metadata", owner: "Raydar", affectedCount: 2, sharedIncidentId: "incident-v2" }],
  factSetDigest: "a".repeat(64),
};

function response() { return { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } }; }
function state() {
  const value = {};
  publishInto(value, { snapshot: { generatedAt: AT, stream: [], applicantRowsV2: { [KEY]: v2 }, problems: [{ code: "source_problem", state: "open", key: KEY, domain: "source" }] }, queue: [queueRow] });
  value[K.sourceProfileReady] = sourceReceiptsFor([queueRow]);
  value[K.sourceProfile("candidatev2")] = { name: "V2 Applicant", title: "Source headline", sourceObservationId: "obs-v2", experiences: [], education: [] };
  return value;
}
function deps(value) { return { corsHandler: () => false, authHandler: async () => true, kvReady: () => true,
  readJson: async (key) => value[key] ?? null, readHash: async (key) => value[key] ?? {}, now: () => Date.parse(AT) }; }

test("V2 adapter preserves Core fact provenance and rejects a cross-tenant row", () => {
  const rows = applicantRowsV2FromSnapshot({ applicantRowsV2: { [KEY]: v2, bad: { ...v2, application: { ...v2.application, tenantScopeId: "" } } } });
  assert.deepEqual(Object.keys(rows), [KEY]);
  assert.equal(rows[KEY].profile.facts.title.source, "paraform_linkedin");
  assert.equal(rows[KEY].profile.facts.location.source, "resume");
  assert.equal(rows[KEY].profile.facts.experiences.entries[0].companyName, "Provider Co");
  assert.equal(rows[KEY].profile.facts.experiences.entries[0].description, "Full provider role detail");
  assert.match(rows[KEY].profile.facts.experiences.entries[0].logo, /company-v2\.png$/);
  assert.equal(rows[KEY].profile.facts.education.entries[0].description, "Full school detail");
  assert.match(rows[KEY].profile.facts.education.entries[0].logo, /school-v2\.png$/);
  const rejectedLogo = applicantRowsV2FromSnapshot({ applicantRowsV2: { [KEY]: { ...v2, profile: { ...v2.profile, facts: { ...v2.profile.facts,
    experiences: { ...v2.profile.facts.experiences, entries: [{ ...v2.profile.facts.experiences.entries[0], logo: "https://untrusted.example/logo.png" }] },
    education: { ...v2.profile.facts.education, entries: [{ ...v2.profile.facts.education.entries[0], schoolId: null }] },
  } } } } })[KEY];
  assert.equal(rejectedLogo.profile.facts.experiences.entries[0].logo, null);
  assert.equal(rejectedLogo.profile.facts.education.entries[0].logo, null);
  assert.equal(rows[KEY].factSetDigest, "a".repeat(64));
  assert.equal(rows[KEY].invitation.reason, "The worker is preparing the invitation");
  assert.equal(rows[KEY].invitation.ageSeconds, 301);
  assert.equal(rows[KEY].problems[0].nextAction, "Confirm the exact role metadata");
  assert.equal(rows[KEY].problems[0].affectedCount, 2);

  const unavailable = applicantRowsV2FromSnapshot({ applicantRowsV2: { [KEY]: {
    ...v2, profile: { ...v2.profile, facts: { ...v2.profile.facts,
      title: { ...v2.profile.facts.title, value: "Stale profile title", state: "unavailable" },
      experiences: { ...v2.profile.facts.experiences, entries: [{ ...v2.profile.facts.experiences.entries[0], state: "unavailable" }] },
      education: { ...v2.profile.facts.education, state: "unavailable" },
    } },
  } } })[KEY];
  assert.equal(unavailable.profile.facts.title.value, null);
  assert.deepEqual(unavailable.profile.facts.experiences.entries, []);
  assert.deepEqual(unavailable.profile.facts.education.entries, []);
});

test("feed returns an additive V2 map and Problems from the same verified generation", async () => {
  const value = state(); const res = response();
  await createFeedHandler(deps(value))({ method: "GET", headers: {}, query: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.snapshot.queue[0].key, KEY, "legacy queue remains present");
  assert.equal(res.body.applicantRowsV2[KEY].application.appliedTo.title, "Applied Platform Engineer");
  assert.deepEqual(res.body.problems.map((problem) => problem.code).sort(), ["applied_hiring_company_unknown", "source_problem"]);
});

test("Problems endpoint is read-only and returns the same deduplicated projection", async () => {
  const value = state(); const res = response();
  await createProblemsHandler(deps(value))({ method: "GET", headers: {}, query: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.problems.length, 2);
  assert.equal(res.body.generation.generationId, "gen-fixture-0001");
  const rows = applicantRowsV2FromSnapshot({ applicantRowsV2: { [KEY]: v2 } });
  assert.equal(applicantProblemsV2(rows, [{ code: "applied_hiring_company_unknown", applicationId: "application-v2" }]).length, 1);
});


test("profile read returns the exact V2 row only alongside the matching source profile", async () => {
  const value = state(); const res = response();
  await createProfileHandler({ ...deps(value), readMany: async () => ({}) })({ method: "GET", headers: {}, query: { cu: "candidatev2" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.title, "Source headline");
  assert.equal(res.body.profileV2.application.applicationId, "application-v2");
  assert.equal(res.body.profileV2.factSetDigest, "a".repeat(64));
});

test("Applicants V2 UI keeps the existing virtualized shell and adds Ready, Preparing, and Problems read views", async () => {
  const page = await readFile(new URL("../applicants.html", import.meta.url), "utf8");
  assert.match(page, /id="pillReview"[^>]*>Ready/);
  assert.match(page, /id="pillProcessing"[^>]*>Preparing/);
  assert.match(page, /id="pillProblems" onclick="setView\('problems'\)">Problems/);
  assert.match(page, /function applicantRowV2\(row\)/);
  assert.match(page, /function v2HistoryForRow\(row, options = \{\}\)/);
  assert.match(page, /function v2CardProvenanceHtml\(row\)/);
  assert.match(page, /\["Location", applicantFact\(row, "location"\)\]/);
  assert.match(page, /source === "resume" \? "Resume fallback"/);
  assert.match(page, /function invitationStatusHtml\(row\)/);
  assert.match(page, /Interview request waiting/);
  assert.match(page, /function invitationAgeText\(seconds\)/);
  assert.match(page, /function interviewControl\(row\)/);
  assert.match(page, /eligibility === "waiting"[\s\S]*label: "Interview when ready", enabled: true/);
  assert.match(page, /if \(actionability\) return \{ label: "Preparing", enabled: false/);
  assert.match(page, /function renderProblems\(\)/);
  assert.match(page, /Owner: unassigned/);
  assert.match(page, /Shared incident affecting/);
  assert.match(page, /applicantRowsV2: \{\}/);
  assert.match(page, /fetch\("\/api\/applicants\/feed"/);
  assert.doesNotMatch(page, /candidateUser\.getLinkedInCandidate/);
  assert.match(page, /const v2RuleFactsReady = modal\.source === "queue" && Boolean\(projected\?\.factSetDigest\)/);
  assert.match(page, /data-rule-fact-source="v2"/);
  assert.match(page, /source === "v2" \? v2RuleFactsReady/);
  assert.match(page, /hasV2Projection && !v2RuleFactsReady/);
  assert.match(page, /const projectedTitle = applicantFact\(row, "title"\)\?\.value/);
  assert.match(page, /projectedTitle \|\| display\.title \|\| card\?\.title/);
});
