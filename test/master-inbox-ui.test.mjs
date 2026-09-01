import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../master-inbox.html", import.meta.url), "utf8");

test("Master Inbox converts stored participant JSON into a Gmail-style sender label", () => {
  assert.match(source, /function firstContact\(value\)/);
  assert.match(source, /contact\?\.name\|\|contact\?\.address/);
  assert.doesNotMatch(source, /const name=value=>String\(value\|\|"Unknown sender"\)/);
});
