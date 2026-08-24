// The withheld-rows path, both halves.
//
// The 2026-08-24 fault: the publisher had been dropping ~100 of 2,579 review
// rows every tick for weeks to fit the snapshot size limit, choosing them by
// age alone. Nothing on this side could tell — a 4% shave never trips the
// count-drop tripwire, which needs 50% — so the only record was one line in a
// log file on the desktop. Two things had to change here: tell the loop which
// rows are already decided so it can spend those first, and show a person when
// rows went missing anyway.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createSyncHandler } from "../api/applicants/sync.mjs";

const applicants = await readFile(new URL("../applicants.html", import.meta.url), "utf8");

const SAVED_SYNC_KEY = process.env.APPHUB_SYNC_KEY;
const KEY = "apphub-sync-key-0000000000000000001";
const AT = "2026-08-24T15:00:00.000Z";

test.after(() => {
  if (SAVED_SYNC_KEY === undefined) delete process.env.APPHUB_SYNC_KEY;
  else process.env.APPHUB_SYNC_KEY = SAVED_SYNC_KEY;
});

function response() {
  return {
    body: undefined, headers: {}, statusCode: undefined,
    setHeader(n, v) { this.headers[n.toLowerCase()] = v; },
    status(v) { this.statusCode = v; return this; },
    json(v) { this.body = v; return this; },
    end() {},
  };
}

const get = async (decisions, acks = {}) => {
  process.env.APPHUB_SYNC_KEY = KEY;
  const handler = createSyncHandler({
    kvReady: () => true,
    readHash: async (key) => (key === "apphub:decisions" ? decisions : acks),
    now: () => AT,
  });
  const res = response();
  await handler({ method: "GET", headers: { authorization: `Bearer ${KEY}` } }, res);
  return res;
};

test("the GET hands the loop every decided key, not just the un-acked interviews", async () => {
  const decisions = {
    "cu1:r1": { action: "interview", at: AT, by: "david@raydar.xyz" },
    "cu2:r1": { action: "pass", at: AT, by: "david@raydar.xyz" },
    "cu3:r2": { action: "interview", at: AT, by: "rule:tier-c-no-history" },
  };
  const res = await get(decisions, { "cu3:r2": { status: "invited", at: AT } });

  assert.equal(res.statusCode, 200);
  // Unchanged: approvals stay narrow — un-acked interviews only.
  assert.deepEqual(res.body.decisions.map((d) => d.key), ["cu1:r1"]);
  // New: the full decided set, which is what the queue trim needs. A PASS is
  // the important case — a passed applicant never leaves the plan's skipped
  // list, so passes are what the review queue silts up with.
  assert.deepEqual(res.body.decidedKeys.sort(), ["cu1:r1", "cu2:r1", "cu3:r2"]);
});

test("decidedKeys is keys only — no decision records leak to the loop", async () => {
  const res = await get({ "cu1:r1": { action: "pass", at: AT, by: "david@raydar.xyz" } });
  assert.deepEqual(res.body.decidedKeys, ["cu1:r1"]);
  for (const k of res.body.decidedKeys) assert.equal(typeof k, "string");
});

test("an empty decisions hash answers with an empty set, not a missing field", async () => {
  // The distinction the publisher depends on: [] means "nothing is decided",
  // an ABSENT field means "this dashboard is too old to say" — and those two
  // lead to opposite trims. The field must always be present.
  const res = await get({});
  assert.ok(Array.isArray(res.body.decidedKeys));
  assert.equal(res.body.decidedKeys.length, 0);
});

test("the withheld banner is its own danger element, beside the count-drop one", () => {
  assert.match(applicants, /<div class="banner danger" id="trimBanner">/);
  assert.match(applicants, /<div class="banner danger" id="countsBanner">/);
  assert.match(applicants, /Some applicants are missing from this queue/);
});

test("the banner reads the publisher's report off the snapshot", () => {
  // Not a number this page derives: the publisher is the only thing that knows
  // what it dropped and why, so the tab must not try to infer it.
  assert.match(applicants, /const trim = STATE\.snapshot\?\.queueTrim \|\| null;/);
  assert.match(applicants, /trim\.droppedPending > 0/);
});

test("only a withheld PENDING applicant raises the alarm", () => {
  const body = applicants.slice(applicants.indexOf("const trim = STATE.snapshot?.queueTrim"));
  const guard = body.indexOf("trim.droppedPending > 0");
  const show = body.indexOf('$("trimBanner").classList.add("on")');
  assert.ok(guard >= 0 && show > guard, "the banner is gated on pending rows being withheld");
  // Losing the tail of the Decided archive is housekeeping — it is reported on
  // the chip it affects, not as a red banner.
  assert.match(applicants, /oldest " \+ Number\(trimmedDecided\)\.toLocaleString\(\) \+ " trimmed to fit/);
});

test("the banner toggles before the no-snapshot early return", () => {
  // Same trap the count-drop banner had to avoid: renderStats() bails when
  // there is no parseable generatedAt, and a trim must not be swallowed by it.
  const body = applicants.slice(applicants.indexOf("function renderStats()"));
  const toggle = body.indexOf('$("trimBanner").classList.add("on")');
  const earlyReturn = body.indexOf('$("updatedText").textContent = "No snapshot yet"');
  assert.ok(toggle > 0 && earlyReturn > 0, "both branches present");
  assert.ok(toggle < earlyReturn, "trim banner is toggled before the no-snapshot return");
});

test("the banner says the applicants are not lost, only unreviewable here", () => {
  assert.match(applicants, /still in the invite plan and nothing has been sent to them/);
  assert.match(applicants, /cannot be reviewed here until the queue gets smaller/);
});
