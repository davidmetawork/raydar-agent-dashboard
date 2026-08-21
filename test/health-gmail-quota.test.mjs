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
import { gmailQuotaDavid } from "../api/health/_lib/evaluators.mjs";

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

test("a healthy day reads OK and carries the count", () => {
  const raw = summarize(
    { day: "2026-08-21", sends: 235, exact: true, checkedAt: "2026-08-21T20:00:00Z", four29: 0 },
    { lockedMinutes: 0, blindMinutes: 0, samples: 400 },
  );
  const verdict = gmailQuotaDavid({ raw });
  assert.equal(verdict.state, "OK");
  assert.match(verdict.reason, /235\/2000/u);
  assert.equal(verdict.metrics.pct, 11.8);
});

test("80% of the send cap is DEGRADED, and the cap itself is DOWN", () => {
  const at80 = gmailQuotaDavid({
    raw: summarize({ day: "d", sends: 1600, exact: true, four29: 0 }, { lockedMinutes: 0 }),
  });
  assert.equal(at80.state, "DEGRADED");
  const atCap = gmailQuotaDavid({
    raw: summarize({ day: "d", sends: 2000, exact: true, four29: 0 }, { lockedMinutes: 0 }),
  });
  assert.equal(atCap.state, "DOWN");
  assert.match(atCap.reason, /refusing mail/u);
});

test("an hour of lockout is DEGRADED even when sends look calm", () => {
  const verdict = gmailQuotaDavid({
    raw: summarize({ day: "d", sends: 12, exact: true, four29: 3 }, { lockedMinutes: 96 }),
  });
  assert.equal(verdict.state, "DEGRADED");
  assert.match(verdict.reason, /96 min/u);
  assert.equal(verdict.metrics.four29Today, 3);
});

test("an unreadable endpoint is UNKNOWN, never OK", () => {
  assert.equal(gmailQuotaDavid({ raw: null }).state, "UNKNOWN");
  assert.equal(gmailQuotaDavid({ raw: { ok: false } }).state, "UNKNOWN");
});

test("a suppressed probe keeps the last real count rather than reverting to unknown", () => {
  const raw = summarize(
    { day: "d", sends: 190, exact: true, suppressed: true, suppressedReason: "GMAIL_429", four29: 1 },
    { lockedMinutes: 10 },
  );
  assert.equal(raw.sends, 190, "a stale-but-real number beats null against a hard cap");
  const verdict = gmailQuotaDavid({ raw });
  assert.equal(verdict.state, "DEGRADED");
  assert.match(verdict.reason, /GMAIL_429/u);
});

test("a partial count is flagged rather than reported as the whole truth", () => {
  const raw = summarize({ day: "d", sends: 2500, exact: false, four29: 0 }, { lockedMinutes: 0 });
  assert.equal(raw.exact, false);
  const verdict = gmailQuotaDavid({ raw });
  assert.equal(verdict.state, "DOWN"); // 2500 is past the cap either way
});
