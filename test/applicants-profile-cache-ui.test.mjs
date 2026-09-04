import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const applicants = readFileSync(resolve("applicants.html"), "utf8");

test("Applicants explains that uncached candidates are held off the page until ready", () => {
  assert.match(applicants, /STATE\.profileCache = body\.profileCache \|\| null/);
  assert.match(applicants, /still missing a readable source profile; they remain in Profile preparing until that source history is available/);
});
