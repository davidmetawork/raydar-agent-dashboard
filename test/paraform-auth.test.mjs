import test from "node:test";
import assert from "node:assert/strict";

import { paraformCookieName as sequenceCookieName } from "../api/seq/_lib/core.mjs";
import {
  clearCookieCache,
  paraformThrottleDelays,
  paraformCookieName as paraAiCookieName,
  paraformRest,
  trpcGet,
  trpcPost,
} from "../api/paraai/_lib/core.mjs";

const HELPERS = [
  ["sequences", sequenceCookieName],
  ["Para AI", paraAiCookieName],
];

test("dashboard Paraform clients auto-detect WorkOS and legacy cookie names", () => {
  const previous = process.env.PARAFORM_SESSION_COOKIE_NAME;
  delete process.env.PARAFORM_SESSION_COOKIE_NAME;
  try {
    for (const [label, cookieName] of HELPERS) {
      assert.equal(cookieName("Fe26.2*test*seal"), "wos-session", label);
      assert.equal(cookieName("eyJlegacy-token"), "__Secure-next-auth.session-token", label);
      assert.match(`${cookieName("Fe26.2*test*seal")}=Fe26.2*test*seal`, /^wos-session=/u, label);
      assert.match(`${cookieName("eyJlegacy-token")}=eyJlegacy-token`, /^__Secure-next-auth\.session-token=/u, label);
    }
  } finally {
    if (previous === undefined) delete process.env.PARAFORM_SESSION_COOKIE_NAME;
    else process.env.PARAFORM_SESSION_COOKIE_NAME = previous;
  }
});

test("dashboard Paraform clients respect allowlisted overrides and reject unknown names", () => {
  const previous = process.env.PARAFORM_SESSION_COOKIE_NAME;
  try {
    process.env.PARAFORM_SESSION_COOKIE_NAME = " __Secure-next-auth.session-token ";
    for (const [label, cookieName] of HELPERS) {
      assert.equal(cookieName("Fe26.2*test*seal"), "__Secure-next-auth.session-token", label);
    }

    process.env.PARAFORM_SESSION_COOKIE_NAME = "third-party-session";
    for (const [label, cookieName] of HELPERS) {
      assert.throws(
        () => cookieName("eyJlegacy-token"),
        /PARAFORM_SESSION_COOKIE_NAME_INVALID/u,
        label,
      );
    }
  } finally {
    if (previous === undefined) delete process.env.PARAFORM_SESSION_COOKIE_NAME;
    else process.env.PARAFORM_SESSION_COOKIE_NAME = previous;
  }
});

test("Paraform REST adapter rejects foreign paths and never retries writes", async () => {
  await assert.rejects(
    paraformRest("https://example.com/api/application"),
    /PARAFORM_REST_PATH_INVALID/u,
  );
  const previousCookie = process.env.PARAFORM_SESSION_COOKIE;
  const previousName = process.env.PARAFORM_SESSION_COOKIE_NAME;
  let calls = 0;
  try {
    process.env.PARAFORM_SESSION_COOKIE = "Fe26.2*test*seal";
    delete process.env.PARAFORM_SESSION_COOKIE_NAME;
    clearCookieCache();
    await assert.rejects(
      paraformRest("/api/application", {
        method: "POST",
        json: { single_submission: true },
        tries: 5,
        fetchImpl: async (url, options) => {
          calls += 1;
          assert.equal(url.href, "https://www.paraform.com/api/application");
          assert.equal(options.method, "POST");
          assert.match(options.headers.cookie, /^wos-session=/u);
          throw new Error("timeout");
        },
      }),
      /timeout/u,
    );
    assert.equal(calls, 1);
  } finally {
    if (previousCookie === undefined) delete process.env.PARAFORM_SESSION_COOKIE;
    else process.env.PARAFORM_SESSION_COOKIE = previousCookie;
    if (previousName === undefined) delete process.env.PARAFORM_SESSION_COOKIE_NAME;
    else process.env.PARAFORM_SESSION_COOKIE_NAME = previousName;
    clearCookieCache();
  }
});

