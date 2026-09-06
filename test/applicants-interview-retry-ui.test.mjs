import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const applicants = await readFile(new URL("../applicants.html", import.meta.url), "utf8");

const retryStart = applicants.indexOf("const RETRYABLE_INTERVIEW_ACK_REASONS");
const retryEnd = applicants.indexOf("function requestedRows", retryStart);
assert.ok(retryStart >= 0 && retryEnd > retryStart, "retry eligibility helpers are extractable from the shipped page");

function retryHarness() {
  const STATE = { acks: {}, decisions: {}, snapshot: {} };
  const helpers = runInNewContext(
    `${applicants.slice(retryStart, retryEnd)}; ({ hasRawInterviewSendEvidence, isRuleInterviewDecision, retryableInterviewRequest })`,
    {
      STATE,
      SENT_ACK_STATUSES: new Set(["invited", "sendgrid_delivered"]),
      SENT_ROW_STATUSES: new Set(["emailed", "booked", "replied"]),
      effectiveDecision: (key) => STATE.decisions[key] || null,
      interviewHold: (row) => row?.hold || null,
    },
  );
  return { STATE, helpers };
}

test("retry eligibility is limited to the two matching terminal technical failures", () => {
  const { STATE, helpers } = retryHarness();
  const row = { key: "candidate:role" };
  const decision = { action: "interview", requestId: "old-request", actorType: "rule" };

  for (const reason of ["APPLICANT_CORE_RULE_RUN_IDEMPOTENCY_CONFLICT", "22P02"]) {
    STATE.acks[row.key] = { requestId: decision.requestId, status: "blocked", reason };
    assert.equal(helpers.retryableInterviewRequest(row, decision), decision.requestId);
    assert.equal(helpers.retryableInterviewRequest(row, decision, decision.requestId), decision.requestId);
  }

  const legacyDecision = { action: "interview", requestId: "old-request", by: "rule:legacy-rule" };
  STATE.acks[row.key] = { requestId: "old-request", status: "blocked", reason: "22P02" };
  assert.equal(helpers.retryableInterviewRequest(row, legacyDecision), "old-request", "legacy rule byline");
  assert.equal(helpers.retryableInterviewRequest(row, { ...decision, actorType: "human", by: "rule:forged" }), null, "explicit human provenance");
  assert.equal(helpers.retryableInterviewRequest(row, { ...decision, actorType: "migration", by: "rule:old" }), null, "migration provenance");
  assert.equal(helpers.retryableInterviewRequest(row, { action: "interview", requestId: "old-request" }), null, "missing provenance");

  const rejected = [
    { label: "different failure", ack: { requestId: "old-request", status: "blocked", reason: "APPLICANT_CORE_DECISION_WRITE_FAILED" } },
    { label: "pending dispatch", ack: { requestId: "old-request", status: "blocked", reason: "interview_dispatch_pending" } },
    { label: "different request", ack: { requestId: "other-request", status: "blocked", reason: "22P02" } },
    { label: "already sent", ack: { requestId: "old-request", status: "invited", reason: "22P02" } },
  ];
  for (const fixture of rejected) {
    STATE.acks[row.key] = fixture.ack;
    assert.equal(helpers.retryableInterviewRequest(row, decision), null, fixture.label);
  }

  STATE.acks[row.key] = { requestId: "old-request", status: "blocked", reason: "22P02" };
  assert.equal(helpers.retryableInterviewRequest({ ...row, hold: "identity_review" }, decision), null, "current hold");
  assert.equal(helpers.retryableInterviewRequest({ ...row, status: "emailed" }, decision), null, "row send state");
  assert.equal(helpers.retryableInterviewRequest({ ...row, externalPriorSendAt: "2026-09-01T00:00:00Z" }, decision), null, "external send evidence");
  assert.equal(helpers.retryableInterviewRequest(row, decision, "stale-button-request"), null, "stale button tuple");
  assert.equal(helpers.retryableInterviewRequest(row, { ...decision, action: "pass" }), null, "Interview only");

  STATE.acks[row.key] = { requestId: "other-request", status: "sendgrid_delivered", reason: "22P02" };
  assert.equal(helpers.hasRawInterviewSendEvidence(row), true, "a mismatched raw sent ack still blocks retry");
});

