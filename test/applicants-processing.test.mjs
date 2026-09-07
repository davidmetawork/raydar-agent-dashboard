// The Processing view names Core's preparation stubs without turning them into
// applicant rows. A stub may lack a source observation or Paraform role while
// binding is still running, so it must remain visible and inert.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
    reason: "source_profile_pending",
    interviewAllowed: false,
  }]);
  assert.equal("privateUnexpectedField" in res.body.profilePreparingRows[0], false);
  assert.deepEqual(res.body.snapshot.queue, []);
  assert.deepEqual(res.body.snapshot.stream, []);
});

test("Processing is read-only and never requests cards or exposes actions", () => {
  const applicants = readFileSync(resolve("applicants.html"), "utf8");
  assert.match(applicants, /id="pillProcessing"/);
  assert.match(applicants, /id="processingView"/);
  assert.match(applicants, /function processingRowHtml\(row\)/);
  assert.match(applicants, /Profile key:/);
  assert.match(applicants, /Source observation:/);
  assert.match(applicants, /paintList\(list, rows, processingRowHtml, \{ requestRichCards: false \}\)/);
  const processing = applicants.slice(applicants.indexOf("function processingRowHtml"), applicants.indexOf("function renderLists"));
  assert.doesNotMatch(processing, /data-act=|openProfile\(|rowCardHtml\(|requestVisibleRichCards\(/);
});
