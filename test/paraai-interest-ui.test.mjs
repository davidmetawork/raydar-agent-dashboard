import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(
  new URL("../paraai.html", import.meta.url),
  "utf8",
);

test("Para AI UI exposes a David-only curated-interest handoff queue", () => {
  assert.match(html, /id="interestHandoffs"/);
  assert.match(html, /action=handoffs/);
  assert.match(html, /This dashboard cannot submit on your behalf/);
  assert.match(html, /Open in Paraform/);
  assert.match(html, /confirmation:"RESOLVE "\+candidateUserId/);
});
