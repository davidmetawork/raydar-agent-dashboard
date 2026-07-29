import test from "node:test";
import assert from "node:assert/strict";

import { diffInterest } from "../api/paraai/_lib/interest-store.mjs";
import {
  firstNameFor,
  interestConfirmationBody,
  interestConfirmationSubject,
  buildInterestConfirmation,
} from "../api/paraai/_lib/interest-copy.mjs";
import {
  interestConfig,
  interestSweepComplete,
  INTEREST_STATUS,
  REQUIRED_CANDIDATE_PREFERENCE_FIELDS,
  curatedListSequenceIds,
} from "../api/paraai/_lib/interest.mjs";

/* -------------------------------------------------------------- detection */

test("first sight seeds and never acts", () => {
  const d = diffInterest(null, { r1: "APPLIED_TO_ROLE", r2: "PENDING" });
  assert.equal(d.firstSight, true);
  assert.deepEqual(d.newlyInterested, [], "an already-interested row must not fire on first sight");
});

test("PENDING to APPLIED_TO_ROLE is the trigger", () => {
  const d = diffInterest({ statuses: { r1: "PENDING" } }, { r1: "APPLIED_TO_ROLE" });
  assert.equal(d.firstSight, false);
  assert.deepEqual(d.newlyInterested, ["r1"]);
});

test("a status that did not change does not re-fire", () => {
  const d = diffInterest({ statuses: { r1: "APPLIED_TO_ROLE" } }, { r1: "APPLIED_TO_ROLE" });
  assert.deepEqual(d.newlyInterested, []);
});

test("declines are recorded but never acted on", () => {
  const d = diffInterest({ statuses: { r1: "PENDING" } }, { r1: "NOT_INTERESTED" });
  assert.deepEqual(d.newlyInterested, []);
  assert.deepEqual(d.declined, ["r1"]);
});

test("a role appearing for the first time on a known candidate does not fire", () => {
  // New role added to an existing list: no prior status, so no transition.
  const d = diffInterest({ statuses: { r1: "PENDING" } }, { r1: "PENDING", r2: "APPLIED_TO_ROLE" });
  assert.deepEqual(d.newlyInterested, [], "needs an observed PENDING before it can transition");
});

test("multiple roles in one batch are all detected", () => {
  const d = diffInterest(
    { statuses: { r1: "PENDING", r2: "PENDING", r3: "PENDING" } },
    { r1: "APPLIED_TO_ROLE", r2: "APPLIED_TO_ROLE", r3: "PENDING" },
  );
  assert.deepEqual(d.newlyInterested.sort(), ["r1", "r2"]);
});

test("a population sweep is healthy only when every candidate read succeeds", () => {
  assert.equal(interestSweepComplete({
    populationSize: 717,
    candidatesRead: 717,
    readErrors: 0,
  }), true);
  assert.equal(interestSweepComplete({
    populationSize: 717,
    candidatesRead: 135,
    readErrors: 582,
  }), false);
  assert.equal(interestSweepComplete({
    populationSize: 0,
    candidatesRead: 0,
    readErrors: 0,
  }), false);
});

/* ------------------------------------------------------------------- copy */

test("copy is David's wording verbatim, singular", () => {
  const body = interestConfirmationBody({ firstName: "Thomas", roleCount: 1 });
  assert.match(body, /^Hey Thomas,\n/);
  assert.match(body, /signaled interest on the role I sent over!/);
  assert.match(body, /in front of the team asap/);
  assert.match(body, /Talk soon,\nDavid$/);
});

test("copy pluralises on multiple roles", () => {
  const body = interestConfirmationBody({ firstName: "Thomas", roleCount: 3 });
  assert.match(body, /on the roles I sent over/);
  assert.match(body, /in front of the teams asap/);
});

test("copy carries no em dash", () => {
  const body = interestConfirmationBody({ firstName: "Ana", roleCount: 2 });
  assert.ok(!/[—–]/.test(body), "em and en dashes are banned in shipped copy");
});

