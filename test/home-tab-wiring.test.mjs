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
const submissions = await readFile(new URL("../submissions.html", import.meta.url), "utf8");
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

test("a bare monitor.raydar.xyz settles on Home, hash or no hash", () => {
  // THE landing bug: boot used to call showView() only for a recognised #hash,
  // so a URL with no hash left whatever the static markup happened to show. The
  // call must be unconditional, and the static markup must paint Home — every
  // other view carries `hidden` so nothing else can be the one on screen.
  assert.match(index, /showView\(landed \? deepLink : VIEWS\[0\],\s*false\);/);
  assert.doesNotMatch(index, /if\(landed\) showView\(/);
  assert.match(index, /<div id="view-home">/);
  assert.match(index, /<div id="view-overview" hidden>/);
  // Exactly one view may paint without `hidden`, or two stack on first load.
  const containers = [...index.matchAll(/<div id="view-([a-z]+)"( hidden)?>/g)];
  const visible = containers.filter((m) => !m[2]).map((m) => m[1]);
  assert.deepEqual(visible, ["home"], `views painted on load: ${visible.join(", ")}`);
});

test("the live-call view is labelled Agent Calls but keeps the overview name", () => {
  // Renaming the LABEL only: every existing #overview bookmark, deep link and
  // cross-page link resolves against the internal name, which must not move.
  assert.ok(views.includes("overview"));
  assert.match(index, /<a class="tab" id="tab-overview" href="#overview"/);
  assert.match(index, /<span class="lbl">Agent Calls<\/span>/);
  assert.match(index, /\{name:"overview",label:"Agent Calls",group:"Live"\}/);
  assert.doesNotMatch(index, /<span class="lbl">Overview<\/span>/);
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

test("Submissions is wired through all five dashboard registries", () => {
  assert.ok(views.includes("submissions"));
  assert.match(index, /id="tab-submissions"/);
  assert.match(index, /id="view-submissions" hidden/);
  assert.match(index, /\{name:"submissions",label:"Submissions",group:"People"\}/);
  assert.ok(vercel.rewrites.some((row) => row.source === "/submissions" && row.destination === "/submissions.html"));
  assert.ok(vercel.functions["api/submissions/*.mjs"]);
  assert.ok(vercel.crons.some((row) => row.path === "/api/submissions/refresh" && row.schedule === "3,18,33,48 * * * *"));
});

test("Submissions is team-gated, cache-rendered, and never auto-submits from the page", () => {
  assert.match(submissions, /RaydarAuth\.session\(\)/);
  assert.match(submissions, /\/api\/submissions\/list/);
  assert.match(submissions, /action:"preview"/);
  assert.match(submissions, /action:"submit"/);
  assert.doesNotMatch(submissions, /\/api\/paraai\/(?:worker|interest)|action:"tick"/);
  assert.match(submissions, /Raydar sends no candidate email/);
  assert.match(submissions, /Resume tailoring awaits the supervised capture/);
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
  // trick would put PII in browser storage. Only opaque prefs may be stored:
  // a deal id, a milestone COUNT (0-4), and the period toggle. No amounts.
  const stored = [...home.matchAll(/localStorage\.setItem\("([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(stored.sort(), ["revLastSeenDeal", "revMilestone", "revPeriod"]);
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

// ── the page's scope, as David set it ────────────────────────────────────────
// Home tracks ONE thing: the moment a deal is signed. Collection, ageing and
// per-person attribution were deliberately removed — they made a shared target
// read as an accounting report. The ledger still STORES arCents (the sheet
// import maps a real A/R column and the CSV export still carries it); the rule
// is that none of it surfaces here.

test("no collection or A/R concept reaches the page", () => {
  const body = home.replace(/<textarea[\s\S]*?<\/textarea>/g, "");   // the paste hint mirrors David's sheet header
  for (const banned of [/statCollected/, /statAr/, /arChart/, /A\/R aging/i, /Outstanding A\/R/i,
                        /collectedCents/, /revenue\.ar\b/]) {
    assert.doesNotMatch(body, banned, `"${banned}" is back on the homepage`);
  }
});

test("the deals table drops Who and A/R and keeps six columns", () => {
  const head = home.match(/<thead><tr>([\s\S]*?)<\/tr><\/thead>/)[1];
  const columns = [...head.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1].trim());
  assert.deepEqual(columns, ["Signed", "Client", "Role", "Deal", "Status", ""]);
  // colspan on the empty state must match, or the placeholder row misaligns.
  assert.match(home, /colspan="6"/);
});

test("per-team-member breakdown is gone — one team, one number", () => {
  for (const banned of [/By team member/i, /memberChart/, /f-member/, /teamMember/]) {
    assert.doesNotMatch(home, banned, `"${banned}" is back on the homepage`);
  }
});

test("Activity sits above Deals", () => {
  assert.ok(home.indexOf('id="activityCard"') < home.indexOf('id="dealsCard"'),
    "the Activity card must come before the Deals card in the document");
});

test("the calls-per-week chart and the honest-gap list are gone", () => {
  for (const banned of [/Calls set per week/i, /callsChart/, /renderCalls/,
                        /Not shown, and why/i, /missingList/]) {
    assert.doesNotMatch(home, banned, `"${banned}" is back on the homepage`);
  }
});

test("signed dates render long-form, timezone-free", () => {
  // "2026-08-13" -> "August 13th, 2026". Parsed from the string's own parts:
  // new Date("2026-08-13") is UTC midnight and renders as the 12th west of
  // Greenwich, which would silently misdate every deal on the board.
  assert.match(home, /function prettyDate\(iso\)/);
  assert.match(home, /prettyDate\(deal\.offerSignedAt\)/);
  const pretty = home.match(/function prettyDate[\s\S]*?\n\}/)[0];
  assert.doesNotMatch(pretty, /new Date\(/, "prettyDate must not go through Date()");
  assert.match(home, /function ordinal\(day\)/);
});
