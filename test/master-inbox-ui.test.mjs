import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../master-inbox.html", import.meta.url), "utf8");

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
