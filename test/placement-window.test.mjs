import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("placement analytics migrates browsers to a six-month default", () => {
  assert.match(html, /const PF_WINDOW_PREF_KEY="pfWindowV2";/);
  assert.match(html, /let pfWin="6m";/);
  assert.match(html, /getItem\(PF_WINDOW_PREF_KEY\) \|\| "6m"/);
});

test("partial conversion history is explicit and still shows available counts", () => {
  assert.doesNotMatch(html, /building history/);
  assert.match(html, /<b>Not loading:<\/b>/);
  assert.match(html, /available since \$\{pfDay\(x\.since\)\} · ratio not yet measurable/);
});
