import test from "node:test";
import assert from "node:assert/strict";

import { paraformCookieName as sequenceCookieName } from "../api/seq/_lib/core.mjs";
import {
  clearCookieCache,
  paraformCookieName as paraAiCookieName,
  paraformRest,
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
