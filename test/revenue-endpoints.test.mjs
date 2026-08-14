// Endpoint behaviour with every dependency injected. The things worth pinning
// here are the permission asymmetry (anyone may add, only editors may change),
// the two-step import, and the serving model that keeps a viewer off Paraform's
// critical path.

import assert from "node:assert/strict";
import test from "node:test";

import { createDealHandler } from "../api/revenue/deal.mjs";
import { createDealsHandler } from "../api/revenue/deals.mjs";
import { createImportHandler } from "../api/revenue/import.mjs";
import { createRefreshHandler } from "../api/revenue/refresh.mjs";
import { createSummaryHandler } from "../api/revenue/summary.mjs";

const noCors = () => false;
const allowAuth = (email = "someone@raydar.xyz") => async (req) => { req.authedEmail = email; return true; };
const allowEditor = () => true;
const denyEditor = (req, res) => { res.status(403).json({ ok: false, error: "editor_only" }); return false; };

function mockRes() {
  const res = {
    statusCode: null, body: null, headers: {}, sent: null,
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    send(payload) { this.sent = payload; return this; },
  };
  return res;
}

const req = (over = {}) => ({ method: "GET", headers: {}, query: {}, body: {}, ...over });

const deal = (over = {}) => ({
  id: "abc123-deadbeef", category: "placement", source: "offplatform", status: "booked",
  teamMember: "David", client: "Alcove", jobTitle: "Engineer", candidateRef: "Person A",
  offerSignedAt: "2026-08-01", startAt: null, paidAt: null,
  dealSizeCents: 1000000, arCents: 1000000, notes: "",
  createdBy: "david@raydar.xyz", createdAt: "2026-08-01T00:00:00Z",
  updatedBy: "david@raydar.xyz", updatedAt: "2026-08-01T00:00:00Z",
  ...over,
});

// ─── deal: permissions ───────────────────────────────────────────────────────

test("anyone signed in may add a deal, and the row is attributed to them", async () => {
  const written = [];
  const audit = [];
  const handler = createDealHandler({
    corsHandler: noCors, authHandler: allowAuth("noah@raydar.xyz"),
    editorGuard: denyEditor, kvReady: () => true,
    write: async (d) => written.push(d), logAudit: async (e) => audit.push(e),
    makeId: () => "abc123-deadbeef", now: () => "2026-08-14T00:00:00Z",
  });
  const res = mockRes();
  await handler(req({ method: "POST", body: { client: "Alcove", offerSignedAt: "2026-08-01", dealSize: "10000" } }), res);

  assert.equal(res.statusCode, 201);
  assert.equal(written.length, 1);
  assert.equal(written[0].createdBy, "noah@raydar.xyz");
  assert.equal(audit[0].action, "create");
  assert.equal(audit[0].who, "noah@raydar.xyz");
});

test("a non-editor cannot edit or delete an existing deal", async () => {
  for (const method of ["PATCH", "DELETE"]) {
    const written = [];
    const handler = createDealHandler({
      corsHandler: noCors, authHandler: allowAuth("noah@raydar.xyz"),
      editorGuard: denyEditor, kvReady: () => true,
      read: async () => deal(), write: async (d) => written.push(d),
      remove: async () => 1, logAudit: async () => true,
    });
    const res = mockRes();
    await handler(req({ method, body: { id: "abc123-deadbeef", dealSize: "999999" } }), res);
    assert.equal(res.statusCode, 403, `${method} should be refused`);
    assert.equal(written.length, 0, `${method} must not write`);
  }
});

