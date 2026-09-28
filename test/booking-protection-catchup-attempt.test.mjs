// The daily catch-up's attempt record (2026-09-28 gap): /api/seq/health reads
// seqguard:lite:catchup:attempt:v1 as bookingProtectionLite.catchup, but
// nothing wrote it, so the block was always null. The catch-up now writes it
// when a run starts and when it ends. These tests run against a fake KV
// REST endpoint, so what the catch-up writes is exactly what health reads.
const ENV = {
  KV_REST_API_URL: "https://kv.example.test",
  KV_REST_API_TOKEN: "test-kv-token",
};
const ENV_NAMES = [
  ...Object.keys(ENV),
  "CRON_SECRET",
  "N8N_BASE_URL",
  "N8N_API_KEY",
  "PARAFORM_COOKIE",
  "PARAFORM_SESSION_COOKIE",
  "PARAFORM_SESSION_ACCOUNT",
  "SLACK_BOT_TOKEN",
  "SLACK_WEBHOOK_URL",
];
const SAVED_ENV = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
for (const name of ENV_NAMES) delete process.env[name];
Object.assign(process.env, ENV);

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const {
  runCatchup,
  catchupAttemptStatus,
  BOOKTIME_START_BUDGET_MS,
  config: catchupConfig,
} = await import("../api/seq/booking-catchup.mjs");
const { default: healthHandler } = await import("../api/seq/health.mjs");
const { LITE_KEYS } = await import("../api/seq/_lib/booking-protection-store.mjs");
const {
  config: refreshConfig,
  default: refreshHandler,
} = await import("../api/seq/booking-liveset-refresh.mjs");
const { config: workerConfig } = await import("../api/seq/booking-worker.mjs");

