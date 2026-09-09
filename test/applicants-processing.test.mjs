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
          experiences: [{ roleTitle: "Source role", companyName: "Source company",
            start: "2024-01", end: null, current: true, description: "drop this" }],
          education: [{ school: "Source school", degree: "BA",
            start: "2018", end: "2022", description: "drop this" }],
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
  assert.equal(details.profile.experiences[0].current, true);
  assert.equal(details.profile.experiences[0].start, "2024-01");
  assert.equal(details.profile.education[0].end, "2022");
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
  assert.match(applicants, /source_discovery_pending:[\s\S]*Workable is still loading the candidate's full profile/);
  assert.match(applicants, /workable_display_profile_not_eligible:[\s\S]*no longer passes the display-only safety checks/);
  assert.match(applicants, /source_held:[\s\S]*source is held for review/);
  assert.match(applicants, /display_only_source_held:[\s\S]*Workable application is review-only/);
  assert.match(applicants, /source_import_needs_review: \{ reason: "Source import needs review\."/);
  assert.match(applicants, /Owner: " \+ display\.owner/);
  assert.match(applicants, /"Waiting " \+ invitationAgeText\(waitSeconds\)/);
  assert.match(applicants, /Current: " \+ role/);
  assert.match(applicants, /const receivedAt = row\.receivedAt \|\| row\.addedAt \|\| row\.appliedAt \|\| null;/);
  assert.match(applicants, /const receivedLabel = row\.receivedAt \? "Received" : row\.addedAt \? "Added" : "Applied";/);
  assert.match(applicants, /profilePreparingRows\(\)\.filter\(\(row\) =>/);
  assert.match(applicants, /\[row\.name, row\.roleTitle, row\.company, row\.sourceJobId\]/);
  assert.match(applicants, /No preparing applicants match the current filters/);
  assert.match(applicants, /paintList\(list, rows, processingRowHtml, \{ requestRichCards: false, onNearEnd: STATE\.paged \? loadMoreApplicants : null \}\)/);
  const processing = applicants.slice(applicants.indexOf("function processingRowHtml"), applicants.indexOf("function renderLists"));
  assert.doesNotMatch(processing, /data-act=|openProfile\(|rowCardHtml\(|requestVisibleRichCards\(|Source observation:|Profile key:/);
});

test("display-only Workable rows stay reviewable while Interview and source-backed Rules stay unavailable", () => {
  const applicants = readFileSync(resolve("applicants.html"), "utf8");
  assert.match(applicants, /DISPLAY_ONLY_SOURCE_HOLD_CODES = new Set\(\["source_held", "display_only_source_held"\]\)/);
  assert.match(applicants, /Ready to review · Interview unavailable:/);
  assert.match(applicants, /Application profile/);
  assert.match(applicants, /current source · review only/);
  assert.match(applicants, /source === "source" && !displayOnlySource/);
  assert.match(applicants, /This source profile is for review only and cannot create Rules/);
  assert.match(applicants, /historySectionsHtml\(p, \{ allowRuleFacts: canUseFact\("source"\) \}\)/);
});

test("Preparing renders Workable guidance and applies typed role or job filters to unknown stubs", () => {
  const applicants = readFileSync(resolve("applicants.html"), "utf8");
  const start = applicants.indexOf("const PROCESSING_REVIEW_STATES");
  const end = applicants.indexOf("function problemReason", start);
  assert.ok(start >= 0 && end > start, "Preparing renderer is extractable");
  const list = { innerHTML: "", _virtual: null };
  const rows = [
    { key: "stub-one", state: "profile_preparing", name: "Applicant identity pending",
      roleTitle: "Platform Engineer", sourceJobId: "workable:job:ONE",
      addedAt: "2026-09-08T12:00:00.000Z", reason: "source_discovery_pending" },
    { key: "stub-two", state: "needs_review", name: "Other applicant",
      roleTitle: "Designer", sourceJobId: "workable:job:TWO",
      addedAt: "2026-09-08T12:00:00.000Z", reason: "workable_display_profile_not_eligible" },
  ];
  const STATE = { loaded: true, feedUnavailable: null, snapshot: { profilePreparing: 2 },
    role: "all", query: "job:one" };
  const context = {
    STATE, $: () => list, profilePreparingRows: () => rows, appliedCompany: () => "Unknown company",
    RaydarNav: { href: (key) => "/applicants#profile=" + key },
    esc: (value) => String(value ?? ""), hasClockTime: () => true,
    parseDate: (value) => new Date(value), shortDate: () => "Sep 8", invitationAgeText: () => "3h",
    monthYear: (value) => String(value || ""), applicationMomentText: () => "Added Sep 8",
    paintList: (element, selected, renderer) => {
      element.selected = selected;
      element.innerHTML = selected.map(renderer).join("");
    },
  };
  const rendered = runInNewContext(`${applicants.slice(start, end)}; ({ renderProcessing })`, context);
  rendered.renderProcessing();
  assert.deepEqual(list.selected.map((row) => row.key), ["stub-one"]);
  assert.match(list.innerHTML, /Applied to <b>Platform Engineer<\/b> @ Unknown company/);
  assert.match(list.innerHTML, /Workable is still loading the candidate's full profile/);
  assert.match(list.innerHTML, /Waiting 3h · Owner: Raydar intake/);
  assert.match(list.innerHTML, /retry the Workable profile automatically/);

  STATE.query = "";
  STATE.role = "Designer";
  rendered.renderProcessing();
  assert.deepEqual(list.selected.map((row) => row.key), ["stub-two"]);
  assert.match(list.innerHTML, /no longer passes the display-only safety checks/);
  assert.match(list.innerHTML, /Owner: Raydar source review/);
});

test("application dates preserve the supplied application day before a later ingestion timestamp", () => {
  const applicants = readFileSync(resolve("applicants.html"), "utf8");
  const start = applicants.indexOf("function applicationMoment(row)");
  const end = applicants.indexOf("function applicationMomentText(row)", start);
  assert.ok(start >= 0 && end > start, "application-moment helper is extractable");
  const applicationMoment = runInNewContext(`
    const DATE_ONLY = /^\\d{4}-\\d{2}-\\d{2}$/;
    function parseDate(value) { const date = value ? new Date(value) : null; return date && !isNaN(date) ? date : null; }
  function hasClockTime(value) { return !!value && !DATE_ONLY.test(String(value)) && !!parseDate(value); }
    ${applicants.slice(start, end)}; applicationMoment`);
  const plain = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(applicationMoment({ appliedAt: "2026-09-08T12:30:00.000Z", addedAt: "2026-09-09T12:30:00.000Z" })),
    { value: "2026-09-08T12:30:00.000Z", label: "Applied", timed: true });
  assert.deepEqual(plain(applicationMoment({ appliedAt: "2026-09-08", addedAt: "2026-09-09T12:30:00.000Z" })),
    { value: "2026-09-08", label: "Applied", timed: false });
  assert.deepEqual(plain(applicationMoment({ appliedAt: "2026-09-08" })),
    { value: "2026-09-08", label: "Applied", timed: false });
  assert.deepEqual(plain(applicationMoment({ addedAt: "2026-09-09T12:30:00.000Z" })),
    { value: "2026-09-09T12:30:00.000Z", label: "Added", timed: true });
  assert.match(applicants, /p-applied[\s\S]*applicationMomentText\(row\)/);
  assert.match(applicants, /const when = applicationMomentHtml\(row\)/);
});

test("date-only applications keep their own day and label a later arrival separately", () => {
  const applicants = readFileSync(resolve("applicants.html"), "utf8");
  const start = applicants.indexOf("function applicationMoment(row)");
  const end = applicants.indexOf("/* Employment and education dates", start);
  const render = runInNewContext(`
    const DATE_ONLY = /^\\d{4}-\\d{2}-\\d{2}$/;
    function parseDate(value) { const date = value ? new Date(value) : null; return date && !isNaN(date) ? date : null; }
    function hasClockTime(value) { return !!value && !DATE_ONLY.test(String(value)) && !!parseDate(value); }
    const esc = value => String(value);
    const shortDate = value => String(value).slice(0,10);
    const relTime = () => "1h ago";
    function timeOfDay(value) { if (DATE_ONLY.test(value)) throw Error("date-only time invented"); return String(value).slice(11,16); }
    ${applicants.slice(start, end)}; ({ text: applicationMomentText, html: applicationMomentHtml })`);
  const row = { appliedAt: "2026-08-05", addedAt: "2026-09-08T12:30:00.000Z" };
  assert.equal(render.text(row), "Applied 2026-08-05 · Added 2026-09-08 at 12:30 · 1h ago");
  assert.equal(render.html(row), "<b>2026-08-05</b>applied<br>added 2026-09-08 12:30 · 1h ago");
  assert.equal(render.text({ appliedAt: "2026-08-05" }), "Applied 2026-08-05");
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
