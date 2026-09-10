/* Executable unit tests for the Master Inbox route + trust text.

   master-inbox-route.js is a classic browser script (the page loads it with a
   plain <script src>), and this package is type:module, so it cannot simply be
   imported. It is evaluated here with a fake `window`/`module` pair, which is
   what the browser and a CommonJS loader each hand it — so these are real
   calls into the shipped code, not assertions about its source text.
*/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const ROUTE_SOURCE = "../master-inbox-route.js";

function loadRoute() {
  const source = fs.readFileSync(new URL(ROUTE_SOURCE, import.meta.url), "utf8");
  const module = { exports: {} };
  const window = {};
  new Function("window", "module", "exports", source)(window, module, module.exports);
  assert.equal(module.exports, window.MasterInboxRoute, "the script must expose the same object both ways");
  return module.exports;
}

const R = loadRoute();
const clock = value => (value ? "09:15 AM" : "");

test("the default screen serializes to a bare browse address", () => {
  assert.equal(R.serializeRoute({}), "browse");
  assert.equal(R.serializeRoute({ folder: "all" }), "browse");
  assert.deepEqual(R.parseRoute("browse"), { folder: "all", mailbox: "", q: "", id: "" });
  assert.deepEqual(R.parseRoute(""), { folder: "all", mailbox: "", q: "", id: "" });
});

test("folder, mailbox, query and conversation round-trip through the address", () => {
  const route = { folder: "sent", mailbox: "david-raydar-xyz", q: "from:maya has:attachment", id: "11111111-1111-4111-8111-111111111111" };
  const address = R.serializeRoute(route);
  assert.equal(address.startsWith("browse?"), true);
  assert.deepEqual(R.parseRoute(address), route);
  assert.equal(R.sameRoute(route, R.parseRoute(address)), true);
});

test("an explicit inbox folder survives the round-trip and stays distinct from all", () => {
  assert.equal(R.serializeRoute({ folder: "inbox" }), "browse?folder=inbox");
  assert.equal(R.parseRoute("browse?folder=inbox").folder, "inbox");
  assert.equal(R.sameRoute({ folder: "inbox" }, { folder: "all" }), false);
});

test("hostile or unknown address parts fall back instead of reaching the service", () => {
  assert.equal(R.parseRoute("browse?folder=../../etc").folder, "all");
  assert.equal(R.parseRoute("browse?id=not-a-uuid").id, "");
  assert.equal(R.parseRoute("browse?id=%3Cscript%3E").id, "");
  assert.equal(R.normalizeRoute({ q: "x".repeat(5000) }).q.length, 1000);
  assert.equal(R.normalizeRoute(null).folder, "all");
  assert.equal(R.parseRoute(undefined).folder, "all");
});

test("legacy conversation addresses and bare uuids still open a conversation", () => {
  const id = "22222222-2222-4222-8222-222222222222";
  assert.equal(R.parseRoute("conversation=" + id).id, id);
  assert.equal(R.parseRoute(id).id, id);
  assert.equal(R.parseRoute(id.toUpperCase()).id, id);
});

test("a query that needs escaping survives serialization", () => {
  const route = R.parseRoute(R.serializeRoute({ q: 'subject:"quarterly review" & more' }));
  assert.equal(route.q, 'subject:"quarterly review" & more');
});

test("the status pill states current coverage with a time and a count", () => {
  const coverage = { summary: { mailboxes: 10, current: 10, stale: [], unknown: [], watermark: "2026-09-10T16:15:00.000Z" } };
  const result = R.coverageSummary(coverage, { clock });
  assert.equal(result.tone, "current");
  assert.equal(result.text, "Current through 09:15 AM (10 of 10 mailboxes)");
});

test("the status pill counts stale mailboxes and names the oldest watermark", () => {
  const coverage = { summary: { mailboxes: 10, current: 8, stale: ["a", "b"], unknown: [], watermark: "2026-09-10T16:15:00.000Z" } };
  const result = R.coverageSummary(coverage, { clock, label: id => id + "@example.test" });
  assert.equal(result.tone, "stale");
  assert.equal(result.text, "Stale: 2 mailboxes behind, oldest 09:15 AM");
  assert.equal(result.detail.includes("a@example.test, b@example.test"), true);
  const one = R.coverageSummary({ summary: { mailboxes: 2, current: 1, stale: ["a"], unknown: [], watermark: null } }, { clock });
  assert.equal(one.text, "Stale: 1 mailbox behind, oldest an unreported time");
});

