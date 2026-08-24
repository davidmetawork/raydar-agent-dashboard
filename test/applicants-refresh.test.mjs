import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { COOLDOWN_MS, REQUEST_TTL_SECONDS, createRefreshHandler } from "../api/applicants/refresh.mjs";
import { K } from "../api/applicants/_lib/kv.mjs";

const applicants = await readFile(new URL("../applicants.html", import.meta.url), "utf8");

function res() {
  const out = { code: 0, body: null, headers: {} };
  return {
    out,
    setHeader(k, v) { out.headers[k.toLowerCase()] = v; },
    status(code) { out.code = code; return this; },
    json(body) { out.body = body; return this; },
  };
}

// A handler with every collaborator stubbed: no CORS preflight, an authed
// browser session, the machine secret accepted only when asked for, and an
// in-memory KV that records what was written and with what TTL.
function harness({ authed = true, machine = false, stored = null, at = Date.parse("2026-08-21T22:00:00.000Z") } = {}) {
  const writes = [];
  const reads = [];
  const handler = createRefreshHandler({
    corsHandler: () => false,
    authHandler: async (req) => { if (authed) req.authedEmail = "david@raydar.xyz"; return authed; },
    machineAuth: () => machine,
    kvReady: () => true,
    readJson: async (key) => { reads.push(key); return stored; },
    writeJson: async (key, value, ttl) => { writes.push({ key, value, ttl }); },
    now: () => at,
  });
  return { handler, writes, reads };
}

test("a signed-in click stores one request, stamped and expiring", async () => {
  const { handler, writes } = harness();
  const r = res();
  await handler({ method: "POST", headers: {}, body: {} }, r);
  assert.equal(r.out.code, 200);
  assert.equal(r.out.body.ok, true);
  assert.equal(r.out.body.deduped, false);
  assert.equal(r.out.body.requestedAt, "2026-08-21T22:00:00.000Z");
  assert.deepEqual(writes, [{
    key: K.refresh,
    value: { requestedAt: "2026-08-21T22:00:00.000Z", by: "david@raydar.xyz" },
    ttl: REQUEST_TTL_SECONDS,
  }]);
  assert.equal(r.out.headers["cache-control"], "no-store");
});

test("a re-click inside the cooldown rides the in-flight request instead of moving the target", async () => {
  const at = Date.parse("2026-08-21T22:00:00.000Z");
  const inFlight = { requestedAt: new Date(at - (COOLDOWN_MS - 1000)).toISOString(), by: "david@raydar.xyz" };
  const { handler, writes } = harness({ stored: inFlight, at });
  const r = res();
  await handler({ method: "POST", headers: {}, body: {} }, r);
  assert.equal(r.out.code, 200);
  assert.equal(r.out.body.deduped, true);
  // The page polls against THIS timestamp, so it must be the older one.
  assert.equal(r.out.body.requestedAt, inFlight.requestedAt);
  assert.deepEqual(writes, [], "a second click inside the cooldown must not write");
});

test("a click after the cooldown supersedes the previous request", async () => {
  const at = Date.parse("2026-08-21T22:00:00.000Z");
  const old = { requestedAt: new Date(at - (COOLDOWN_MS + 1000)).toISOString(), by: "david@raydar.xyz" };
  const { handler, writes } = harness({ stored: old, at });
  const r = res();
  await handler({ method: "POST", headers: {}, body: {} }, r);
  assert.equal(r.out.body.deduped, false);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].value.requestedAt, "2026-08-21T22:00:00.000Z");
});

test("a corrupt stored timestamp does not wedge the button", async () => {
  const { handler, writes } = harness({ stored: { requestedAt: "not-a-date" } });
  const r = res();
  await handler({ method: "POST", headers: {}, body: {} }, r);
  assert.equal(r.out.body.deduped, false);
  assert.equal(writes.length, 1, "an unparseable prior request must fall through to a fresh write");
});

test("an unauthenticated browser never reaches the store", async () => {
  const { handler, writes, reads } = harness({ authed: false });
  const r = res();
  await handler({ method: "POST", headers: {}, body: {} }, r);
  assert.deepEqual(writes, []);
  assert.deepEqual(reads, []);
});

test("the desktop read is the shared secret's, and the Google session does not open it", async () => {
  const denied = harness({ authed: true, machine: false, stored: { requestedAt: "2026-08-21T22:00:00.000Z" } });
  const r1 = res();
  await denied.handler({ method: "GET", headers: {}, body: null }, r1);
  assert.equal(r1.out.code, 401, "a browser session must not be able to read the machine channel");
  assert.deepEqual(denied.reads, []);

  const allowed = harness({ authed: false, machine: true, stored: { requestedAt: "2026-08-21T22:00:00.000Z", by: "david@raydar.xyz" } });
  const r2 = res();
  await allowed.handler({ method: "GET", headers: {}, body: null }, r2);
  assert.equal(r2.out.code, 200);
  assert.equal(r2.out.body.request.requestedAt, "2026-08-21T22:00:00.000Z");
});

