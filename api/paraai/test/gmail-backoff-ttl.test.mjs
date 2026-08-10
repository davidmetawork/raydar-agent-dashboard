import test from "node:test";
import assert from "node:assert/strict";
const { gmailBackoffTtlSeconds, armGmailBackoff } =
  await import("../_lib/outreach-store.mjs");

test("TTL always exceeds Google's 15-minute penalty window", () => {
  for (let i = 0; i <= 100; i += 1) {
    const ttl = gmailBackoffTtlSeconds(() => i / 100);
    assert.ok(ttl > 15 * 60, `ttl ${ttl}s must exceed 900s`);
    assert.ok(ttl <= 23 * 60, `ttl ${ttl}s should stay bounded`);
  }
});

test("jitter actually varies so lanes cannot resynchronise", () => {
  const lo = gmailBackoffTtlSeconds(() => 0);
  const hi = gmailBackoffTtlSeconds(() => 0.999);
  assert.notEqual(lo, hi);
  assert.equal(lo, 1200);
});

test("armGmailBackoff writes an expiry past the penalty window", async () => {
  const calls = [];
  const until = await armGmailBackoff({ kvImpl: async (c) => { calls.push(c); return "OK"; } });
  const ms = Date.parse(until) - Date.now();
  assert.ok(ms > 15 * 60 * 1000, "banked deadline must outlast the penalty");
  assert.equal(calls[0][0], "SET");
  assert.ok(Number(calls[0][4]) > 900, "KV EX must outlast the penalty");
});
