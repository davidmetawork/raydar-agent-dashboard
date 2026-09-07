import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Vercel applies baseline HTTPS and response hardening headers without broad CSP changes", async () => {
  const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  const global = config.headers.find((entry) => entry.source === "/(.*)");
  assert.ok(global);
  const headers = Object.fromEntries(global.headers.map((entry) => [entry.key.toLowerCase(), entry.value]));
  assert.equal(headers["strict-transport-security"], "max-age=31536000");
  assert.equal(headers["x-content-type-options"], "nosniff");
  assert.equal(headers["referrer-policy"], "strict-origin-when-cross-origin");
  assert.doesNotMatch(headers["strict-transport-security"], /includeSubDomains|preload/iu);
  assert.equal(headers["content-security-policy"], undefined);
});
