import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const applicants = await readFile(new URL("../applicants.html", import.meta.url), "utf8");

test("No LinkedIn chip sits between Unrated and Decided", () => {
  assert.match(
    applicants,
    /data-chip="unrated"[\s\S]*data-chip="no-linkedin"[\s\S]*data-chip="decided"/,
  );
  assert.match(applicants, />No LinkedIn <span class="n" id="chipCountNoLinkedin">0<\/span>/);
});

test("No LinkedIn count and queue use the same missing-handle predicate", () => {
  assert.match(applicants, /function hasLinkedin\(row\) \{ return Boolean\(String\(row\.linkedin \|\| ""\)\.trim\(\)\); \}/);
  assert.match(applicants, /const pendingNoLinkedin = pendingRows\(\)\.filter\(\(r\) => !hasLinkedin\(r\)\)\.length;/);
  assert.match(applicants, /if \(STATE\.chip === "no-linkedin"\) rows = rows\.filter\(\(r\) => !hasLinkedin\(r\)\);/);
});
