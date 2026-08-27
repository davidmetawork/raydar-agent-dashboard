// The browser half of the count-drop tripwire (server half:
// applicants-count-tripwire.test.mjs). Same source-shape approach as the other
// applicants.html tests — these pin the wiring the incident depends on, which
// no server test can see.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const applicants = await readFile(new URL("../applicants.html", import.meta.url), "utf8");

test("the counts banner is its own danger-styled element, separate from the stale one", () => {
  assert.match(applicants, /<div class="banner danger" id="countsBanner">/);
  assert.match(applicants, /Counts dropped sharply since the last snapshot/);
  assert.match(applicants, /\.banner\.danger \{ background:var\(--bad-bg\); color:var\(--bad\); \}/);
  // The stale banner keeps its own element and amber styling.
  assert.match(applicants, /<div class="banner" id="staleBanner">/);
});

test("the banner reads the feed's counts doc, not a locally derived number", () => {
  assert.match(applicants, /STATE\.counts = body\.counts \|\| null;/);
  assert.match(applicants, /const drops = STATE\.counts\?\.alert \|\| null;/);
});

test("the banner toggles before the no-snapshot early return", () => {
  // renderStats() bails early when there is no parseable generatedAt. The
  // tripwire must be evaluated ABOVE that return, or a snapshot-less feed
  // would silently swallow an active alert — the exact silence this exists
  // to end.
  const body = applicants.slice(applicants.indexOf("function renderStats()"));
  const toggle = body.indexOf('$("countsBanner").classList.add("on")');
  const earlyReturn = body.indexOf('$("updatedText").textContent = "No snapshot yet"');
  assert.ok(toggle > 0 && earlyReturn > 0, "both branches present");
  assert.ok(toggle < earlyReturn, "counts banner is toggled before the no-snapshot return");
});

test("the banner names the log to check and says the data still rendered", () => {
  assert.match(applicants, /~\/Library\/Logs\/raydar-interview-index\.log/);
  assert.match(applicants, /Everything below still renders the published snapshot/);
});

// ---- the partial-snapshot notice (2026-08-27) ----

test("a partial snapshot says so, and says the count is a floor", () => {
  assert.match(applicants, /STATE\.snapshot\?\.partial/);
  assert.match(applicants, /This count is INCOMPLETE/);
  assert.match(applicants, /the number is a floor, not a total/);
});

test("the partial notice is written AFTER the age branches, so age still colours the chip", () => {
  const body = applicants.slice(applicants.indexOf("function renderStats()"));
  const ageBranch = body.indexOf('$("updatedText").textContent += " · desktop asleep?"');
  const partial = body.indexOf('$("updatedText").textContent += " · partial"');
  assert.ok(ageBranch > 0 && partial > 0, "both branches present");
  assert.ok(partial > ageBranch,
    "partial must come after the age branches — an early return would swallow the red chip");
});
