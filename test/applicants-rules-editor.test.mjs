import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { createFixtureServer, createFixtureState } from "../scripts/rules-design-preview.mjs";

const sourcePath = new URL("../applicants-rules.js", import.meta.url);

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function element(id = "") {
  return {
    id, innerHTML: "", textContent: "", value: "", checked: false, hidden: false, disabled: false,
    dataset: {}, style: { removeProperty() {} }, isConnected: true, firstChild: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild() {}, addEventListener() {}, setAttribute() {}, focus() {}, replaceWith() {},
    querySelector() { return null; }, querySelectorAll() { return []; }, getClientRects() { return []; },
  };
}

async function loadRulesUi(fetchImpl) {
  let source = await readFile(sourcePath, "utf8");
  const hook = "globalThis.__rulesTest = { state, valueControl, runPreview, schedulePreview, runRules, openEditor, preparedDraft };";
  const close = source.lastIndexOf("})();");
  assert.ok(close > 0, "rules source remains a classic-script closure");
  source = `${source.slice(0, close)}\n${hook}\n${source.slice(close)}`;
  const nodes = new Map();
  const document = {
    readyState: "loading", activeElement: element("active"), head: element("head"), body: element("body"),
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, element(id)); return nodes.get(id); },
    createElement(tag) { return element(tag); },
    addEventListener() {},
  };
  const window = {
    document, addEventListener() {}, confirm: () => true,
    RaydarApplicantsGeneration: () => ({ generationId: "local-rules-design-fixture-v1", generationDigest: "local-fixture-no-production-data" }),
  };
  const context = {
    window, document, globalThis: null, console, fetch: fetchImpl,
    setTimeout, clearTimeout, structuredClone, URLSearchParams,
    STATE: { view: "rules", snapshot: { queue: [{ key: "one" }, { key: "two" }] }, generation: null },
    pendingRows: () => [{ key: "one" }, { key: "two" }],
    toast() {}, loadFeed: async () => {}, lockOuterScroll() {}, ensureRoom() {},
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "applicants-rules.js" });
  return { testApi: context.__rulesTest, nodes, window };
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test("an older preview response cannot overwrite the newest draft preview", async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const { testApi } = await loadRulesUi(() => (++calls === 1 ? first.promise : second.promise));
  testApi.state.catalog = [{ name: "application.tier", group: "application", ops: ["any_of"], kind: "tiers", label: "Tier is", picker: null }];
  testApi.state.draft = { id: null, name: "Tier rule", action: "pass", state: "live", scope: { roleIds: [] }, conditions: [{ field: "application.tier", op: "any_of", value: ["A"] }] };
  testApi.state.previewSerial = 1;
  testApi.state.previewing = true;

  const oldRequest = testApi.runPreview();
  testApi.state.previewSerial = 2;
  testApi.state.draft.conditions[0].value = ["B"];
  const newRequest = testApi.runPreview();
  second.resolve(response({ ok: true, matched: 2, considered: 6, skipped: {}, samples: [] }));
  await newRequest;
  first.resolve(response({ ok: true, matched: 5, considered: 6, skipped: {}, samples: [] }));
  await oldRequest;

  assert.equal(testApi.state.preview.matched, 2);
  assert.equal(testApi.state.previewSerial, 2);
});

test("a selected id missing from the current directory remains visible and checked", async () => {
  const { testApi } = await loadRulesUi(async () => response({ ok: true }));
  testApi.state.catalog = [{ name: "school.id", group: "school", ops: ["any_of"], kind: "ids", label: "Attended", picker: "schools" }];
  testApi.state.directories = { schools: {}, companies: {} };
  testApi.state.draft = {
    id: "saved", name: "Legacy school", action: "interview", state: "off", scope: { roleIds: [] },
    labels: { "school-not-in-directory": "Saved School Name" },
    conditions: [{ field: "school.id", op: "any_of", value: ["school-not-in-directory"] }],
  };
  const html = testApi.valueControl(testApi.state.draft.conditions[0], 0);
  assert.match(html, /value="school-not-in-directory" checked/);
  assert.match(html, />Saved School Name</);
});

