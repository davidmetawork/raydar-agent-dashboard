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

test("No LinkedIn count and queue use the same missing-button predicate", () => {
  assert.match(applicants, /function hasNoLinkedin\(row\) \{\s*return !String\(row\.linkedin \|\| ""\)\.trim\(\);\s*\}/);
  assert.match(applicants, /const pendingNoLinkedin = pendingRows\(\)\.filter\(hasNoLinkedin\)\.length;/);
  assert.match(applicants, /if \(STATE\.chip === "no-linkedin"\) rows = rows\.filter\(hasNoLinkedin\);/);
  assert.doesNotMatch(applicants, /noLinkedinHistory/);
});
