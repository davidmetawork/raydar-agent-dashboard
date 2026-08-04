import test from "node:test";
import assert from "node:assert/strict";

import { paraformCookieName as sequenceCookieName } from "../api/seq/_lib/core.mjs";
import {
  clearCookieCache,
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

// The transient-401 contract. Paraform 401s in bursts while the session is
// alive (measured 2026-08-04 — see the comment above AUTH_RETRY_LIMIT in
// api/paraai/_lib/core.mjs), so a read gives a 401 exactly one more chance
// and a mutation gives it none.
function withStubbedFetch(responses, run) {
  const realFetch = globalThis.fetch;
  const previousCookie = process.env.PARAFORM_SESSION_COOKIE;
  const previousName = process.env.PARAFORM_SESSION_COOKIE_NAME;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (typeof next === "function") return next();
    return {
      ok: next.status < 400,
      status: next.status,
      json: async () => next.body ?? null,
    };
  };
  process.env.PARAFORM_SESSION_COOKIE = "Fe26.2*test*seal";
  delete process.env.PARAFORM_SESSION_COOKIE_NAME;
  clearCookieCache();
  return Promise.resolve(run(calls)).finally(() => {
    globalThis.fetch = realFetch;
    if (previousCookie === undefined) delete process.env.PARAFORM_SESSION_COOKIE;
    else process.env.PARAFORM_SESSION_COOKIE = previousCookie;
    if (previousName === undefined) delete process.env.PARAFORM_SESSION_COOKIE_NAME;
    else process.env.PARAFORM_SESSION_COOKIE_NAME = previousName;
    clearCookieCache();
  });
}

const OK_BODY = { result: { data: { json: { ok: true } } } };

test("a transient Paraform 401 on a read is retried, not believed", async () => {
  await withStubbedFetch(
    [{ status: 401 }, { status: 200, body: OK_BODY }],
    async (calls) => {
      const data = await trpcGet("applicantInterest.getCuratedListRoleStatuses", {
        candidate_user_id: "test",
      });
      assert.deepEqual(data, { ok: true });
      assert.equal(calls.length, 2);
    },
  );
});

test("a sustained Paraform 401 on a read still fails fast as AUTH_EXPIRED", async () => {
  await withStubbedFetch([{ status: 401 }], async (calls) => {
    await assert.rejects(
      trpcGet("user.getCurrentUser", {}, 5),
      (error) => error.code === "AUTH_EXPIRED",
    );
    // One retry and no more, so a real outage cannot eat the worker's budget
    // by burning every caller's full `tries` budget on a dead cookie.
    assert.equal(calls.length, 2);
  });
});

test("a read 401 does not consume the retry budget reserved for other failures", async () => {
  await withStubbedFetch(
    [{ status: 401 }, { status: 500 }, { status: 200, body: OK_BODY }],
    async (calls) => {
      const data = await trpcGet("curatedRoleList.getCandidates", {});
      assert.deepEqual(data, { ok: true });
      assert.equal(calls.length, 3);
    },
  );
});

test("a Paraform 401 on a mutation is never retried", async () => {
  await withStubbedFetch([{ status: 401 }], async (calls) => {
    await assert.rejects(
      trpcPost("applicantInterest.declineCuratedListRole", {}, 3),
      (error) => error.code === "AUTH_EXPIRED",
    );
    assert.equal(calls.length, 1);
  });
});

test("a Paraform 401 on a REST read is retried once and a REST write never is", async () => {
  const previousCookie = process.env.PARAFORM_SESSION_COOKIE;
  const previousName = process.env.PARAFORM_SESSION_COOKIE_NAME;
  try {
    process.env.PARAFORM_SESSION_COOKIE = "Fe26.2*test*seal";
    delete process.env.PARAFORM_SESSION_COOKIE_NAME;
    clearCookieCache();

    let reads = 0;
    const body = await paraformRest("/api/application", {
      fetchImpl: async () => {
        reads += 1;
        return reads === 1
          ? { ok: false, status: 401, json: async () => null }
          : { ok: true, status: 200, json: async () => ({ ok: true }) };
      },
    });
    assert.deepEqual(body, { ok: true });
    assert.equal(reads, 2);

    let writes = 0;
    await assert.rejects(
      paraformRest("/api/application", {
        method: "POST",
        json: { single_submission: true },
        tries: 5,
        fetchImpl: async () => {
          writes += 1;
          return { ok: false, status: 401, json: async () => null };
        },
      }),
      (error) => error.code === "AUTH_EXPIRED",
    );
    assert.equal(writes, 1);
  } finally {
    if (previousCookie === undefined) delete process.env.PARAFORM_SESSION_COOKIE;
    else process.env.PARAFORM_SESSION_COOKIE = previousCookie;
    if (previousName === undefined) delete process.env.PARAFORM_SESSION_COOKIE_NAME;
    else process.env.PARAFORM_SESSION_COOKIE_NAME = previousName;
    clearCookieCache();
  }
});
