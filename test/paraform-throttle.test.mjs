// Paraform answers 401 to a burst, and to role-forbidden procedures, as well as
// to a dead session. Collapsing those into "the cookie expired" closed Agent
// Call admission twice on 2026-08-04 — both times on a session that answered
// three clean serial 200s. These tests pin the distinction.
import test from "node:test";
import assert from "node:assert/strict";

import {
  isSessionActuallyExpired,
  trpcGet,
  trpcPost,
  withThrottleRetry,
} from "../api/seq/_lib/core.mjs";

function withStubbedParaform(handler, run) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = handler;
  return (async () => {
    try { return await run(); } finally { globalThis.fetch = realFetch; }
  })();
}

const ok = (json = { ok: true }) => ({
  status: 200,
  ok: true,
  json: async () => ({ result: { data: { json } } }),
});
const unauthorized = () => ({ status: 401, ok: false, json: async () => ({}) });

test("a throttle that clears is never reported as an expiry", async () => {
  let calls = 0;
  await withStubbedParaform(
    async () => (++calls <= 2 ? unauthorized() : ok({ id: "u1" })),
    async () => {
      assert.deepEqual(await trpcGet("campaigns.getListOfCampaigns", {}, 1), { id: "u1" });
      assert.ok(calls >= 3, "the 401s were retried rather than believed");
    },
  );
});

test("a sustained throttle on a live session surfaces as PARAFORM_THROTTLED", async () => {
  // Every real call 401s while the serial probe succeeds — the exact burst
  // signature that produced both of today's outages.
  let probes = 0;
  await withStubbedParaform(
    async (url) => {
      if (String(url).includes("getListOfCampaignsOptimized")) { probes += 1; return ok({ id: "alive" }); }
      return unauthorized();
    },
    async () => {
      await assert.rejects(
        () => trpcGet("campaigns.getCampaignLeads", {}, 1),
        (e) => e.code === "PARAFORM_THROTTLED",
      );
      assert.equal(probes, 1, "one clean serial probe clears the session");
    },
  );
});

test("a genuinely dead session is still reported as AUTH_EXPIRED", async () => {
  await withStubbedParaform(
    async () => unauthorized(), // nothing succeeds, probes included
    async () => {
      await assert.rejects(
        () => trpcGet("campaigns.getCampaignLeads", {}, 1),
        (e) => e.code === "AUTH_EXPIRED",
      );
    },
  );
});

test("the serial probe does not recurse through the classifier", async () => {
  // isSessionActuallyExpired is what the classifier calls to decide. If it went
  // back through trpcGet it would re-enter the ladder and never terminate.
  // A bounded number of fetches proves it used the raw path.
  let fetches = 0;
  await withStubbedParaform(
    async () => { fetches += 1; return unauthorized(); },
    async () => {
      assert.equal(await isSessionActuallyExpired({ probes: 3 }), true);
      assert.equal(fetches, 3, "exactly one fetch per probe, no re-entry");
    },
  );
});

test("a confirmed expiry is not re-laddered by withThrottleRetry", async () => {
  // The classifier already rode the ladder and confirmed. Retrying here would
  // multiply the delays and burn the caller's deadline for nothing.
  let attempts = 0;
  await withStubbedParaform(
    async () => { attempts += 1; return unauthorized(); },
    async () => {
      const before = attempts;
      await assert.rejects(
        () => withThrottleRetry(() => trpcGet("campaigns.getCampaignLeads", {}, 1)),
        (e) => e.code === "AUTH_EXPIRED",
      );
      // One ladder's worth of calls, not two nested ladders' worth.
      assert.ok(attempts - before < 40, `expected a single ladder, saw ${attempts - before} calls`);
    },
  );
});

test("a mutation refused by a throttle is retried, because a 401 never applied it", async () => {
  let attempts = 0;
  await withStubbedParaform(
    async () => (++attempts === 1 ? unauthorized() : ok({ enrolled: true })),
    async () => {
      assert.deepEqual(await trpcPost("campaigns.addToCampaigns", {}, 1), { enrolled: true });
      assert.equal(attempts, 2);
    },
  );
});