test("no pending request reads as null, not as an error", async () => {
  const { handler } = harness({ machine: true, stored: null });
  const r = res();
  await handler({ method: "GET", headers: {}, body: null }, r);
  assert.equal(r.out.code, 200);
  assert.equal(r.out.body.request, null);
});

test("a store failure is a 502, never a silent success", async () => {
  const handler = createRefreshHandler({
    corsHandler: () => false,
    authHandler: async (req) => { req.authedEmail = "david@raydar.xyz"; return true; },
    machineAuth: () => false,
    kvReady: () => true,
    readJson: async () => { throw new Error("kv HTTP 500"); },
    writeJson: async () => {},
  });
  const r = res();
  await handler({ method: "POST", headers: {}, body: {} }, r);
  assert.equal(r.out.code, 502);
  assert.equal(r.out.body.ok, false);
});

test("apphub:refresh is registered and documented as this endpoint's key", async () => {
  const kv = await readFile(new URL("../api/applicants/_lib/kv.mjs", import.meta.url), "utf8");
  assert.equal(K.refresh, "apphub:refresh");
  assert.match(kv, /apphub:refresh\s+— \/api\/applicants\/refresh only, BOTH methods/);
});

/* ---- the button ---- */

test("Refresh asks the desktop to republish rather than re-reading the cache", () => {
  assert.match(applicants, /<button class="refresh-btn" id="refreshBtn" onclick="requestRefresh\(\)">Refresh<\/button>/);
  assert.match(applicants, /fetch\("\/api\/applicants\/refresh", \{\s*\n\s*method: "POST"/);
});

test("success is the snapshot moving, not the request being accepted", () => {
  // The whole point of the rebuild: only a newer generatedAt may say "Refreshed".
  assert.match(applicants, /const before = parseDate\(STATE\.snapshot\?\.generatedAt\)\?\.getTime\(\) \|\| 0;/);
  assert.match(applicants, /if \(at > REFRESH\.before\) return endRefreshWatch\(true\);/);
  assert.match(applicants, /toast\("Refreshed — the desktop republished just now\."\)/);
});

test("silence from the desktop is reported honestly, with the age of what is on screen", () => {
  assert.match(applicants, /if \(elapsed >= REFRESH_TIMEOUT_MS\) return endRefreshWatch\(false\);/);
  assert.match(applicants, /didn’t answer in " \+ Math\.round\(REFRESH_TIMEOUT_MS \/ 1000\)/);
  assert.match(applicants, /Still showing the snapshot from " \+ relTime\(at\)/);
});

test("a trigger that is unreachable degrades to the old behaviour instead of doing nothing", () => {
  assert.match(applicants, /\} catch \{\s*\n(?:\s*\/\/.*\n)*\s*await loadFeed\(true\);\s*\n\s*return;/);
});

test("the button cannot be double-fired or left stuck disabled", () => {
  assert.match(applicants, /if \(REFRESH\.running\) return;/);
  assert.match(applicants, /if \(seconds == null\) \{ btn\.disabled = false; btn\.textContent = "Refresh"; return; \}/);
  // Both exits from the watch go through the one place that re-enables it.
  assert.match(applicants, /function endRefreshWatch\(ok\) \{[\s\S]*?setRefreshBusy\(null\);/);
});

/* ---- the two clocks ---- */

test("a fresh publish over a stale plan is reported, not painted green", () => {
  // The failure this guards: 2026-08-24, invite lane unloaded from launchd for
  // 27h, snapshot republished on demand, chip read "Updated 0m ago".
  assert.match(applicants, /const planAt = parseDate\(STATE\.snapshot\?\.planAt\);/);
  assert.match(applicants, /const planStale = planH != null && planH > 3;/);
  assert.match(applicants, /\$\("updatedText"\)\.textContent \+= " · plan " \+ Math\.round\(planH\) \+ "h old";/);
});

test("a badly stale plan raises the banner and says Refresh cannot fix it", () => {
  assert.match(applicants, /The invite loop has not re-planned in " \+ Math\.round\(planH\) \+ "h"/);
  assert.match(applicants, /Refresh cannot move them/);
  assert.match(applicants, /com\.raydar\.interview-invites/);
});

test("plan age never downgrades a snapshot that is itself stale", () => {
  // ageH > 6 keeps its own red branch and message; plan age is the `else if`,
  // so a sleeping desktop is still reported as a sleeping desktop.
  const stats = applicants.slice(applicants.indexOf("function renderStats"));
  const redBranch = stats.indexOf("if (ageH > 6)");
  const planBranch = stats.indexOf("} else if (planStale)");
  assert.ok(redBranch >= 0 && planBranch > redBranch, "the ageH>6 branch must come first");
});
