// The daily-allowance tile. The load-bearing test is the suppression one:
// this is the only thing on the Health tab that calls Gmail on purpose, and
// the whole justification for allowing it is that it goes silent the instant a
// 429 witness is live. If that ever stops holding, the monitor becomes the
// thing that keeps the mailbox locked.
import assert from "node:assert/strict";
import test from "node:test";

import {
  lockoutFromSamples,
  pacificDay,
  pacificMidnightEpoch,
  summarize,
} from "../api/health/gmail-quota.mjs";
import { createHandler } from "../api/health/gmail-quota.mjs";

test("the Pacific day boundary survives the DST changeover", () => {
  // 2026-03-08 is the US spring-forward; 2026-11-01 the fall-back.
  for (const day of ["2026-03-08", "2026-08-21", "2026-11-01", "2026-12-25"]) {
    const epoch = pacificMidnightEpoch(day);
    assert.equal(pacificDay(epoch * 1000), day, `${day} midnight resolves to itself`);
    assert.notEqual(pacificDay(epoch * 1000 - 1000), day, `${day} minus a second is the day before`);
  }
});

test("lockout minutes count DEGRADED and DOWN, and blindness separately", () => {
  const now = Date.parse("2026-08-21T20:00:00Z");
  const startMinute = Math.floor(pacificMidnightEpoch(pacificDay(now), now) / 60);
  const samples = [
    { t: startMinute - 10, s: "D" },   // yesterday — must not count
    { t: startMinute + 2, s: "O" },
    { t: startMinute + 4, s: "D" },
    { t: startMinute + 6, s: "D" },
    { t: startMinute + 8, s: "U" },
  ];
  const out = lockoutFromSamples(samples, { now });
  assert.equal(out.lockedMinutes, 4);   // two samples x 2 min
  assert.equal(out.blindMinutes, 2);
  assert.equal(out.samples, 4);
});

test("no samples means null, never a confident zero", () => {
  const out = lockoutFromSamples(null, { now: Date.now() });
  assert.equal(out.lockedMinutes, null);
  assert.equal(out.blindMinutes, null);
});

test("summarize reports pct against the cap and never invents a count", () => {
  const full = summarize(
    { day: "2026-08-21", sends: 235, exact: true, checkedAt: "2026-08-21T20:00:00Z", four29: 0 },
    { lockedMinutes: 0, blindMinutes: 0, samples: 400 },
  );
  assert.equal(full.sends, 235);
  assert.equal(full.cap, 2000);
  assert.equal(full.pct, 11.8);

  const empty = summarize({ day: "2026-08-21", sends: null, four29: 0 }, { lockedMinutes: null });
  assert.equal(empty.sends, null, "not counted yet is null, never a confident zero");
  assert.equal(empty.pct, null);
});

test("a suppressed probe keeps the last real count rather than reverting to unknown", () => {
  const raw = summarize(
    { day: "d", sends: 190, exact: true, suppressed: true, suppressedReason: "GMAIL_429", four29: 1 },
    { lockedMinutes: 10 },
  );
  assert.equal(raw.sends, 190, "a stale-but-real number beats null against a hard cap");
  assert.equal(raw.suppressed, true);
  assert.equal(raw.four29Today, 1);
});

test("a partial count is flagged rather than reported as the whole truth", () => {
  const raw = summarize({ day: "d", sends: 2500, exact: false, four29: 0 }, { lockedMinutes: 0 });
  assert.equal(raw.exact, false);
});

// cronAuth returns an object; `if (cronAuth(req))` is always truthy and would
// leave this endpoint open to anyone. That bug shipped once in the n8n
// watchdog, and it is cheap to make it impossible to ship again.
test("an unauthenticated caller is refused, header alone is not enough", async () => {
  const prevCron = process.env.CRON_SECRET;
  const prevBeat = process.env.HEALTH_BEAT_KEY;
  process.env.CRON_SECRET = "cron-secret";
  process.env.HEALTH_BEAT_KEY = "beat-secret";
  const handler = createHandler({
    fetchImpl: async () => { throw new Error("must not reach Gmail"); },
    tokenImpl: async () => { throw new Error("must not mint a token"); },
  });
  const call = async (headers) => {
    let code = null; let body = null;
    const res = {
      setHeader() {},
      status(c) { code = c; return this; },
      json(b) { body = b; return this; },
    };
    await handler({ method: "GET", headers }, res);
    return { code, body };
  };

  assert.equal((await call({})).code, 401, "no credentials");
  assert.equal((await call({ "x-vercel-cron": "1" })).code, 401, "the cron header alone proves nothing");
  assert.equal((await call({ authorization: "Bearer wrong" })).code, 401, "a wrong bearer");

  process.env.CRON_SECRET = prevCron;
  process.env.HEALTH_BEAT_KEY = prevBeat;
});
