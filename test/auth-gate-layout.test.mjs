import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const pages = ["paraai.html", "sequences.html", "inbox.html", "enrich.html", "prep.html", "sourcing.html"];

test("every authenticated dashboard page pins its sign-in gate to the top", async () => {
  for (const page of pages) {
    const html = await readFile(new URL(`../${page}`, import.meta.url), "utf8");
    assert.match(html, /align-items:flex-start/, `${page} should top-align its auth gate`);
    assert.match(html, /padding:32px 20px 20px/, `${page} should use the shared auth-gate inset`);
  }
});