function response(status, body = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

async function withParaformFetch(script, run) {
  const previousFetch = globalThis.fetch;
  const previousCookie = process.env.PARAFORM_SESSION_COOKIE;
  const previousName = process.env.PARAFORM_SESSION_COOKIE_NAME;
  const previousDelays = process.env.PARAFORM_THROTTLE_DELAYS_MS;
  const previousProbeDelay = process.env.PARAFORM_PROBE_DELAY_MS;
  const calls = [];
  try {
    process.env.PARAFORM_SESSION_COOKIE = "Fe26.2*test*seal";
    delete process.env.PARAFORM_SESSION_COOKIE_NAME;
    process.env.PARAFORM_THROTTLE_DELAYS_MS = "0";
    process.env.PARAFORM_PROBE_DELAY_MS = "0";
    clearCookieCache();
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), options });
      const step = script[Math.min(calls.length - 1, script.length - 1)];
      return typeof step === "function" ? step(calls) : step;
    };
    return await run(calls);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousCookie === undefined) delete process.env.PARAFORM_SESSION_COOKIE;
    else process.env.PARAFORM_SESSION_COOKIE = previousCookie;
    if (previousName === undefined) delete process.env.PARAFORM_SESSION_COOKIE_NAME;
    else process.env.PARAFORM_SESSION_COOKIE_NAME = previousName;
    if (previousDelays === undefined) delete process.env.PARAFORM_THROTTLE_DELAYS_MS;
    else process.env.PARAFORM_THROTTLE_DELAYS_MS = previousDelays;
    if (previousProbeDelay === undefined) delete process.env.PARAFORM_PROBE_DELAY_MS;
    else process.env.PARAFORM_PROBE_DELAY_MS = previousProbeDelay;
    clearCookieCache();
  }
}

const OK_BODY = { result: { data: { json: { ok: true } } } };

test("an empty throttle override keeps the safe default ladder", () => {
  assert.deepEqual(paraformThrottleDelays(""), [600, 1800, 4500]);
  assert.deepEqual(paraformThrottleDelays("0, 5, nope"), [0, 5]);
});

test("a transient Paraform 401 on a read recovers without AUTH_EXPIRED", async () => {
  await withParaformFetch(
    [response(401), response(200, OK_BODY)],
    async (calls) => {
      assert.deepEqual(await trpcGet("user.getCurrentUser", {}, 1), { ok: true });
      assert.equal(calls.length, 2);
    },
  );
});

test("persistent 401s need a serial two-procedure confirmation before expiry", async () => {
  await withParaformFetch([response(401)], async (calls) => {
    await assert.rejects(
      trpcGet("user.getCurrentUser", {}, 1),
      (error) => error?.code === "AUTH_EXPIRED",
    );
    // Two caller observations (one zero-delay ladder retry), followed by
    // three serial rounds over two distinct confirmation procedures.
    assert.equal(calls.length, 8);
    assert.ok(calls.some((call) => call.url.includes("user.getCurrentUser")));
    assert.ok(calls.some((call) => call.url.includes("candidateUser.getCRMExternalCandidates")));
  });
});

test("an explicit mutation 401 may retry, while a transport failure never does", async () => {
  await withParaformFetch(
    [response(401), response(200, OK_BODY)],
    async (calls) => {
      assert.deepEqual(await trpcPost("matchDigest.createOrAddRoles", {}, 1), { ok: true });
      assert.equal(calls.length, 2);
    },
  );

  await withParaformFetch(
    [() => { throw new Error("timeout"); }],
    async (calls) => {
      await assert.rejects(
        trpcPost("matchDigest.createOrAddRoles", {}, 3),
        /timeout/u,
      );
      assert.equal(calls.length, 1);
    },
  );
});
