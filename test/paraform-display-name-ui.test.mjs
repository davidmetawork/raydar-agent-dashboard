import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const indexHtml = await readFile(new URL("../index.html", import.meta.url), "utf8");
const callHtml = await readFile(new URL("../call.html", import.meta.url), "utf8");

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  assert.notEqual(to, -1, `missing end marker: ${end}`);
  return source.slice(from + start.length, to);
}

function displayHelpers() {
  const source = between(
    indexHtml,
    "    const esc =",
    "    /* END:PARAFORM-DISPLAY-IDENTITY */",
  );
  const ctx = vm.createContext({ String, encodeURIComponent });
  vm.runInContext(`const esc =${source}
globalThis.display = displayName;
globalThis.link = nameLink;
globalThis.query = paraformQ;`, ctx);
  return ctx;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function callsEnrichmentHarness({ fetchImpl, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout }) {
  const labels = new Map();
  const displayNameSource = between(
    indexHtml,
    "    const displayName = ",
    ";\n\n    // Candidate name",
  );
  const enrichmentSource = between(
    indexHtml,
    "    async function cvEnrichDisplayNames",
    "    async function cvVerifyStatus",
  );
  const ctx = vm.createContext({
    AbortController,
    URLSearchParams,
    fetch: fetchImpl,
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
  });
  ctx.$ = (id) => labels.get(id) || null;
  vm.runInContext(`
    const displayName = ${displayNameSource};
    const API_BASE = "https://webview-lake.vercel.app";
    let cvDisplayController = null;
    let cvSearchRequest = 1;
    async function cvEnrichDisplayNames${enrichmentSource}
    globalThis.enrich = cvEnrichDisplayNames;
    globalThis.setRequest = (id) => { cvSearchRequest = id; };
  `, ctx);
  return { ctx, labels };
}

function callPageEnrichmentHarness({ fetchImpl, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout }) {
  const label = { textContent: "Booking Alias" };
  const displayNameSource = between(
    callHtml,
    "  const displayName = ",
    ";\n  function toast",
  );
  const enrichmentSource = between(
    callHtml,
    "  async function enrichDisplayName",
    "  async function load()",
  );
  const ctx = vm.createContext({
    AbortController,
    URLSearchParams,
    fetch: fetchImpl,
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
  });
  ctx.document = { getElementById: (id) => id === "candidate-name" ? label : null };
  vm.runInContext(`
    const displayName = ${displayNameSource};
    const DISPLAY_NAMES_API = "https://webview-lake.vercel.app/api/paraform-display-names";
    async function enrichDisplayName${enrichmentSource}
    globalThis.enrich = enrichDisplayName;
  `, ctx);
  return { ctx, label };
}

test("display identity preserves Paraform's exact non-empty string and falls back safely", () => {
  const ctx = displayHelpers();
  const exact = `  Zoë "Ace" O'Neil & <Lead>  `;

  assert.equal(ctx.display({ candidate: "Zoe", paraformName: exact }), exact);
  assert.equal(ctx.display({ candidate: "Zoe", paraformName: " \n\t " }), "Zoe");
  assert.equal(ctx.display({ c: "History alias" }), "History alias");
  assert.equal(ctx.display({ name: "Calls alias" }), "Calls alias");
});

test("candidate links preserve text while escaping both quote types in attributes", () => {
  const ctx = displayHelpers();
  const exact = `  Zoë "Ace" O'Neil & <Lead>  `;
  const link = ctx.link(exact);

  assert.ok(link.includes(`>  Zoë "Ace" O'Neil &amp; &lt;Lead&gt;  <span`));
  assert.ok(link.includes("title=\"Find   Zoë &quot;Ace&quot; O&#39;Neil &amp; &lt;Lead&gt;   on Paraform\""));
  assert.ok(link.includes("&amp;q=++Zo%C3%AB+%22Ace%22+O&#39;Neil+%26+%3CLead%3E++"));
  assert.ok(!link.includes(`title="Find ${exact} on Paraform"`));
});

test("all approved Monitor surfaces use displayName without replacing operational identity", () => {
  assert.match(indexHtml, /nameLink\(displayName\(u\)\)/);
  assert.match(indexHtml, /nameLink\(displayName\(c\)\).*REVIEW/);
  assert.match(indexHtml, /const visibleName = displayName\(c\)/);
  assert.match(indexHtml, /paraformQ\(visibleName\)/);
  const history = between(indexHtml, "    function renderHistory(days){", "    // --- tiny dependency-free SVG charts ---");
  assert.match(history, /nameLink\(displayName\(c\)\)/);
  assert.match(indexHtml, /nameLink\(displayName\(r\)\).*gmailLink\(r\.candidate\)/);
  assert.doesNotMatch(indexHtml, /gmailLink\(displayName/);
  assert.match(
    indexHtml,
    /!String\(r\.candidate\|\|""\)\.toLowerCase\(\)\.includes\(q\) && !String\(r\.paraformName\|\|""\)\.toLowerCase\(\)\.includes\(q\)/,
  );

  const callsSearch = between(indexHtml, "    async function cvSearch(deep=false){", "    const API_BASE");
  assert.match(callsSearch, /params\.set\("name", name\)/);
  assert.doesNotMatch(callsSearch, /params\.set\("name", .*paraformName/);

  const backlog = between(indexHtml, "    function buildBacklog(){", "    function renderFollowups(d){");
  assert.match(backlog, /candidate:c\.c/);
  assert.match(backlog, /candidate:c\.candidate/);
  assert.match(backlog, /paraformName:c\.paraformName/g);
  assert.match(backlog, /fuNorm\(c\.candidate\)/);
  assert.doesNotMatch(backlog, /fuNorm\(displayName/);
  assert.doesNotMatch(indexHtml, /candidate\s*=\s*displayName/);
});

test("Calls cards paint immediately, then enrich labels by exact bot id without reordering", () => {
  const search = between(indexHtml, "    async function cvSearch(deep=false){", "    const API_BASE");
  const initialPaint = search.indexOf("out.innerHTML = `<div class=\"cv-head\"");
  const enrichment = search.indexOf("void cvEnrichDisplayNames(j.results,requestId)");

  assert.ok(initialPaint >= 0 && enrichment > initialPaint);
  assert.match(indexHtml, /new Set\(results\.map\(row=>String\(row\?\.botId\|\|""\)\)\.filter\(Boolean\)\)\]\.slice\(0,30\)/);
  assert.match(indexHtml, /params\.append\("id",id\)/);
  assert.match(indexHtml, /API_BASE\+"\/api\/paraform-display-names\?"\+params/);
  assert.match(indexHtml, /label\.textContent=displayName\(\{ paraformName:row\.paraformName, candidate:row\.name \}\)/);
  assert.match(indexHtml, /fetch\(CALLS_API \+ "\/api\/call\?bot=" \+ encodeURIComponent\(row\.botId\)\)/);
});

test("Calls display enrichment is independently abortable and stale responses cannot repaint a new search", async () => {
  const first = deferred();
  const requests = [];
  const { ctx, labels } = callsEnrichmentHarness({
    fetchImpl: (url, init) => {
      requests.push({ url, signal: init.signal });
      if (requests.length === 1) return first.promise;
      return Promise.resolve({
        ok: true,
        json: async () => ({ names: { "bot-new": `  Exact "New" O'Neil  ` } }),
      });
    },
  });
  labels.set("cv-name-1-0", { textContent: "Old booking alias" });
  labels.set("cv-name-2-0", { textContent: "New booking alias" });
  const oldRows = [{ botId: "bot-old", name: "Old booking alias" }];
  const newRows = [{ botId: "bot-new", name: "New booking alias" }];

  const oldRun = ctx.enrich(oldRows, 1);
  assert.equal(requests[0].signal.aborted, false);
  ctx.setRequest(2);
  const newRun = ctx.enrich(newRows, 2);
  assert.equal(requests[0].signal.aborted, true);
  await newRun;
  assert.equal(labels.get("cv-name-2-0").textContent, `  Exact "New" O'Neil  `);
  assert.deepEqual(newRows.map((row) => row.botId), ["bot-new"]);

  first.resolve({
    ok: true,
    json: async () => ({ names: { "bot-old": "Stale exact name" } }),
  });
  await oldRun;
  assert.equal(labels.get("cv-name-1-0").textContent, "Old booking alias");
});

test("Calls display bridge failure, empty data, and timeout leave the operational alias visible", async () => {
  const failures = [
    { ok: false, json: async () => ({ error: "unavailable" }) },
    { ok: true, json: async () => ({ names: {} }) },
  ];
  const { ctx, labels } = callsEnrichmentHarness({
    fetchImpl: async () => failures.shift(),
  });
  labels.set("cv-name-1-0", { textContent: "Booking Alias" });
  const rows = [{ botId: "bot-1", name: "Booking Alias" }];

  await ctx.enrich(rows, 1);
  assert.equal(labels.get("cv-name-1-0").textContent, "Booking Alias");
  await ctx.enrich(rows, 1);
  assert.equal(labels.get("cv-name-1-0").textContent, "Booking Alias");

  let fireTimeout = null;
  const timeoutHarness = callsEnrichmentHarness({
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }),
    setTimeoutImpl: (callback) => { fireTimeout = callback; return 1; },
    clearTimeoutImpl: () => {},
  });
  timeoutHarness.labels.set("cv-name-1-0", { textContent: "Booking Alias" });
  const timedRun = timeoutHarness.ctx.enrich(rows, 1);
  fireTimeout();
  await timedRun;
  assert.equal(timeoutHarness.labels.get("cv-name-1-0").textContent, "Booking Alias");
});

test("canonical call page renders the Calls alias first and enriches only its visible heading", () => {
  const load = between(callHtml, "  async function load(){", "  load();");
  assert.match(callHtml, /id="candidate-name">\$\{esc\(displayName\(\{ candidate:c\.fullName \}\)\)\}/);
  assert.match(callHtml, /DISPLAY_NAMES_API\+"\?"\+params/);
  assert.match(callHtml, /params\.append\("id",id\)/);
  assert.match(callHtml, /label\.textContent=displayName\(\{ paraformName:payload\?\.names\?\.\[id\], candidate:operationalName \}\)/);
  assert.ok(load.indexOf("render(j)") < load.indexOf("void enrichDisplayName(id,j.candidate.fullName)"));
  assert.doesNotMatch(load, /await enrichDisplayName/);
  assert.match(load, /CALLS_API \+ "\/api\/call\?bot=" \+ encodeURIComponent\(id\)/);
});

test("canonical call page preserves its operational heading on bridge failure and applies an exact success", async () => {
  const responses = [
    { ok: false, json: async () => ({ error: "unavailable" }) },
    { ok: true, json: async () => ({ names: {} }) },
    { ok: true, json: async () => ({ names: { "bot-1": `  Zoë "Ace" O'Neil & <Lead>  ` } }) },
  ];
  const { ctx, label } = callPageEnrichmentHarness({
    fetchImpl: async () => responses.shift(),
  });

  await ctx.enrich("bot-1", "Booking Alias");
  assert.equal(label.textContent, "Booking Alias");
  await ctx.enrich("bot-1", "Booking Alias");
  assert.equal(label.textContent, "Booking Alias");
  await ctx.enrich("bot-1", "Booking Alias");
  assert.equal(label.textContent, `  Zoë "Ace" O'Neil & <Lead>  `);
});
