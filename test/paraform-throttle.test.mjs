// Paraform answers 401 to a burst, and to role-forbidden procedures, as well as
// to a dead session. Collapsing those into "the cookie expired" closed Agent
// Call admission twice on 2026-08-04 — both times on a session that answered
// three clean serial 200s. These tests pin the distinction.
import test from "node:test";
import assert from "node:assert/strict";

import {
  archiveImportSet,
  crmProjectMembers,
  ensureParaformSession,
  isSessionActuallyExpired,
  paraformCookieValue,
  trpcGet,
  trpcPost,
  withThrottleRetry,
  __resetSessionExpiryChecksForTests,
} from "../api/seq/_lib/core.mjs";
import {
  notifyParaformSessionRejected,
  __resetParaformSessionStateForTests,
} from "../api/_lib/paraform-session-store.mjs";

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

// ─── A 401 must not move the process off a live store session ────────────────
// Measured hazard, 2026-09-28: every 401 parked the store slot and cleared the
// cache, so after one burst-throttle 401 the rest of the request (retries and
// the serial expiry probes) sent the static env seal, which WorkOS had rotated
// away hours earlier, and ended in a false AUTH_EXPIRED. These tests run the
// production shape: a live store session resolved, a dead env seal underneath.

const SHARED = `Fe26.2${"s".repeat(70)}`;
const ACCOUNT = `Fe26.2${"a".repeat(70)}`;
const ENV_SEAL = `Fe26.2${"e".repeat(70)}`;
const N8N = "https://n8n.example.test";
const STORE_ROWS = [
  { key: "PARAFORM_SESSION_COOKIE_G1_1", value: SHARED },
  { key: "PARAFORM_SESSION_COOKIE_G1_PARTS", value: "1" },
  { key: "PARAFORM_DAVID_SESSION_G1_1", value: ACCOUNT },
  { key: "PARAFORM_DAVID_SESSION_G1_PARTS", value: "1" },
];

const sentCookie = (init) => String(init?.headers?.cookie || "").replace(/^[^=]+=/u, "");
const isProbe = (url) => String(url).includes("getListOfCampaignsOptimized");

async function withStoreSession(run) {
  const env = {
    N8N_BASE_URL: N8N,
    N8N_API_KEY: "test-n8n-key",
    PARAFORM_SESSION_COOKIE: ENV_SEAL,
    PARAFORM_THROTTLE_DELAYS_MS: "0,0,0",
    PARAFORM_PROBE_DELAY_MS: "0",
  };
  const saved = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    process.env[key] = env[key];
  }
  let storeReads = 0;
  const storeFetch = async (url) => {
    storeReads += 1;
    assert.match(String(url), /^https:\/\/n8n\.example\.test\/api\/v1\/variables/u);
    return { ok: true, json: async () => ({ data: STORE_ROWS }) };
  };
  __resetParaformSessionStateForTests();
  __resetSessionExpiryChecksForTests();
  try {
    const resolved = await ensureParaformSession({ fetchImpl: storeFetch });
    assert.equal(resolved.slot, "shared");
    return await run({ storeFetch, storeReads: () => storeReads });
  } finally {
    for (const key of Object.keys(env)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    __resetParaformSessionStateForTests();
    __resetSessionExpiryChecksForTests();
  }
}

test("a throttle 401 keeps the store session: the retry sends the same cookie and nothing is parked", async () => {
  await withStoreSession(async ({ storeFetch, storeReads }) => {
    const seen = [];
    await withStubbedParaform(
      async (url, init) => {
        seen.push(sentCookie(init));
        return seen.length === 1 ? unauthorized() : ok({ id: "u1" });
      },
      async () => {
        assert.deepEqual(await trpcGet("campaigns.getCampaignLeads", {}, 1), { id: "u1" });
      },
    );
    assert.deepEqual(seen, [SHARED, SHARED], "the retry never fell back to the env seal");
    assert.equal(paraformCookieValue(), SHARED);
    const next = await ensureParaformSession({ fetchImpl: storeFetch });
    assert.equal(next.cached, true, "a throttle must not invalidate the cache");
    assert.equal(next.slot, "shared", "a throttle must not park the slot");
    assert.equal(storeReads(), 1);
  });
});

test("a sustained throttle on a live store session stays PARAFORM_THROTTLED and never sends the env seal", async () => {
  await withStoreSession(async ({ storeFetch }) => {
    const seen = [];
    await withStubbedParaform(
      async (url, init) => {
        seen.push(sentCookie(init));
        return isProbe(url) ? ok([]) : unauthorized();
      },
      async () => {
        await assert.rejects(
          () => trpcGet("campaigns.getCampaignLeads", {}, 1),
          (e) => e.code === "PARAFORM_THROTTLED",
        );
      },
    );
    assert.ok(seen.length >= 5, "the ladder ran and then the probe");
    assert.ok(seen.every((cookie) => cookie === SHARED), "every attempt and the probe used the store cookie");
    const next = await ensureParaformSession({ fetchImpl: storeFetch });
    assert.equal(next.slot, "shared");
    assert.equal(next.cached, true);
  });
});

test("a dead store session is parked only after probes of that same cookie confirm it", async () => {
  await withStoreSession(async ({ storeFetch }) => {
    const seen = [];
    await withStubbedParaform(
      async (url, init) => {
        seen.push({ probe: isProbe(url), cookie: sentCookie(init) });
        return unauthorized();
      },
      async () => {
        await assert.rejects(
          () => trpcGet("campaigns.getCampaignLeads", {}, 1),
          (e) => e.code === "AUTH_EXPIRED",
        );
      },
    );
    assert.equal(seen.filter((row) => !row.probe).length, 4, "one attempt plus three ladder retries");
    assert.equal(seen.filter((row) => row.probe).length, 3, "three serial probes");
    assert.ok(seen.every((row) => row.cookie === SHARED), "the probes tested the cookie that got the 401");
    const next = await ensureParaformSession({ fetchImpl: storeFetch });
    assert.equal(next.slot, "account", "the confirmed-dead shared slot is parked");
  });
});