test.after(() => {
  for (const [name, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

// A fake Upstash REST store: GET/SET only, everything else answers null.
// Anything that is not the KV endpoint (Paraform, Slack) is refused, so a
// test fails loudly rather than reaching the network.
function withFakeKv(run) {
  const store = new Map();
  const writes = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    if (!String(url).startsWith(ENV.KV_REST_API_URL)) {
      return new Response(null, { status: 503 });
    }
    const [command, key, value, ...rest] = JSON.parse(init.body);
    if (command === "SET") {
      store.set(key, value);
      writes.push({ key, value: JSON.parse(value), rest });
      return Response.json({ result: "OK" });
    }
    if (command === "GET") return Response.json({ result: store.get(key) ?? null });
    return Response.json({ result: null });
  };
  return Promise.resolve(run({ store, writes })).finally(() => {
    global.fetch = originalFetch;
  });
}

function response() {
  return {
    body: undefined,
    headers: {},
    statusCode: undefined,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
    end() {},
  };
}

const READY_INDEXES = {
  liveSetReady: true,
  raydar: { checked: 3, matched: 1, paused: 1, pauseErrors: [] },
  calendly: { checked: 2, matched: 0, paused: 0, pauseErrors: [] },
  raydarError: null,
  calendlyError: null,
};

const BOOKTIME_DONE = {
  reads: 9, checked: 9, matched: 0, paused: 0, pauseErrors: [], readErrors: 0,
  passedRefused: 0, rows: 400, cursor: 129, stoppedBy: "deadline", stopReason: null,
};

test("the catch-up writes the attempt key health reads, first as started and then with the outcome", async () => {
  await withFakeKv(async ({ writes }) => {
    let clockMs = Date.parse("2026-09-29T05:40:00.000Z");
    const statusesSeenByBookTime = [];
    const out = await runCatchup({
      startedAt: clockMs,
      clock: () => clockMs,
      pace: async (fn) => fn(),
      catchUp: async () => READY_INDEXES,
      bookTime: async () => {
        // While the run is in progress, health already shows it started.
        const res = response();
        await healthHandler({ method: "GET", headers: {} }, res);
        statusesSeenByBookTime.push(res.body.bookingProtectionLite.catchup.lastAttemptStatus);
        clockMs += 70_000;
        return BOOKTIME_DONE;
      },
      cookiePresent: () => true,
      notify: async () => {},
    });
    assert.equal(out.attemptStatus, "success");
    assert.deepEqual(statusesSeenByBookTime, ["started"]);

    const attemptWrites = writes.filter((write) => write.key === LITE_KEYS.catchupAttempt);
    assert.deepEqual(attemptWrites.map((write) => write.value.status), ["started", "success"]);
    assert.deepEqual(attemptWrites[1].rest, ["EX", String(3 * 24 * 3600)]);
    const final = attemptWrites[1].value;
    assert.equal(final.durationMs, 70_000);
    assert.deepEqual(final.raydar, { checked: 3, matched: 1, paused: 1, pauseErrors: 0, held: 0 });
    assert.equal(final.bookTime.checked, 9);
    assert.equal(final.bookTime.reads, 9);
    assert.equal(final.bookTime.stoppedBy, "deadline");
    assert.equal(final.bookTime.cursor, 129);

    const res = response();
    await healthHandler({ method: "GET", headers: {} }, res);
    assert.deepEqual(res.body.bookingProtectionLite.catchup, {
      lastAttemptStatus: "success",
      lastAttemptAt: final.at,
    }, "health keeps its existing two field names");
  });
});

test("the attempt record carries counts only, never the names or addresses in pause errors", async () => {
  await withFakeKv(async ({ writes }) => {
    await runCatchup({
      pace: async (fn) => fn(),
      catchUp: async () => ({
        ...READY_INDEXES,
        raydar: {
          checked: 1, matched: 1, paused: 0,
          pauseErrors: [{ email: "person@example.com", name: "Person Name", reason: "x" }],
        },
      }),
      bookTime: async () => ({
        ...BOOKTIME_DONE,
        pauseErrors: [{ email: "other@example.com", name: "Other Name" }],
      }),
      cookiePresent: () => true,
      notify: async () => {},
    });
    const final = writes.filter((write) => write.key === LITE_KEYS.catchupAttempt).at(-1).value;
    assert.equal(final.status, "partial");
    assert.equal(final.raydar.pauseErrors, 1);
    assert.equal(final.bookTime.pauseErrors, 1);
    const text = JSON.stringify(final);
    assert.ok(!text.includes("@example.com") && !text.includes("Name"), text);
  });
});

test("catchupAttemptStatus names each outcome", () => {
  assert.equal(catchupAttemptStatus({ ok: false }), "failure");
  assert.equal(catchupAttemptStatus({ ok: true, indexes: { liveSetReady: false } }), "skipped");
  assert.equal(catchupAttemptStatus({ ok: true, indexes: READY_INDEXES, bookTime: BOOKTIME_DONE }), "success");
  assert.equal(catchupAttemptStatus({ ok: true, indexes: { ...READY_INDEXES, calendlyError: "incomplete_index" } }), "partial");
  assert.equal(catchupAttemptStatus({ ok: true, indexes: READY_INDEXES, bookTimeError: "boom" }), "partial");
  assert.equal(
    catchupAttemptStatus({ ok: true, indexes: READY_INDEXES, bookTime: { ...BOOKTIME_DONE, stoppedBy: "refused" } }),
    "partial",
  );
  // Bookings held for a later index (reconcileIndex's `held`, when the live
  // set could not read every sequence) were not resolved this run.
  assert.equal(
    catchupAttemptStatus({ ok: true, indexes: { ...READY_INDEXES, calendly: { ...READY_INDEXES.calendly, held: 2 } }, bookTime: BOOKTIME_DONE }),
    "partial",
  );
  // Review finding: a Book Time check that never ran is not a success.
  assert.equal(catchupAttemptStatus({ ok: true, indexes: READY_INDEXES, bookTimeSkipped: "no_cookie" }), "partial");
  assert.equal(
    catchupAttemptStatus({ ok: true, indexes: READY_INDEXES, bookTime: { ...BOOKTIME_DONE, reads: 0, checked: 0 } }),
    "partial",
    "the reconciliation used the whole time budget, so no profile was read",
  );
  assert.equal(
    catchupAttemptStatus({ ok: true, indexes: READY_INDEXES, bookTime: { ...BOOKTIME_DONE, stoppedBy: "lap" } }),
    "success",
  );
  assert.equal(
    catchupAttemptStatus({ ok: true, indexes: READY_INDEXES, bookTime: { ...BOOKTIME_DONE, reads: 0, stoppedBy: "budget_invalid" } }),
    "partial",
  );
});

test("a deduplicated moved-past alert does not fall through to the retried message", async () => {
  await withFakeKv(async () => {
    const sent = [];
    await runCatchup({
      pace: async (fn) => fn(),
      catchUp: async () => ({ ...READY_INDEXES, raydar: { ...READY_INDEXES.raydar, paused: 0 } }),
      bookTime: async () => ({
        ...BOOKTIME_DONE,
        passedPauseFailures: 1,
        pauseErrors: [{ sequence: "seq_1", reason: "PARAFORM_HTTP_429" }],
      }),
      cookiePresent: () => true,
      alert: async (key) => key !== "booking-catchup-booktime-passed",
      notify: async (text) => { sent.push(text); },
    });
    assert.deepEqual(sent, []);
  });
});

test("a booked lead the rotor moved past after two failed pauses is alerted as such, not as retried", async () => {
  await withFakeKv(async () => {
    const sent = [];
    await runCatchup({
      pace: async (fn) => fn(),
      catchUp: async () => READY_INDEXES,
      bookTime: async () => ({
        ...BOOKTIME_DONE,
        stoppedBy: "lap",
        passedPauseFailures: 1,
        pauseErrors: [{ sequence: "seq_1", reason: "PARAFORM_HTTP_429" }],
      }),
      cookiePresent: () => true,
      notify: async (text) => { sent.push(text); },
    });
    const bookTimeAlerts = sent.filter((text) => text.includes("Book Time"));
    assert.equal(bookTimeAlerts.length, 1);
    assert.match(bookTimeAlerts[0], /moved past them/);
    assert.doesNotMatch(bookTimeAlerts[0], /retr/);
  });
});

test("a run with no Paraform session records the skipped Book Time check as partial", async () => {
  await withFakeKv(async ({ writes }) => {
    let rotorRan = false;
    const out = await runCatchup({
      pace: async (fn) => fn(),
      catchUp: async () => READY_INDEXES,
      bookTime: async () => { rotorRan = true; return BOOKTIME_DONE; },
      cookiePresent: () => false,
      notify: async () => {},
    });
    assert.equal(rotorRan, false);
    assert.equal(out.attemptStatus, "partial");
    const final = writes.filter((write) => write.key === LITE_KEYS.catchupAttempt).at(-1).value;
    assert.equal(final.bookTimeSkipped, "no_cookie");
    assert.equal(final.bookTime, null);
  });
});

test("a failed reconciliation is still recorded, and the Book Time rotor still runs", async () => {
  await withFakeKv(async ({ writes }) => {
    let rotorRan = false;
    const out = await runCatchup({
      pace: async (fn) => fn(),
      catchUp: async () => { throw new Error("scheduler down"); },
      bookTime: async () => { rotorRan = true; return BOOKTIME_DONE; },
      cookiePresent: () => true,
      notify: async () => {},
    });
    assert.equal(out.ok, false);
    assert.ok(rotorRan);
    const final = writes.filter((write) => write.key === LITE_KEYS.catchupAttempt).at(-1).value;
    assert.equal(final.status, "failure");
    assert.equal(final.indexesError, "scheduler down");
  });
});

test("the catch-up gives the rotor a deadline inside its own maxDuration", async () => {
  const startedAt = 1_000_000;
  let received = null;
  await withFakeKv(() => runCatchup({
    startedAt,
    pace: async (fn) => fn(),
    catchUp: async () => READY_INDEXES,
    bookTime: async (options) => { received = options; return BOOKTIME_DONE; },
    cookiePresent: () => true,
    notify: async () => {},
  }));
  assert.equal(received.deadlineAt, startedAt + BOOKTIME_START_BUDGET_MS);
  assert.equal(typeof received.clock, "function");
  // Room after the last read starts: its pacer wait and read, a paced pause
  // and read-back on a match, and the attempt record.
  assert.ok(catchupConfig.maxDuration * 1000 - BOOKTIME_START_BUDGET_MS >= 40_000);
});

test("no booking-worker tick starts while the live-set refresh or the catch-up can still be running", async () => {
  // A worker tick that overlaps the refresh shares its pacer state: a refusal
  // on either backs both off, and two processes can each read the same
  // lastRequestAt and send together. The refresh used to start at 05:22,
  // one minute before the 05:23 worker tick.
  const vercel = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  const schedule = Object.fromEntries(vercel.crons.map((entry) => [entry.path, entry.schedule]));
  const workerMinutes = schedule["/api/seq/booking-worker"].split(" ")[0].split(",").map(Number);
  const workerSeconds = workerConfig.maxDuration;
  const minuteOf = (path) => Number(schedule[path].split(" ")[0]);
  for (const [path, seconds] of [
    ["/api/seq/booking-liveset-refresh", refreshConfig.maxDuration],
    ["/api/seq/booking-catchup", catchupConfig.maxDuration],
  ]) {
    const start = minuteOf(path) * 60;
    const end = start + seconds;
    for (const minute of workerMinutes) {
      // The same tick in the hour before, this hour and the hour after.
      for (const tick of [minute * 60 - 3600, minute * 60, minute * 60 + 3600]) {
        const tickEnd = tick + workerSeconds;
        assert.ok(
          tickEnd <= start || tick >= end,
          `${path} (${schedule[path]}, up to ${seconds} s) overlaps the worker tick at :${String(minute).padStart(2, "0")} (up to ${workerSeconds} s)`,
        );
      }
    }
  }
});

test("the live-set refresh records started before it runs, so a killed run does not show the previous result", async () => {
  // Review finding: a refresh killed at maxDuration wrote nothing, so health
  // kept showing the day before. Here the run ends at once (no Paraform
  // session in this process) and replaces "started" with the failure.
  process.env.CRON_SECRET = "test-cron-secret-that-is-long-enough-000";
  try {
    await withFakeKv(async ({ writes }) => {
      const res = response();
      await refreshHandler({
        method: "GET",
        headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
      }, res);
      assert.equal(res.statusCode, 200);
      const attempts = writes.filter((write) => write.key === LITE_KEYS.liveSetAttempt);
      assert.deepEqual(attempts.map((write) => write.value.status), ["started", "failure"]);
      assert.equal(attempts[0].value.triggeredBy, "cron");
      assert.equal(attempts[1].value.error, "no_cookie");
    });
  } finally {
    delete process.env.CRON_SECRET;
  }
});