test("source-stale retries require accepted provenance and a newer published input revision", () => {
  const { STATE, helpers } = retryHarness();
  const row = { key: "candidate:role", inputRevision: "current-input" };
  const baseDecision = {
    action: "interview",
    requestId: "old-request",
    inputRevision: "previous-input",
    at: "2026-09-05T20:00:00.000Z",
  };
  STATE.snapshot.generatedAt = "2026-09-05T20:03:00.000Z";
  STATE.acks[row.key] = {
    requestId: "old-request",
    status: "blocked",
    reason: "APPLICANT_CORE_DECISION_SOURCE_REVISION_STALE",
    at: "2026-09-05T20:02:00.000Z",
  };

  for (const decision of [
    { ...baseDecision, actorType: "human", by: "reviewer@example.test" },
    { ...baseDecision, actorType: "rule", by: "rule:current" },
    { ...baseDecision, by: "reviewer@example.test" },
    { ...baseDecision, by: "rule:legacy" },
  ]) assert.equal(helpers.retryableInterviewRequest(row, decision), "old-request");

  for (const decision of [
    { ...baseDecision, actorType: "migration", by: "reviewer@example.test" },
    { ...baseDecision },
  ]) assert.equal(helpers.retryableInterviewRequest(row, decision), null, "unaccepted provenance");

  assert.equal(helpers.retryableInterviewRequest({ ...row, inputRevision: "previous-input" }, {
    ...baseDecision, actorType: "human",
  }), null, "the same stale source cannot retry");
  assert.equal(helpers.retryableInterviewRequest({ ...row, inputRevision: "" }, {
    ...baseDecision, actorType: "human",
  }), null, "the current revision must be present");

  STATE.snapshot.generatedAt = STATE.acks[row.key].at;
  assert.equal(helpers.retryableInterviewRequest(row, { ...baseDecision, actorType: "human" }), null,
    "the publication must be after the rejection");
  STATE.snapshot.generatedAt = "invalid";
  assert.equal(helpers.retryableInterviewRequest(row, { ...baseDecision, actorType: "human" }), null,
    "missing trustworthy publication time fails closed");
  STATE.snapshot.generatedAt = "2026-09-05T20:03:00Z";
  assert.equal(helpers.retryableInterviewRequest(row, { ...baseDecision, actorType: "human" }), null,
    "non-canonical timestamps cannot be ordered by the atomic retry check");
});

test("eligible decided cards and profiles render one retry control carrying the prior request id", () => {
  const buttonStart = applicants.indexOf("function retryInterviewButtonHtml");
  const buttonEnd = applicants.indexOf("/* ---- inline work history", buttonStart);
  assert.ok(buttonStart >= 0 && buttonEnd > buttonStart);
  const { retryInterviewButtonHtml } = runInNewContext(
    `${applicants.slice(buttonStart, buttonEnd)}; ({ retryInterviewButtonHtml })`,
    {
      retryableInterviewRequest: () => "old-request",
      esc: (value) => String(value),
    },
  );
  const html = retryInterviewButtonHtml({ key: "candidate:role" }, { action: "interview" });
  assert.match(html, />Retry interview request<\/button>/);
  assert.match(html, /data-act="retry-interview"/);
  assert.match(html, /data-key="candidate:role"/);
  assert.match(html, /data-retry-of-request-id="old-request"/);
  assert.match(retryInterviewButtonHtml({ key: "candidate:role" }, { action: "interview" }, true), / disabled/);

  const hidden = runInNewContext(
    `${applicants.slice(buttonStart, buttonEnd)}; retryInterviewButtonHtml({ key: "candidate:role" }, { action: "interview" })`,
    { retryableInterviewRequest: () => null, esc: (value) => String(value) },
  );
  assert.equal(hidden, "", "ineligible decided rows do not get a retry control");

  assert.match(applicants, /decidedStatusHtml\(key, decision\) \+ retryInterviewButtonHtml\(row, decision, busy\)/,
    "the decided list card renders the retry control");
  assert.match(applicants, /decision \? retryInterviewButtonHtml\(row, decision, busy\) :/,
    "the decided profile renders the retry control");
});

