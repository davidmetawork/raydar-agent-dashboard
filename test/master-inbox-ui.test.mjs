import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

/* Every file this suite reads is named here and nowhere else. When the page is
   split into modules (slice 4) only PAGE_SOURCE moves; the assertions below
   keep pointing at whatever it names. */
const PAGE_SOURCE = "../master-inbox.html";
const SHELL_SOURCE = "../index.html";
const ROUTE_SOURCE = "../master-inbox-route.js";
const PROXY_SOURCE = "../api/master-inbox/feed.mjs";

const read = path => fs.readFileSync(new URL(path, import.meta.url), "utf8");
const source = read(PAGE_SOURCE);
const shell = read(SHELL_SOURCE);
const route = read(ROUTE_SOURCE);
const proxy = read(PROXY_SOURCE);

test("Master Inbox converts stored participant JSON into a Gmail-style sender label", () => {
  assert.match(source, /function contacts\(value\)/);
  assert.match(source, /function firstContact\(value\)/);
  assert.match(source, /contact\?\.name\|\|contact\?\.address/);
  assert.doesNotMatch(source, /const name=value=>String\(value\|\|"Unknown sender"\)/);
});

test("Master Inbox rows and embedded reader have bounded, non-overlapping layout", () => {
  assert.match(source, /\.who,\.subject,\.snippet\{display:block/);
  assert.match(source, /\.row>span:nth-child\(3\)\{display:block;min-width:0;overflow:hidden\}/);
  assert.match(source, /\.embedded \.app\{max-width:none;height:100vh/);
  assert.match(source, /\.meta strong,\.meta small\{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis\}/);
});

test("Master Inbox decodes provider text entities before safely rendering previews", () => {
  assert.match(source, /const displayText=value=>/);
  assert.match(source, /esc\(displayText\(row\.subject/);
  assert.match(source, /esc\(displayText\(row\.snippet\)\)/);
  assert.match(source, /esc\(displayText\(thread\.subject/);
});

test("Master Inbox composer can close before required fields are filled", () => {
  assert.match(source, /value="cancel" formnovalidate aria-label="Close"/);
});

test("Master Inbox collapses RFC-identical mailbox copies only in the read view", () => {
  assert.match(source, /function logicalMessages\(messages\)/);
  assert.match(source, /message\.rfc_message_id\?`rfc:/);
  assert.match(source, /const threadMessages=logicalMessages\(thread\.messages\|\|\[\]\)/);
  assert.match(source, /const threadTargets=\(STATE\.thread\?\.messages\|\|\[\]\)/);
});

test("Current dashboard shell keeps its newer routes and uses the refreshed embedded inbox build", () => {
  assert.match(shell, /id="tab-status-v2"/);
  assert.match(shell, /frameSrc\("\/submissions-v2","submissions"\)/);
  assert.match(shell, /frameSrc\("\/review","review"\)/);
  assert.match(shell, /id="master-inbox-frame"[^>]*height:calc\(100vh - 24px\)/);
  assert.match(shell, /frameSrc\("\/master-inbox","master-inbox"\)\+"&v=20260910-coverage"/);
});

test("Master Inbox loads the pure route module before the page script can use it", () => {
  assert.match(source, /<script src="\/master-inbox-route\.js"><\/script>/);
  assert.ok(source.indexOf('src="/master-inbox-route.js"') < source.indexOf("const ROUTE=window.MasterInboxRoute"), "the module must be loaded before the page reads it");
  assert.match(route, /window\.MasterInboxRoute = api/);
  assert.match(route, /module\.exports = api/);
});

test("Master Inbox states coverage from the store and never asserts current on its own", () => {
  assert.match(source, /STATE\.coverage=data\.coverage\|\|null/);
  assert.match(source, /STATE\.parsed=data\.query\|\|null/);
  assert.match(source, /ROUTE\.coverageSummary\(STATE\.coverage/);
  assert.match(source, /ROUTE\.emptyStateText\(STATE\.coverage\)/);
  assert.doesNotMatch(source, /"Shared store current"/);
  assert.doesNotMatch(source, /<div class="status" id="status">/);
});

test("Master Inbox shows the search terms the store could not honour", () => {
  assert.match(source, /id="searchNotice"/);
  assert.match(source, /function renderNotice\(\)\{const text=ROUTE\.searchNotice\(STATE\.parsed\)/);
  assert.match(route, /is not supported; searched as/);
});

test("Master Inbox keeps the chosen account when the folder changes", () => {
  const handler = source.match(/document\.querySelectorAll\("\[data-folder\]"\)\.forEach\(button=>button\.onclick=\(\)=>\{[^}]*\}\);/);
  assert.ok(handler, "the folder handler must still exist");
  assert.doesNotMatch(handler[0], /STATE\.mailbox=""/);
  assert.match(source, /function renderTitle\(\)\{\$\("viewTitle"\)\.textContent=ROUTE\.viewTitle\(STATE\.folder,scopedAddress\(\)\)/);
  assert.match(source, /ROUTE\.badgeCopy\(row\.mailbox_ids,STATE\.mailbox\)/);
});

test("Master Inbox rows are addressable links and drill-in goes through RaydarNav", () => {
  assert.match(source, /window\.RaydarNav\?\.href\(address\)/);
  assert.match(source, /<a class="rowlink" href=/);
  assert.match(source, /window\.RaydarNav\.open\(screen,\(\)=>\{STATE\.screen=previous;closeReader\(\);\},ROUTE\.serializeRoute/);
  assert.match(source, /\$\("backList"\)\.onclick=\(\)=>\{if\(!\(window\.RaydarNav&&window\.RaydarNav\.back\(STATE\.screen\)\)\)closeReader\(\);\};/);
  assert.match(source, /window\.RaydarNav\?\.restore\(address=>\{const route=ROUTE\.parseRoute\(address\)/);
  assert.doesNotMatch(source, /#conversation=\$\{row\.id\}/);
});

test("Master Inbox feed proxy keeps an explicit allowlist and passes coverage through untouched", () => {
  assert.match(proxy, /const FEED_PARAMS = \["q", "mailbox", "folder", "cursor", "limit"\];/);
  assert.match(proxy, /params\.set\("strict", "1"\)/);
  assert.match(proxy, /\{ \.\.\.feed\.body, configured: true/);
  assert.doesNotMatch(proxy, /coverage:/);
});
