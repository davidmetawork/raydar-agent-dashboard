import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const retiredHtml = await readFile(
  new URL("../paraai.html", import.meta.url),
  "utf8",
);
const submissionsHtml = await readFile(
  new URL("../submissions.html", import.meta.url),
  "utf8",
);

test("Submissions replaces the retired David-only curated-interest handoff UI", () => {
  assert.match(retiredHtml, /location\.replace\("\/#submissions"\)/);
  assert.doesNotMatch(retiredHtml, /id="interestHandoffs"|action=handoffs/);
  assert.match(submissionsHtml, /They asked for this person/);
  assert.match(submissionsHtml, /They said yes/);
  assert.match(submissionsHtml, /Replied, unread/);
  assert.match(submissionsHtml, /Blocked, and why/);
  assert.match(submissionsHtml, /Raydar sends nothing/);
  assert.match(submissionsHtml, /Review &amp; Submit · 1 credit/);
});