test("first name strips prepended symbols and rejects unusable names", () => {
  assert.equal(firstNameFor("⚡Serge-Eric Tremblay"), "Serge-Eric");
  assert.equal(firstNameFor("  Thomas Bulger "), "Thomas");
  assert.equal(firstNameFor(""), null);
  assert.equal(firstNameFor("   "), null);
  assert.equal(firstNameFor("12345"), null, "a name with no letters is unusable");
  // CR/LF are whitespace, so tokenising the first name already strips them:
  // the greeting is safe and the candidate still gets a correct "Hey Bad,".
  assert.equal(firstNameFor("Bad\r\nName"), "Bad", "newlines cannot reach a header");
  // A control character inside the token itself has no such escape hatch.
  assert.equal(firstNameFor("Bad\u0000Name"), null, "embedded control chars are rejected");
  assert.equal(firstNameFor("Zoë Smith"), "Zoë", "accented names survive");
});

test("subject threads onto an existing subject exactly once", () => {
  assert.equal(interestConfirmationSubject({ existingSubject: "Your roles" }), "Re: Your roles");
  assert.equal(interestConfirmationSubject({ existingSubject: "Re: Your roles" }), "Re: Your roles");
  assert.equal(interestConfirmationSubject({}), "Your roles");
});

test("html preserves blank lines as spacing and escapes", () => {
  const { html } = buildInterestConfirmation({ firstName: "A<b", roleCount: 1 });
  assert.ok(html.includes("<div><br></div>"), "blank lines become real spacing");
  assert.ok(html.includes("A&lt;b"), "content is escaped");
});

/* ------------------------------------------------------------------ gates */

test("dry run defaults on when unset", () => {
  const c = interestConfig({});
  assert.equal(c.dryRun, true);
  assert.equal(c.writesEnabled, false);
});

test("every write gate defaults closed", () => {
  const c = interestConfig({});
  assert.equal(c.stopArmed, false);
  assert.equal(c.emailArmed, false);
  assert.equal(c.submitArmed, false);
});

test("email gate refuses to arm without the stop gate", () => {
  const c = interestConfig({ PARAAI_INTEREST_EMAIL_APPROVED: "1" });
  assert.equal(c.emailArmed, false);
  assert.ok(c.gateOrderViolations.length > 0);
});

test("submit gate refuses to arm without stop and email", () => {
  const c = interestConfig({ PARAAI_INTEREST_SUBMIT_APPROVED: "1", PARAAI_INTEREST_STOP_APPROVED: "1" });
  assert.equal(c.submitArmed, false);
  assert.ok(c.gateOrderViolations.some((v) => /SUBMIT_APPROVED/.test(v)));
});

test("gates arm in the correct order", () => {
  const c = interestConfig({
    PARAAI_INTEREST_ENABLED: "1",
    PARAAI_INTEREST_DRY_RUN: "0",
    PARAAI_INTEREST_STOP_APPROVED: "1",
    PARAAI_INTEREST_EMAIL_APPROVED: "1",
    PARAAI_INTEREST_SUBMIT_APPROVED: "1",
  });
  assert.equal(c.stopArmed, true);
  assert.equal(c.emailArmed, true);
  assert.equal(c.submitArmed, true);
  assert.equal(c.writesEnabled, true);
  assert.deepEqual(c.gateOrderViolations, []);
});

test("not-before must be a parseable timestamp to count as configured", () => {
  assert.equal(interestConfig({}).notBeforeConfigured, false);
  assert.equal(interestConfig({ PARAAI_INTEREST_NOT_BEFORE: "nonsense" }).notBeforeConfigured, false);
  assert.equal(interestConfig({ PARAAI_INTEREST_NOT_BEFORE: "2026-07-28T00:00:00Z" }).notBeforeConfigured, true);
});

test("submit preflight pins Paraform's five required candidate preference fields", () => {
  assert.deepEqual(REQUIRED_CANDIDATE_PREFERENCE_FIELDS, [
    "locations",
    "salary_min",
    "workplace",
    "last_funding_round",
    "visa",
  ]);
});

/* --------------------------------------------------------------- contract */

test("trigger status is the captured value", () => {
  assert.equal(INTEREST_STATUS.APPLIED, "APPLIED_TO_ROLE");
});

test("stop scope is the five pinned curated-list sequence ids", () => {
  const ids = curatedListSequenceIds();
  assert.equal(ids.length, 5);
  for (const id of ids) assert.match(id, /^[a-z0-9]{20,}$/, "resolution is ID-first; names are diagnostics");
  assert.ok(ids.includes("cmqk75h7x00030bj8f5s6oaw8"));
  assert.ok(ids.includes("cmqpje4lh00040cki15nuuqc8"));
});
