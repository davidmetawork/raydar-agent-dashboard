import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../sequences.html", import.meta.url), "utf8");

test("Sequences UI reports default-off unmatched identities as parked", () => {
  assert.match(source, /identity parked/u);
  assert.match(source, /unmatched identities will be parked/u);
  assert.match(source, /no Paraform profile, enrollment, or email will be created/u);
  assert.doesNotMatch(source, /will be auto-created from their LinkedIn URL and enrolled/u);
  assert.doesNotMatch(source, /exceptional create grant/u);
  assert.doesNotMatch(source, /unmatchedCreateGranted/u);
});

test("Sequences confirmation warns that unmatched identities are parked", () => {
  assert.match(source, /Unmatched identities will be parked/u);
});
