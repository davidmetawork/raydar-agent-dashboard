import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  claimSubmissionRequest,
  readSubmissionRequestClaim,
  claimKey,
  legacyReplyClaimKey,
} from "../api/paraai/_lib/request-claim.mjs";

// A tiny in-memory Redis good enough for SET NX / GET semantics.
function fakeKv(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    data,
    impl: async (args) => {
      const [command, key, value, ...rest] = args;
      if (command === "GET") return data.has(key) ? data.get(key) : null;
      if (command === "SET") {
        if (rest.includes("NX") && data.has(key)) return null;
        data.set(key, value);
        return "OK";
      }
      throw new Error(`unexpected command ${command}`);
    },
  };
}

test("the two lanes share one claim, so only one of them can ever act", async () => {
  const kv = fakeKv();
  const first = await claimSubmissionRequest("req-1", "pass", "reply", { kvImpl: kv.impl });
  assert.equal(first, true);

  // The expired lane arrives second on the same request and is refused.
  const second = await claimSubmissionRequest("req-1", "expired_dismiss", "expired", { kvImpl: kv.impl });
  assert.equal(second, false, "a second lane must never win a claim the first already holds");

  const held = await readSubmissionRequestClaim("req-1", { kvImpl: kv.impl });
  assert.equal(held.action, "pass");
  assert.equal(held.lane, "reply");
  assert.equal(held.namespace, "request-claim");
});

test("the winner is whoever arrives first, in either direction", async () => {
  const kv = fakeKv();
  assert.equal(await claimSubmissionRequest("req-2", "expired_dismiss", "expired", { kvImpl: kv.impl }), true);
  assert.equal(await claimSubmissionRequest("req-2", "submit", "reply", { kvImpl: kv.impl }), false);
});

// Claims written before the neutral namespace existed are real and already in
// production; ignoring them would let the expired lane act on a request the
// reply lane already dismissed.
test("a legacy reply-lane claim still blocks the expired lane", async () => {
  const kv = fakeKv({
    [legacyReplyClaimKey("req-3")]: JSON.stringify({ action: "pass", claimedAt: "2026-07-28T00:00:00.000Z" }),
  });
  assert.equal(await claimSubmissionRequest("req-3", "expired_dismiss", "expired", { kvImpl: kv.impl }), false);

  const held = await readSubmissionRequestClaim("req-3", { kvImpl: kv.impl });
  assert.equal(held.action, "pass");
  assert.equal(held.namespace, "reply-claim");
});

test("claims are never written under the legacy key again", async () => {
  const kv = fakeKv();
  await claimSubmissionRequest("req-4", "expired_dismiss", "expired", { kvImpl: kv.impl });
  assert.ok(kv.data.has(claimKey("req-4")));
  assert.ok(!kv.data.has(legacyReplyClaimKey("req-4")), "the legacy namespace is read-only now");
});

test("claim keys never carry the request id in the clear", () => {
  const key = claimKey("req-secret-id");
  assert.ok(!key.includes("req-secret-id"));
  assert.match(key, /^paraai:request-claim:[a-f0-9]{64}$/);
  // The legacy derivation must reproduce the reply store's salt exactly, or it
  // would read a key that does not exist and report a claimed request as free.
  assert.match(legacyReplyClaimKey("req-secret-id"), /^paraai:reply:claim:[a-f0-9]{64}$/);
});

// The reply store's own claim helpers must now route to the shared namespace,
// otherwise the two lanes silently drift back into separate keyspaces.
test("the reply store delegates its claim to the shared namespace", () => {
  const source = readFileSync(
    new URL("../api/paraai/_lib/reply-store.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /import \{ claimSubmissionRequest, readSubmissionRequestClaim \} from "\.\/request-claim\.mjs"/);
  assert.match(source, /claimRequestAction[\s\S]{0,200}claimSubmissionRequest\(requestId, action, "reply"/);
  // A prose mention of the legacy key is fine; deriving one is not.
  assert.ok(
    !/paraai:reply:claim:\$\{/.test(source),
    "reply-store must no longer derive the legacy claim key itself",
  );
});
