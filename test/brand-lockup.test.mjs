import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dashboard = await readFile(new URL("../index.html", import.meta.url), "utf8");

test("the Monitor rail uses the exact Raydar website lockup", () => {
  const brand = dashboard.match(/<a class="rail-brand"[\s\S]*?<\/a>/)?.[0] || "";

  assert.match(brand, /<svg width="142" height="36" viewBox="0 0 142 36"/);
  assert.match(brand, /role="img" aria-label="Raydar"/);
  assert.match(brand, /M60\.2548 26\.0939L56\.0046 19\.2366/);
  assert.match(brand, /M31\.2086 7\.48209C30\.7522 7\.93365/);
  assert.doesNotMatch(brand, /Agent Dashboard|class="word"|class="sub"/);
});