test("an unreported mailbox outranks a stale one in the status pill", () => {
  const coverage = { summary: { mailboxes: 3, current: 1, stale: ["a", "b"], unknown: ["b"], watermark: null } };
  const result = R.coverageSummary(coverage, { clock, label: id => id + "@example.test" });
  assert.equal(result.tone, "unknown");
  assert.equal(result.text, "Unknown for b@example.test");
});

test("a missing coverage object is reported as unknown, never as current", () => {
  for (const value of [undefined, null, {}, { summary: null }]) {
    const result = R.coverageSummary(value, { clock });
    assert.equal(result.tone, "unknown");
    assert.equal(/current/i.test(result.text), false);
  }
  assert.equal(R.coverageSummary({ summary: { mailboxes: 0, current: 0, stale: [], unknown: [] } }, { clock }).tone, "unknown");
});

test("the default clock renders a real time without an injected formatter", () => {
  const result = R.coverageSummary({ summary: { mailboxes: 1, current: 1, stale: [], unknown: [], watermark: "2026-09-10T16:15:00.000Z" } });
  assert.match(result.text, /^Current through \d{1,2}:\d{2}/);
  assert.equal(R.clockTime("not a date"), "");
  assert.equal(R.clockTime(null), "");
});

test("an empty list only claims absence when coverage proves it", () => {
  const confirmed = R.emptyStateText({ negativeEvidence: { kind: "none_through_watermark", watermark: "2026-09-10T16:15:00.000Z" } }, { clock });
  assert.equal(confirmed.tone, "confirmed");
  assert.equal(confirmed.headline, "No conversations match, through 09:15 AM");

  const unknown = R.emptyStateText({ negativeEvidence: { kind: "unknown", reason: "2 mailboxes are behind" } }, { clock });
  assert.equal(unknown.tone, "unknown");
  assert.equal(unknown.headline, "Result unknown: 2 mailboxes are behind");

  for (const value of [undefined, {}, { negativeEvidence: { kind: "not_applicable" } }]) {
    const fallback = R.emptyStateText(value, { clock });
    assert.equal(fallback.tone, "unknown");
    assert.match(fallback.headline, /^Result unknown: /);
  }
});

test("the search box admits the fields the store ignored", () => {
  assert.equal(R.searchNotice({ unsupported: ["subject"] }), "subject: is not supported; searched as text");
  assert.equal(R.searchNotice({ unsupported: [{ field: "filename", searchedAs: "text" }, "is"] }), "filename: is not supported; searched as text · is: is not supported; searched as text");
  assert.equal(R.searchNotice({ warnings: ["before: needs YYYY-MM-DD, so the date filter was dropped"] }), "before: needs YYYY-MM-DD, so the date filter was dropped");
  assert.equal(R.searchNotice({}), "");
  assert.equal(R.searchNotice(null), "");
  assert.equal(R.searchNotice({ unsupported: [null, {}, ""] }), "");
});

test("a row badge names the scoped mailbox copy when the conversation has one", () => {
  assert.equal(R.badgeCopy(["a", "b"], "b"), "b");
  assert.equal(R.badgeCopy(["a", "b"], "c"), "a");
  assert.equal(R.badgeCopy(["a", "b"], ""), "a");
  assert.equal(R.badgeCopy([], "b"), "");
  assert.equal(R.badgeCopy(undefined, undefined), "");
});

test("the list title names the folder, and the account when one is scoped", () => {
  assert.equal(R.viewTitle("all", ""), "All inboxes");
  assert.equal(R.viewTitle("sent", "david@raydar.xyz"), "Sent · david@raydar.xyz");
  assert.equal(R.viewTitle("all-mail", ""), "All Mail");
  assert.equal(R.viewTitle("nonsense", ""), "All inboxes");
});