test("retry rechecks the old request and sends a fresh request with current revisions", async () => {
  const decideStart = applicants.indexOf("async function decide(");
  const decideEnd = applicants.indexOf("/* ---- visible shell band", decideStart);
  assert.ok(decideStart >= 0 && decideEnd > decideStart, "decision helper is extractable from the shipped page");

  const posts = [];
  const toasts = [];
  let uuidCalls = 0;
  let retryAllowed = true;
  const oldDecision = { action: "interview", requestId: "old-request" };
  const STATE = {
    busy: new Set(),
    local: { "candidate:role": oldDecision },
    generation: { generationId: "generation-one", digest: "digest-one" },
    modal: null,
  };
  const { decide } = runInNewContext(
    `${applicants.slice(decideStart, decideEnd)}; ({ decide })`,
    {
      STATE,
      AUTH: { email: "reviewer@example.com" },
      crypto: { randomUUID: () => { uuidCalls += 1; return "fresh-request"; } },
      effectiveDecision: (key) => STATE.local[key],
      retryableInterviewRequest: (_row, _decision, expected) => retryAllowed && expected === "old-request" ? expected : null,
      saveLocal: () => {},
      renderLists: () => {},
      renderModal: () => {},
      toast: (message, bad) => toasts.push({ message, bad }),
      fetch: async (url, options) => {
        posts.push({ url, options });
        return {
          status: 202,
          ok: true,
          json: async () => ({ ok: true, decision: { action: "interview", requestId: "fresh-request" } }),
        };
      },
      showGate: () => { throw new Error("unexpected auth gate"); },
      Error,
      Object,
      JSON,
      Set,
      Date,
    },
  );
  const row = {
    key: "candidate:role",
    name: "Candidate",
    roleTitle: "Role",
    inputRevision: "input-one",
    readinessRevision: "ready-one",
    decisionRevision: 7,
  };
  await decide(row.key, "interview", row, false, { retryOfRequestId: "old-request" });
  assert.equal(posts.length, 1);
  const body = JSON.parse(posts[0].options.body);
  assert.deepEqual(body, {
    key: row.key,
    action: "interview",
    requestId: "fresh-request",
    generationId: "generation-one",
    generationDigest: "digest-one",
    inputRevision: "input-one",
    readinessRevision: "ready-one",
    decisionRevision: 7,
    name: "Candidate",
    roleTitle: "Role",
    retryOfRequestId: "old-request",
  });
  assert.equal(uuidCalls, 1);

  retryAllowed = false;
  await decide(row.key, "interview", row, false, { retryOfRequestId: "old-request" });
  assert.equal(posts.length, 1, "a changed tuple is refused before another POST");
  assert.equal(uuidCalls, 1, "a refused retry does not mint a request id");
  assert.match(toasts.at(-1).message, /no longer available/);
  assert.equal(toasts.at(-1).bad, true);
});

test("the click path rechecks the button's expected request id before retrying", () => {
  assert.match(applicants, /act\.dataset\.retryOfRequestId/);
  assert.match(applicants, /await decide\(key, "interview", row, false, \{ retryOfRequestId \}\)/);
  assert.doesNotMatch(applicants, /data-act="retry-interview"[^>]*onclick=/);
});
