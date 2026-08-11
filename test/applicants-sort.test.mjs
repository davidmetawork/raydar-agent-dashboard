import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const applicants = await readFile(new URL("../applicants.html", import.meta.url), "utf8");

test("Applicants exposes both application date sort directions", () => {
  assert.match(applicants, /id="sortOrder" aria-label="Sort by application date"/);
  assert.match(applicants, /<option value="newest">Newest to oldest<\/option>/);
  assert.match(applicants, /<option value="oldest">Oldest to newest<\/option>/);
  assert.match(applicants, /<option value="actioned" disabled>Most recently actioned<\/option>/);
});

test("Applicants defaults and persists the date sort preference", () => {
  assert.match(applicants, /const SORT_KEY = "apphub-sort-order-v1"/);
  assert.match(applicants, /sort: loadSortOrder\(\)/);
  assert.match(applicants, /localStorage\.setItem\(SORT_KEY, STATE\.sort\)/);
});

test("Review and Stream use application dates, while Decided uses newest action first", () => {
  assert.match(applicants, /if \(decidedMode\) rows = sortByDecisionDate\(decidedRows\(\)\)/);
  assert.match(applicants, /rows = sortByApplicationDate\(rows\)/);
  assert.match(applicants, /const rows = sortByApplicationDate\(streamRows\(\)\)/);
  assert.match(applicants, /if \(!aDate\) return 1;\s*if \(!bDate\) return -1;/);
  assert.match(applicants, /const aDate = parseDate\(effectiveDecision\(a\.key\)\?\.at\)/);
  assert.match(applicants, /const bDate = parseDate\(effectiveDecision\(b\.key\)\?\.at\)/);
  assert.match(applicants, /const byDate = bDate\.getTime\(\) - aDate\.getTime\(\)/);
});

test("Decided makes the action-recency ordering explicit in the sort control", () => {
  assert.match(applicants, /select\.disabled = decidedMode/);
  assert.match(applicants, /select\.value = decidedMode \? "actioned" : STATE\.sort/);
  assert.match(applicants, /decidedMode \? "Sorted by most recently actioned" : "Sort by application date"/);
});
