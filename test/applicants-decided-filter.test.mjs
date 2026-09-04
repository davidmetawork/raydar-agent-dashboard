import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const applicants = await readFile(new URL("../applicants.html", import.meta.url), "utf8");

test("Decided exposes filters for every decision lifecycle outcome", () => {
  assert.match(applicants, /id="decisionFilter"[\s\S]*?<option value="all">All decisions<\/option>/);
  for (const [value, label] of [
    ["passed", "Passed"],
    ["queued", "Interview requested"],
    ["emailed", "Emailed"],
    ["blocked", "Blocked"],
  ]) {
    assert.match(applicants, new RegExp(`<option value="${value}">${label}<\\/option>`));
  }
  assert.match(applicants, /rows = rows\.filter\(\(row\) => decisionStatus\(row\.key, effectiveDecision\(row\.key\)\) === STATE\.decisionStatus\)/);
});

test("the outcome control only appears in Decided and reports live counts", () => {
  assert.match(applicants, /select\.hidden = !decidedMode/);
  assert.match(applicants, /select\.disabled = !decidedMode/);
  assert.match(applicants, /option\.textContent = label \+ " \(" \+ counts\[status\] \+ "\)"/);
});

test("embedded modal coordinates include the iframe's own scroll offset", () => {
  assert.match(
    applicants,
    /return \{ top: window\.scrollY \+ top, bottom: window\.scrollY \+ bottom \}/,
  );
  assert.doesNotMatch(applicants, /scheduleScan|pumpCards|pumpHydration/);
});
