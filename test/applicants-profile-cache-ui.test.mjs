import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const applicants = readFileSync(resolve("applicants.html"), "utf8");

test("Applicants explains that uncached candidates are held off the page until ready", () => {
  assert.match(applicants, /STATE\.profileCache = body\.profileCache \|\| null/);
  assert.match(applicants, /safely held off Review and Stream until their cached Paraform history is ready/);
});
