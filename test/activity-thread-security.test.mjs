import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Activity thread returns escaped plain text and does not expose raw provider HTML", async () => {
  const endpoint = await readFile(new URL("../api/activity/thread.mjs", import.meta.url), "utf8");
  const page = await readFile(new URL("../activity.html", import.meta.url), "utf8");
  assert.match(endpoint, /text: stripHtml\(it\.text\)/u);
  assert.doesNotMatch(endpoint, /\bhtml:\s*it\.text/u);
  assert.match(page, /<div class="bub">\$\{esc\(it\.text\)\}<\/div>/u);
  assert.doesNotMatch(page, /it\.html/u);
});
