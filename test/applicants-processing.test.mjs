// The Processing view names Core's preparation stubs without turning them into
// applicant rows. A stub may lack a source observation or Paraform role while
// binding is still running, so it must remain visible and inert.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

import { createFeedHandler } from "../api/applicants/feed.mjs";
import { publishInto } from "./helpers/applicant-generation.mjs";

const AT = "2026-09-07T12:00:00.000Z";

function response() {
  return {
    body: undefined,
    headers: {},
    statusCode: undefined,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

test("feed projects Core preparation stubs separately from actionable snapshot rows", async () => {
  const state = {};
  publishInto(state, {
    snapshot: {
      generatedAt: AT,
      stream: [],
      profilePreparing: [{
        key: "app-001",
        profileKey: "core:app-001",
        sourceObservationId: null,
        state: "profile_preparing",
        name: "Morgan Example",
        roleTitle: "Product Designer",
        sourceJobId: "workable-42",
        roleId: null,
        company: "Raydar Client",
        appliedAt: "2026-09-07",
        addedAt: AT,
        receivedAt: "2026-09-07T11:58:00.000Z",
        reason: "source_profile_pending",
        interviewAllowed: true,
        privateUnexpectedField: "must not reach the browser",
      }],
    },
    queue: [],
  });
  const res = response();
  await createFeedHandler({
    corsHandler: () => false,
    authHandler: async () => true,
    kvReady: () => true,
    readJson: async (key) => state[key] ?? null,
    readHash: async () => ({}),
    now: () => Date.parse(AT),
  })({ method: "GET", headers: {}, query: {} }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.profilePreparing, 1);
  assert.equal(res.body.profileCache.counts.newToday, 1);
  // Receipt partition keeps its numeric count behavior, so a browser cannot
  // accidentally merge a stub into an actionable array.
  assert.equal(res.body.snapshot.profilePreparing, 1);
  assert.deepEqual(res.body.profilePreparingRows, [{
    key: "app-001",
    profileKey: "core:app-001",
    sourceObservationId: null,
    state: "profile_preparing",
    name: "Morgan Example",
    roleTitle: "Product Designer",
    sourceJobId: "workable-42",
    roleId: null,
    company: "Raydar Client",
    appliedAt: "2026-09-07",
    addedAt: AT,
    receivedAt: "2026-09-07T11:58:00.000Z",
    reason: "source_profile_pending",
    interviewAllowed: false,
  }]);
  assert.equal("privateUnexpectedField" in res.body.profilePreparingRows[0], false);
  assert.deepEqual(res.body.snapshot.queue, []);
  assert.deepEqual(res.body.snapshot.stream, []);
});

test("feed passes only an explicitly unverified pending source-details projection", async () => {
  const state = {};
  publishInto(state, {
    snapshot: { generatedAt: AT, stream: [], profilePreparing: [{
      key: "held-source", profileKey: "core:held-source", state: "needs_review",
      name: "Morgan Example", reason: "source_import_needs_review", interviewAllowed: true,
      sourceDetails: {
        state: "pending_source_review", label: "unexpected", provenance: "applicant_hub",
        verification: "unverified_source", ruleEligible: true, sourceObservationId: "source-1", observedAt: AT,
        historyState: "data", profile: {
          title: "Source title", location: "Austin",
          experiences: [{ roleTitle: "Source role", companyName: "Source company", description: "drop this" }],
          education: [{ school: "Source school", degree: "BA", description: "drop this" }],
        }, privateUnexpectedField: "drop this",
      },
    }] }, queue: [],
  });
  const res = response();
  await createFeedHandler({ corsHandler: () => false, authHandler: async () => true, kvReady: () => true,
    readJson: async (key) => state[key] ?? null, readHash: async () => ({}), now: () => Date.parse(AT),
  })({ method: "GET", headers: {}, query: {} }, res);
  const details = res.body.profilePreparingRows[0].sourceDetails;
  assert.equal(details.label, "Source details pending review");
  assert.equal(details.ruleEligible, false);
  assert.equal(details.profile.experiences[0].description, undefined);
  assert.equal(details.profile.education[0].description, undefined);
  assert.equal(details.privateUnexpectedField, undefined);
  assert.equal(res.body.profilePreparingRows[0].interviewAllowed, false);
});

test("feed preserves Core's terminal preparation state for the read-only view", async () => {
  const state = {};
  publishInto(state, {
    snapshot: {
      generatedAt: AT,
      stream: [],
      profilePreparing: [{
        key: "app-review",
        profileKey: "core:app-review",
        state: "needs_review",
        name: "Taylor Example",
        roleTitle: "Researcher",
        reason: "source_import_needs_review",
      }],
    },
    queue: [],
  });
  const res = response();
  await createFeedHandler({
    corsHandler: () => false,
    authHandler: async () => true,
    kvReady: () => true,
    readJson: async (key) => state[key] ?? null,
    readHash: async () => ({}),
    now: () => Date.parse(AT),
  })({ method: "GET", headers: {}, query: {} }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.profilePreparingRows[0].state, "needs_review");
  assert.equal(res.body.profilePreparingRows[0].reason, "source_import_needs_review");
  assert.equal(res.body.profilePreparingRows[0].interviewAllowed, false);
});

test("Processing is read-only and never requests cards or exposes actions", () => {
  const applicants = readFileSync(resolve("applicants.html"), "utf8");
  assert.match(applicants, /id="pillProcessing"/);
  assert.match(applicants, /id="processingView"/);
  assert.match(applicants, /function processingRowHtml\(row\)/);
  assert.match(applicants, /const PROCESSING_REVIEW_STATES = new Set/);
  assert.match(applicants, /"Needs attention"/);
  assert.match(applicants, /"Preparing application"/);
  assert.match(applicants, /function processingSourceDetailsHtml\(details\)/);
  assert.match(applicants, /Source details pending review/);
  assert.match(applicants, /not used by Rules/);
  assert.match(applicants, /source_import_needs_review: "Source import needs review\."/);
  assert.match(applicants, /const receivedAt = row\.receivedAt \|\| row\.addedAt \|\| row\.appliedAt \|\| null;/);
  assert.match(applicants, /const receivedLabel = row\.receivedAt \? "Received" : row\.addedAt \? "Added" : "Applied";/);
  assert.match(applicants, /paintList\(list, rows, processingRowHtml, \{ requestRichCards: false \}\)/);
  const processing = applicants.slice(applicants.indexOf("function processingRowHtml"), applicants.indexOf("function renderLists"));
  assert.doesNotMatch(processing, /data-act=|openProfile\(|rowCardHtml\(|requestVisibleRichCards\(|Source observation:|Profile key:/);
});

test("every Applicants view labels a missing applied-to company explicitly", () => {
  const applicants = readFileSync(resolve("applicants.html"), "utf8");
  const helperStart = applicants.indexOf("function appliedCompany(row)");
  const helperEnd = applicants.indexOf("function rowCardHtml", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "applied-company helper is extractable");
  const appliedCompany = runInNewContext(`${applicants.slice(helperStart, helperEnd)}; appliedCompany`);

  assert.equal(appliedCompany({ company: "  Acme Labs  " }), "Acme Labs");
  assert.equal(appliedCompany({ company: "   " }), "Unknown company");
  assert.equal(appliedCompany({}), "Unknown company");

  assert.match(applicants, /rc-applied[^\n]+esc\(appliedCompany\(row\)\)/);
  assert.match(applicants, /const company = " @ " \+ esc\(appliedCompany\(row\)\);/);
  assert.match(applicants, /p-applied[^\n]+esc\(appliedCompany\(row\)\)/);
});