test("a retry moves to a session another request re-resolved, instead of staying on a parked cookie", async () => {
  await withStoreSession(async ({ storeFetch }) => {
    const seen = [];
    await withStubbedParaform(
      async (url, init) => {
        seen.push(sentCookie(init));
        if (seen.length === 1) {
          // Another request confirms the shared cookie dead and the process
          // resolves the account slot while this call waits to retry.
          assert.equal(notifyParaformSessionRejected({ cookie: SHARED }), true);
          assert.equal((await ensureParaformSession({ fetchImpl: storeFetch })).slot, "account");
        }
        return sentCookie(init) === ACCOUNT ? ok({ id: "u1" }) : unauthorized();
      },
      async () => {
        assert.deepEqual(await trpcGet("campaigns.getCampaignLeads", {}, 1), { id: "u1" });
      },
    );
    assert.deepEqual(seen, [SHARED, ACCOUNT]);
    assert.equal(paraformCookieValue(), ACCOUNT);
  });
});

test("a cold instance whose store read outran its budget retries on the store session once it lands", async () => {
  await withStoreSession(async () => {
    // Fresh process: nothing resolved, and the store answers only after the
    // caller's budget (health gives it 3s) ran out.
    __resetParaformSessionStateForTests();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const slowStore = async () => {
      await gate;
      return { ok: true, json: async () => ({ data: STORE_ROWS }) };
    };
    const quick = await ensureParaformSession({ fetchImpl: slowStore, timeoutMs: 1 });
    assert.equal(quick.timedOut, true);
    const seen = [];
    await withStubbedParaform(
      async (url, init) => {
        seen.push(sentCookie(init));
        if (seen.length === 1) release(); // the background store read lands
        return sentCookie(init) === ENV_SEAL ? unauthorized() : ok({ id: "u1" });
      },
      async () => {
        assert.deepEqual(await trpcGet("campaigns.getListOfCampaignsOptimized", {}), { id: "u1" });
      },
    );
    assert.deepEqual(seen, [ENV_SEAL, SHARED], "the dead env seal is not pinned for the whole ladder");
  });
});

test("after a park empties the cache, a retry does not move onto the env fallback", async () => {
  await withStoreSession(async () => {
    const seen = [];
    await withStubbedParaform(
      async (url, init) => {
        seen.push({ probe: isProbe(url), cookie: sentCookie(init) });
        if (seen.length === 1) assert.equal(notifyParaformSessionRejected({ cookie: SHARED }), true);
        return unauthorized();
      },
      async () => {
        await assert.rejects(
          () => trpcGet("campaigns.getCampaignLeads", {}, 1),
          (e) => e.code === "AUTH_EXPIRED",
        );
      },
    );
    assert.ok(seen.every((row) => row.cookie === SHARED), "never the env seal");
  });
});

test("a verdict on a cookie the process already left does not park the new session", async () => {
  await withStoreSession(async ({ storeFetch }) => {
    let moved = false;
    await withStubbedParaform(
      async (url, init) => {
        if (isProbe(url) && !moved) {
          // The move happens after this call's last retry, during its probes.
          moved = true;
          assert.equal(notifyParaformSessionRejected({ cookie: SHARED }), true);
          assert.equal((await ensureParaformSession({ fetchImpl: storeFetch })).slot, "account");
        }
        return sentCookie(init) === ACCOUNT ? ok([]) : unauthorized();
      },
      async () => {
        await assert.rejects(
          () => trpcGet("campaigns.getCampaignLeads", {}, 1),
          (e) => e.code === "AUTH_EXPIRED",
          "this call's probes tested the dead shared cookie",
        );
      },
    );
    assert.equal(paraformCookieValue(), ACCOUNT, "the live account session was not parked by the stale verdict");
    const next = await ensureParaformSession({ fetchImpl: storeFetch });
    assert.equal(next.cached, true);
    assert.equal(next.slot, "account");
  });
});

test("a raw CRM page 401 on a live session is PARAFORM_THROTTLED, not a parked slot", async () => {
  await withStoreSession(async ({ storeFetch }) => {
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push(sentCookie(init));
      if (isProbe(url)) return ok([]);
      return unauthorized();
    };
    await assert.rejects(
      () => crmProjectMembers("project-1", { fetchImpl }),
      (e) => e.code === "PARAFORM_THROTTLED",
    );
    assert.deepEqual(seen, [SHARED, SHARED], "the page read, then one probe of the same cookie");
    const next = await ensureParaformSession({ fetchImpl: storeFetch });
    assert.equal(next.slot, "shared");
    assert.equal(next.cached, true);
  });
});

test("concurrent profile 401s on a dead session share one probe run, then park the slot once", async () => {
  await withStoreSession(async ({ storeFetch }) => {
    let probes = 0;
    const cookies = new Set();
    const fetchImpl = async (url, init) => {
      cookies.add(sentCookie(init));
      if (isProbe(url)) probes += 1;
      return unauthorized();
    };
    await assert.rejects(
      () => archiveImportSet(["c1", "c2", "c3", "c4", "c5"], { fetchImpl }),
      (e) => e.code === "AUTH_EXPIRED",
    );
    assert.equal(probes, 6, "five workers' 401s cost one run: three ladder-step probes, then three serial probes");
    assert.deepEqual([...cookies], [SHARED]);
    const next = await ensureParaformSession({ fetchImpl: storeFetch });
    assert.equal(next.slot, "account");
  });
});