test("Run rules now is a confirmed manual POST and carries the visible generation", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === "/api/applicants/rules-tick") return response({ ok: true, considered: 2, decided: 1, skipped: {} });
    if (url.startsWith("/api/applicants/rules")) return response({
      ok: true, rev: 2, pausedAll: false, rules: [{ id: "ready", name: "Ready", action: "pass", state: "live", scope: { roleIds: [] }, conditions: [{ field: "application.tier", op: "any_of", value: ["C"] }] }],
      stats: {}, catalog: [], groups: [], degreeLevels: [], directories: { schools: {}, companies: {} },
    });
    throw new Error(`unexpected request ${url}`);
  };
  const { testApi, window } = await loadRulesUi(fetchImpl);
  testApi.state.loaded = true;
  testApi.state.rules = [{ id: "ready", name: "Ready", action: "pass", state: "live", scope: { roleIds: [] }, conditions: [{ field: "application.tier", op: "any_of", value: ["C"] }] }];
  let confirmations = 0;
  window.confirm = () => { confirmations += 1; return true; };
  await testApi.runRules();

  const tick = calls.find((call) => call.url === "/api/applicants/rules-tick");
  assert.equal(confirmations, 1);
  assert.equal(tick.options.method, "POST");
  assert.deepEqual(JSON.parse(tick.options.body), {
    generationId: "local-rules-design-fixture-v1",
    generationDigest: "local-fixture-no-production-data",
  });
});

test("local preview server serves synthetic APIs and never proxies unknown API routes", async (t) => {
  const fixtureState = createFixtureState();
  const server = createFixtureServer({ state: fixtureState });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const feed = await fetch(`${base}/api/applicants/feed`).then((r) => r.json());
  assert.equal(feed.ok, true);
  assert.equal(feed.snapshot.queue.length, 6);
  assert.equal(feed.generation.sourceWatermark, "synthetic-only");

  const blockedResponse = await fetch(`${base}/api/provider/anything`);
  const blocked = await blockedResponse.json();
  assert.equal(blockedResponse.status, 404);
  assert.equal(blocked.error, "local_fixture_only");

  const pageResponse = await fetch(`${base}/applicants`);
  assert.equal(pageResponse.headers.get("x-raydar-fixture"), "synthetic-local-only");
  assert.match(pageResponse.headers.get("content-security-policy"), /connect-src 'self'/);
  const page = await pageResponse.text();
  assert.match(page, /<title>Raydar · Applicants<\/title>/);
  assert.match(page, /Local design preview · Sample data/);
  assert.match(page, /src="\/resume-renderer-v2\/assets\/raydar-lockup\.svg"/);
  assert.doesNotMatch(page, /src="https:\/\/webview-lake\.vercel\.app\/assets\/raydar-black\.png"/);
  const config = await fetch(`${base}/api/seq/config`).then((r) => r.json());
  assert.equal(config.authRequired, true);
  const session = await fetch(`${base}/api/auth/session`).then((r) => r.json());
  assert.equal(session.authenticated, true);
});

test("fixture preview, save, pause, delete, hits, and tick mutate memory only", async (t) => {
  const fixtureState = createFixtureState();
  const server = createFixtureServer({ state: fixtureState });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const post = (path, body) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const generationBody = { generationId: "local-rules-design-fixture-v1", generationDigest: "local-fixture-no-production-data" };

  const preview = await post("/api/applicants/rules", { op: "preview", ...generationBody, rule: { name: "Platform role", action: "interview", state: "live", scope: { roleIds: [] }, conditions: [{ field: "application.roleId", op: "any_of", value: ["role-platform"] }] } });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.matched, 3);

  const saved = await post("/api/applicants/rules", { op: "save", rev: fixtureState.rev, rule: { name: "Only B", action: "pass", state: "live", scope: { roleIds: [] }, conditions: [{ field: "application.tier", op: "any_of", value: ["B"] }] } });
  assert.equal(saved.status, 200);
  const savedId = saved.body.rule.id;
  const off = await post("/api/applicants/rules", { op: "setState", rev: fixtureState.rev, id: savedId, state: "off" });
  assert.equal(off.body.rules.find((rule) => rule.id === savedId).state, "off");
  const live = await post("/api/applicants/rules", { op: "setState", rev: fixtureState.rev, id: savedId, state: "live" });
  assert.equal(live.body.rules.find((rule) => rule.id === savedId).state, "live");
  const tick = await post("/api/applicants/rules-tick", generationBody);
  assert.equal(tick.status, 200);
  assert.ok(tick.body.decided > 0);
  const afterTickFeed = await fetch(`${base}/api/applicants/feed`).then((r) => r.json());
  assert.equal(afterTickFeed.snapshot.counts.queue, 6 - tick.body.decided);
  const hits = await post("/api/applicants/rules", { op: "hits", id: savedId });
  assert.equal(hits.status, 200);
  assert.ok(hits.body.hits.length > 0);

  const paused = await post("/api/applicants/rules", { op: "pauseAll", rev: fixtureState.rev, paused: true });
  assert.equal(paused.body.pausedAll, true);
  const parked = await post("/api/applicants/rules-tick", generationBody);
  assert.equal(parked.body.parked, "all_rules_paused");
  const deleted = await post("/api/applicants/rules", { op: "delete", rev: fixtureState.rev, id: savedId });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.rules.some((rule) => rule.id === savedId), false);
});