test("a delete records the full prior row in the audit log before answering", async () => {
  const audit = [];
  const existing = deal();
  const handler = createDealHandler({
    corsHandler: noCors, authHandler: allowAuth("david@raydar.xyz"),
    editorGuard: allowEditor, kvReady: () => true,
    read: async () => existing, remove: async () => 1,
    logAudit: async (e) => audit.push(e), now: () => "2026-08-14T00:00:00Z",
  });
  const res = mockRes();
  await handler(req({ method: "DELETE", body: { id: "abc123-deadbeef" } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(audit[0].action, "delete");
  // Recoverable: the whole record is in history, not just its id.
  assert.deepEqual(audit[0].before, existing);
});

test("an invalid deal is rejected with per-field reasons and writes nothing", async () => {
  const written = [];
  const handler = createDealHandler({
    corsHandler: noCors, authHandler: allowAuth(), editorGuard: allowEditor,
    kvReady: () => true, write: async (d) => written.push(d), logAudit: async () => true,
    makeId: () => "abc123-deadbeef",
  });
  const res = mockRes();
  await handler(req({ method: "POST", body: { client: "X", offerSignedAt: "nope", dealSize: "abc" } }), res);
  assert.equal(res.statusCode, 400);
  assert.ok(res.body.details.length >= 2);
  assert.equal(written.length, 0);
});

test("a missing deal is a 404, not a silent create", async () => {
  const handler = createDealHandler({
    corsHandler: noCors, authHandler: allowAuth("david@raydar.xyz"), editorGuard: allowEditor,
    kvReady: () => true, read: async () => null, logAudit: async () => true,
  });
  const res = mockRes();
  await handler(req({ method: "PATCH", body: { id: "abc123-deadbeef", dealSize: "1" } }), res);
  assert.equal(res.statusCode, 404);
});

// ─── deals list / export ─────────────────────────────────────────────────────

test("the ledger is never cached by a browser or a CDN", async () => {
  const handler = createDealsHandler({
    corsHandler: noCors, authHandler: allowAuth(), kvReady: () => true,
    deals: async () => [deal()],
  });
  const res = mockRes();
  await handler(req(), res);
  assert.equal(res.headers["cache-control"], "no-store");
});

test("format=csv returns a downloadable file, not JSON", async () => {
  const handler = createDealsHandler({
    corsHandler: noCors, authHandler: allowAuth(), kvReady: () => true,
    deals: async () => [deal()],
  });
  const res = mockRes();
  await handler(req({ query: { format: "csv" } }), res);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"], /text\/csv/);
  assert.match(res.headers["content-disposition"], /attachment; filename="raydar-revenue-\d{4}-\d{2}-\d{2}\.csv"/);
  assert.match(res.sent, /Alcove/);
});

// ─── import ──────────────────────────────────────────────────────────────────

const PASTE = [
  "Team Member\tClient\tJob Title\tCandidate Name\tOffer Signed\tDeal Size\tA/R",
  "David\tAlcove\tEngineer\tPerson A\tAug 1\t$10,000.00\t",
  "Kyra\tSunlight\tCounsel\tPerson B\tAug 2\t$32,000.00\t$12,500.00",
].join("\n");

test("import previews without writing until it is confirmed", async () => {
  const written = [];
  const handler = createImportHandler({
    corsHandler: noCors, authHandler: allowAuth("david@raydar.xyz"), editorGuard: allowEditor,
    kvReady: () => true, existingDeals: async () => [], write: async (rows) => written.push(rows),
    logAudit: async () => true, makeId: () => `abc123-${Math.random().toString(16).slice(2, 10)}`,
  });

  const preview = mockRes();
  await handler(req({ method: "POST", body: { text: PASTE } }), preview);
  assert.equal(preview.body.committed, false);
  assert.equal(preview.body.wouldImport, 2);
  assert.equal(preview.body.totalCents, 4200000);
  assert.equal(written.length, 0, "a preview must not write");

  const commit = mockRes();
  await handler(req({ method: "POST", body: { text: PASTE, confirm: true } }), commit);
  assert.equal(commit.body.committed, true);
  assert.equal(commit.body.imported, 2);
  assert.equal(written[0].length, 2);
});

test("re-pasting the same sheet does not duplicate rows already in the ledger", async () => {
  const existing = [deal({ client: "Alcove", offerSignedAt: "2026-08-01", dealSizeCents: 1000000 })];
  const handler = createImportHandler({
    corsHandler: noCors, authHandler: allowAuth("david@raydar.xyz"), editorGuard: allowEditor,
    kvReady: () => true, existingDeals: async () => existing, write: async () => 1,
    logAudit: async () => true, makeId: () => "abc123-deadbeef",
  });
  const res = mockRes();
  await handler(req({ method: "POST", body: { text: PASTE } }), res);
  assert.equal(res.body.duplicates, 1);
  assert.equal(res.body.wouldImport, 1);
});

test("a non-editor cannot bulk import", async () => {
  const handler = createImportHandler({
    corsHandler: noCors, authHandler: allowAuth("noah@raydar.xyz"), editorGuard: denyEditor,
    kvReady: () => true, existingDeals: async () => [], write: async () => 1, logAudit: async () => true,
  });
  const res = mockRes();
  await handler(req({ method: "POST", body: { text: PASTE, confirm: true } }), res);
  assert.equal(res.statusCode, 403);
});

// ─── summary serving model ───────────────────────────────────────────────────

test("a fresh cache is served without touching Paraform", async () => {
  let built = 0;
  const handler = createSummaryHandler({
    corsHandler: noCors, authHandler: allowAuth(), kvReady: () => true,
    deals: async () => [deal()], meta: async () => ({}),
    activity: async () => ({ payload: { paraform: {}, hiresByMonth: { "2026-08": 1 } }, refreshedAt: Math.floor(Date.now() / 1000) }),
    lock: async () => true, build: async () => { built += 1; return {}; },
    persistActivity: async () => true, now: () => new Date("2026-08-14T18:00:00Z"),
  });
  const res = mockRes();
  await handler(req(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(built, 0, "a warm cache must never call the provider");
  assert.equal(res.body.revenue.bookedCents, 1000000);
});

test("a stale cache is served immediately when another request already holds the refresh lock", async () => {
  let built = 0;
  const handler = createSummaryHandler({
    corsHandler: noCors, authHandler: allowAuth(), kvReady: () => true,
    deals: async () => [deal()], meta: async () => ({}),
    activity: async () => ({ payload: { paraform: {} }, refreshedAt: 1 }),
    lock: async () => false, // someone else is rebuilding
    build: async () => { built += 1; return {}; },
    persistActivity: async () => true, now: () => new Date("2026-08-14T18:00:00Z"),
  });
  const res = mockRes();
  await handler(req(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(built, 0, "a viewer must not queue behind the provider");
  assert.equal(res.body.activityStale, true);
});

test("a provider failure still returns revenue, because revenue is our own data", async () => {
  const handler = createSummaryHandler({
    corsHandler: noCors, authHandler: allowAuth(), kvReady: () => true,
    deals: async () => [deal()], meta: async () => ({}),
    activity: async () => ({ payload: null, refreshedAt: 0 }),
    lock: async () => true, build: async () => { throw new Error("paraform down"); },
    persistActivity: async () => true, now: () => new Date("2026-08-14T18:00:00Z"),
  });
  const res = mockRes();
  await handler(req(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.revenue.bookedCents, 1000000);
  assert.equal(res.body.activity, null);
});

test("an operator target override beats the built-in default", async () => {
  const handler = createSummaryHandler({
    corsHandler: noCors, authHandler: allowAuth(), kvReady: () => true,
    deals: async () => [], meta: async () => ({ targetCents: 200000000 }),
    activity: async () => ({ payload: {}, refreshedAt: Math.floor(Date.now() / 1000) }),
    lock: async () => true, build: async () => ({}), persistActivity: async () => true,
    now: () => new Date("2026-08-14T18:00:00Z"),
  });
  const res = mockRes();
  await handler(req(), res);
  assert.equal(res.body.revenue.targetCents, 200000000);
});

// ─── refresh cron ────────────────────────────────────────────────────────────

test("the warmer refuses an unauthenticated caller", async () => {
  const handler = createRefreshHandler({ auth: () => ({ ok: false, reason: "unauthenticated" }) });
  const res = mockRes();
  await handler(req(), res);
  assert.equal(res.statusCode, 401);
});

test("a double source failure never overwrites the last-good payload", async () => {
  let persisted = 0;
  const handler = createRefreshHandler({
    auth: () => ({ ok: true }), kvReady: () => true,
    build: async () => ({ ok: false, errors: [{ source: "paraform" }, { source: "calls" }] }),
    persist: async () => { persisted += 1; },
  });
  const res = mockRes();
  await handler(req(), res);
  assert.equal(persisted, 0, "a blank payload must not replace good data");
  assert.equal(res.body.persisted, false);
});

test("a partial success is still worth persisting", async () => {
  let persisted = 0;
  const handler = createRefreshHandler({
    auth: () => ({ ok: true }), kvReady: () => true,
    build: async () => ({ ok: true, paraform: {}, calls: null, errors: [{ source: "calls" }] }),
    persist: async () => { persisted += 1; },
    now: () => new Date("2026-08-14T18:00:00Z"),
  });
  const res = mockRes();
  await handler(req(), res);
  assert.equal(persisted, 1);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.calls, false);
});
