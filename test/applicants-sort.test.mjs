import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const applicants = await readFile(new URL("../applicants.html", import.meta.url), "utf8");

test("Applicants exposes both application date sort directions", () => {
  assert.match(applicants, /id="sortOrder" aria-label="Sort by application date"/);
  assert.match(applicants, /<option value="newest">Newest to oldest<\/option>/);
  assert.match(applicants, /<option value="oldest">Oldest to newest<\/option>/);
});

test("Applicants defaults and persists the date sort preference", () => {
  assert.match(applicants, /const SORT_KEY = "apphub-sort-order-v1"/);
  assert.match(applicants, /sort: loadSortOrder\(\)/);
  assert.match(applicants, /localStorage\.setItem\(SORT_KEY, STATE\.sort\)/);
});

test("Review, Decided, and Stream use the shared application date ordering", () => {
  assert.match(applicants, /if \(decidedMode\) rows = sortByApplicationDate\(decidedRows\(\)\)/);
  assert.match(applicants, /rows = sortByApplicationDate\(rows\)/);
  assert.match(applicants, /const rows = sortByApplicationDate\(streamRows\(\)\)/);
  assert.match(applicants, /if \(!aDate\) return 1;\s*if \(!bDate\) return -1;/);
});
