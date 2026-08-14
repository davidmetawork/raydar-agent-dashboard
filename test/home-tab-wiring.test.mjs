// The shell keeps a tab in FOUR parallel registries — the VIEWS array, the nav
// anchors, the view divs, and the ⌘K palette. Nothing enforced that they agree,
// and a mismatch is not a caught error: showView() does
// document.getElementById("view-"+v).hidden, so a name in VIEWS with no div is
// an unguarded TypeError that blanks the whole dashboard.
//
// These tests pin the invariant for every tab, not just Home.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const index = await readFile(new URL("../index.html", import.meta.url), "utf8");
const home = await readFile(new URL("../home.html", import.meta.url), "utf8");
const vercel = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));

const views = JSON.parse(index.match(/const VIEWS=(\[[^\]]+\]);/)[1].replace(/'/g, '"'));

test("every VIEWS entry has a nav anchor and a view container", () => {
  for (const view of views) {
    assert.ok(index.includes(`id="tab-${view}"`), `missing nav anchor for "${view}"`);
    assert.ok(index.includes(`id="view-${view}"`), `missing view container for "${view}"`);
  }
});

test("every ⌘K palette entry is a real view", () => {
  const palette = [...index.matchAll(/\{name:"([a-z]+)",label:"[^"]+",group:"[^"]+"\}/g)].map((m) => m[1]);
  assert.ok(palette.length >= views.length - 1, "palette looks truncated");
  for (const name of palette) assert.ok(views.includes(name), `palette entry "${name}" is not in VIEWS`);
});

test("home is the landing view and the unknown-hash fallback", () => {
  // RaydarNav falls back to names[0], so first position IS the landing rule.
  assert.equal(views[0], "home");
  assert.match(index, /let currentView="home";/);
  assert.match(index, /<a class="tab active" id="tab-home" href="#home" aria-current="page"/);
});

test("overview keeps its own tab and deep link, just not the default", () => {
  assert.ok(views.includes("overview"));
  assert.match(index, /<a class="tab" id="tab-overview" href="#overview"/);
  // Exactly one tab may be pre-marked active, or two look selected on first paint.
  assert.equal((index.match(/class="tab active"/g) || []).length, 1);
  assert.equal((index.match(/aria-current="page"/g) || []).length, 1);
});

test("the home frame is lazy-loaded exactly once, like every other iframe tab", () => {
  assert.match(index, /let .*homeLoaded=false;/);
  assert.match(index, /if\(name==="home" && !homeLoaded\)\{ \$\("home-frame"\)\.src=frameSrc\("\/home","home"\); homeLoaded=true; \}/);
  assert.match(index, /<iframe id="home-frame"/);
});

test("/home is routed and the revenue functions are configured", () => {
  assert.ok(vercel.rewrites.some((r) => r.source === "/home" && r.destination === "/home.html"));
  assert.ok(vercel.functions["api/revenue/*.mjs"], "revenue functions need a maxDuration");
});

test("the activity warmer cron is registered so the page never waits on Paraform", () => {
  const cron = vercel.crons.find((c) => c.path === "/api/revenue/refresh");
  assert.ok(cron, "missing the revenue refresh cron");
  assert.equal(cron.schedule, "*/5 * * * *");
});

test("home.html renders inside the shell iframe and behind the Google gate", () => {
  assert.match(home, /params\.has\("embed"\)/, "must honour ?embed=1 like every other tab page");
  assert.match(home, /RaydarAuth\.session\(\)/, "must sit behind the shared Raydar session");
  assert.match(home, /body\.embed header \.brand h1/, "must hide its own title when embedded");
});

test("home.html never caches the revenue payload to localStorage", () => {
  // The placement-metrics payload is PII-free and is cached for instant paint.
  // This one carries client names, candidate labels and amounts, so the same
  // trick would put PII in browser storage. Only opaque prefs may be stored.
  const stored = [...home.matchAll(/localStorage\.setItem\("([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(stored.sort(), ["revLastSeenDeal", "revPeriod"]);
});

test("landing on Home does not delay the live status poll", () => {
  // THE safety property of moving the landing tab. The Overview feed must keep
  // loading on page load and polling every 30s even while its view is hidden —
  // if this were ever gated on the active view, making Home the default would
  // silently stop live call monitoring for anyone who never clicks Overview.
  assert.match(index, /skeleton\(\); load\(\); setInterval\(load, 30000\);/);
  // And that call must not sit inside a view-conditional block.
  const line = index.split("\n").find((l) => l.includes("skeleton(); load(); setInterval(load, 30000);"));
  assert.ok(!/view-|hidden|currentView/.test(line), `status poll became view-conditional: ${line}`);
});

test("the honest-gap section is rendered, not quietly dropped", () => {
  assert.match(home, /Not shown, and why/);
  assert.match(home, /missingList/);
});
