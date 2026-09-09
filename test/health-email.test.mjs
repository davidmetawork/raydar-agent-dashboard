// Email-lane health: the witness model for the david@raydar.xyz mailbox tile,
// the lifecycle send-lane evaluators, and the beat metrics carrier.
// Spec: docs/PRD-EMAIL-LANES-HEALTH-2026-08-13.md (main repo).
import test from "node:test";
import assert from "node:assert/strict";

import {
  beatLane,
  gmailInboxDavid,
  lifecycleEmailLane,
  paraaiOutreachEmail,
  paraformMailboxes,
  paraformSequencesEmail,
  schedulerSenderEmail,
  EVALUATORS,
} from "../api/health/_lib/evaluators.mjs";
import { CATALOG, GROUPS, DAVID_MAILBOX_BEAT_LANES, byId } from "../api/health/_lib/catalog.mjs";
import {
  deriveCampaignMailboxAccounts,
  monitoredParaformRoster,
  readParaformMailboxSnapshot,
  representativeCampaigns,
} from "../api/health/mailboxes.mjs";

const iso = (deltaMs) => new Date(Date.now() + deltaMs).toISOString();
const MIN = 60_000;

const INBOX_PROBE = { evaluate: "gmailInboxDavid", davidLanes: DAVID_MAILBOX_BEAT_LANES };

// ---------- the inbox tile: witness arithmetic ----------

test("inbox: quiet mailbox with readable sources is OK, not inferred from silence", () => {
  const v = gmailInboxDavid({
    probe: INBOX_PROBE,
    kvOk: true,
    gmailBackoffUntil: null,
    beats: { "booking-resume-sync": { at: iso(-2 * MIN), status: "ok", note: "" } },
    results: {},
  });
  assert.equal(v.state, "OK");
  assert.equal(v.metrics.witnesses, 0);
});

test("inbox: one witness (armed breaker) is DEGRADED — a breaker handling a 429 is not a page", () => {
  const v = gmailInboxDavid({
    probe: INBOX_PROBE,
    kvOk: true,
    gmailBackoffUntil: iso(15 * MIN),
    beats: {},
    results: {},
  });
  assert.equal(v.state, "DEGRADED");
  assert.match(v.reason, /breaker armed/);
});

test("inbox: the 2026-08-09 lockout shape (two independent witnesses) is DOWN", () => {
  const v = gmailInboxDavid({
    probe: INBOX_PROBE,
    kvOk: true,
    gmailBackoffUntil: iso(15 * MIN),
    beats: {},
    results: {
      "email-connector-chase": {
        state: "DEGRADED",
        raw: { quota: { retryAfter: iso(10 * MIN), observedAt: iso(-5 * MIN), consecutive: 4 } },
      },
    },
  });
  assert.equal(v.state, "DOWN");
  assert.match(v.reason, /rate-limited/);
  assert.equal(v.metrics.witnesses, 2);
});

test("inbox: a 429 beat note from a david@ lane is a witness; the same note from resume-feed is not", () => {
  const beat429 = { at: iso(-3 * MIN), status: "fail", note: "GMAIL_429 on dedup search" };
  const davidLane = gmailInboxDavid({
    probe: INBOX_PROBE,
    kvOk: true,
    gmailBackoffUntil: null,
    beats: { "interview-invites": beat429 },
    results: {},
  });
  assert.equal(davidLane.state, "DEGRADED");
  assert.match(davidLane.metrics.evidence, /interview-invites/);

  // resume-feed reads resume@metawork.us — a different per-user bucket.
  const otherMailbox = gmailInboxDavid({
    probe: INBOX_PROBE,
    kvOk: true,
    gmailBackoffUntil: null,
    beats: { "resume-feed": beat429 },
    results: {},
  });
  assert.equal(otherMailbox.state, "OK");
});

test("inbox: no readable witness source is UNKNOWN, never OK", () => {
  const v = gmailInboxDavid({
    probe: INBOX_PROBE,
    kvOk: false,
    gmailBackoffUntil: null,
    beats: {},
    results: {},
  });
  assert.equal(v.state, "UNKNOWN");
});

test("inbox: reminder-lane silence past two hours counts as send-lane distress", () => {
  const v = gmailInboxDavid({
    probe: INBOX_PROBE,
    kvOk: true,
    gmailBackoffUntil: iso(10 * MIN),
    beats: {},
    results: {
      "email-precall-reminders": { state: "DEGRADED", metrics: { ageMin: 190 } },
    },
  });
  assert.equal(v.state, "DOWN");
  assert.match(v.metrics.evidence, /reminders silent/);
});

// ---------- lifecycle send lanes ----------

test("lifecycle lane: healthy state file with counters reads OK and carries volume", () => {
  const v = lifecycleEmailLane({
    status: 200,
    body: {
      health: { lastOkAt: iso(-10 * MIN), consecutiveFailures: 0, lastCode: null },
      quota: { retryAfter: null, consecutive: 0 },
      pending: { a: {}, b: {} },
      counters: { "2026-08-12": { sent: 93 }, "2026-08-13": { sent: 41 } },
    },
  });
  assert.equal(v.state, "OK");
  assert.equal(v.metrics.pending, 2);
  assert.equal(v.metrics.sentLatestDay, 41);
  assert.equal(v.metrics.sentPriorDay, 93);
});

test("lifecycle lane: a persisted Gmail backoff is DEGRADED with the deadline named", () => {
  const v = lifecycleEmailLane({
    status: 200,
    body: {
      health: { lastOkAt: iso(-5 * MIN), consecutiveFailures: 0, lastCode: null },
      quota: { retryAfter: iso(12 * MIN), consecutive: 2 },
    },
  });
  assert.equal(v.state, "DEGRADED");
  assert.match(v.reason, /backoff armed/);
});

test("lifecycle lane: staleness ladder — 46m DEGRADED, 181m DOWN, 480-failure shape DOWN", () => {
  const stale = lifecycleEmailLane({
    status: 200,
    body: { health: { lastOkAt: iso(-46 * MIN), consecutiveFailures: 0 } },
  });
  assert.equal(stale.state, "DEGRADED");

  const dead = lifecycleEmailLane({
    status: 200,
    body: { health: { lastOkAt: iso(-181 * MIN), consecutiveFailures: 0 } },
  });
  assert.equal(dead.state, "DOWN");

  // The 2026-08-04 disease: hundreds of consecutive failures, zero alerts.
  const failing = lifecycleEmailLane({
    status: 200,
    body: { health: { lastOkAt: iso(-5 * MIN), consecutiveFailures: 480, lastCode: "GMAIL_429" } },
  });
  assert.equal(failing.state, "DOWN");
  assert.match(failing.reason, /480 consecutive/);
});

test("lifecycle lane: key-missing and schema drift are UNKNOWN, never verdicts", () => {
  assert.equal(lifecycleEmailLane({ keyMissing: true }).state, "UNKNOWN");
  assert.equal(lifecycleEmailLane({ status: 200, body: { sent: {} } }).state, "UNKNOWN");
  assert.equal(lifecycleEmailLane({ status: 200, body: null }).state, "UNKNOWN");
});

// ---------- the rest of the email group ----------

test("paraai outreach: armed breaker is DEGRADED even when the health payload is missing", () => {
  const v = paraaiOutreachEmail({ results: {}, gmailBackoffUntil: iso(10 * MIN) });
  assert.equal(v.state, "DEGRADED");
  assert.match(v.reason, /queued, not lost/);
});

test("paraai outreach: ready payload OK; approved-but-not-ready DEGRADED; absent UNKNOWN", () => {
  const ready = paraaiOutreachEmail({
    results: { "paraai-lane": { raw: { outreach: { approved: true, executionReady: true, mailbox: "david@raydar.xyz" }, automation: { queue: { due: 0 } } } } },
    gmailBackoffUntil: null,
  });
  assert.equal(ready.state, "OK");
  assert.equal(ready.metrics.mailbox, "david@raydar.xyz");

  const notReady = paraaiOutreachEmail({
    results: { "paraai-lane": { raw: { outreach: { approved: true, executionReady: false } } } },
    gmailBackoffUntil: null,
  });
  assert.equal(notReady.state, "DEGRADED");

  assert.equal(paraaiOutreachEmail({ results: {}, gmailBackoffUntil: null }).state, "UNKNOWN");
});

test("scheduler sender: reads the booking-door fetch — gmail:false is DOWN, no payload UNKNOWN", () => {
  const down = schedulerSenderEmail({
    results: { "booking-door": { raw: { health: { checks: { gmail: false } } } } },
  });
  assert.equal(down.state, "DOWN");

  const ok = schedulerSenderEmail({
    results: { "booking-door": { raw: { health: { checks: { gmail: true, nativeReminders: true } } } } },
  });
  assert.equal(ok.state, "OK");

  assert.equal(schedulerSenderEmail({ results: {} }).state, "UNKNOWN");
});

test("paraform mailboxes: david@ in ERROR is DOWN; a few alias errors DEGRADED; session gone UNKNOWN", () => {
  const davidDead = paraformMailboxes({
    status: 200,
    body: { ok: true, paraform: "live", counts: { total: 27, gmailActive: 26, gmailError: 1 }, davidGmailStatus: "ERROR" },
  });
  assert.equal(davidDead.state, "DOWN");

  const someErrors = paraformMailboxes({
    status: 200,
    body: { ok: true, paraform: "live", counts: { total: 27, gmailActive: 25, gmailError: 2 }, davidGmailStatus: "ACTIVE", errorDomains: ["heyraydar.com"] },
  });
  assert.equal(someErrors.state, "DEGRADED");
  assert.match(someErrors.reason, /2\/27/);

  const fleetDown = paraformMailboxes({
    status: 200,
    body: { ok: true, paraform: "live", counts: { total: 27, gmailActive: 18, gmailError: 9 }, davidGmailStatus: "ACTIVE" },
  });
  assert.equal(fleetDown.state, "DOWN");

  assert.equal(paraformMailboxes({ status: 200, body: { ok: false, paraform: "no_cookie" } }).state, "UNKNOWN");
  assert.equal(paraformMailboxes({ keyMissing: true }).state, "UNKNOWN");
  assert.equal(paraformMailboxes({ status: 200, body: { hello: 1 } }).state, "UNKNOWN");

  // A roster where NO account reports any status is blindness, not health.
  const statusless = paraformMailboxes({
    status: 200,
    body: { ok: true, paraform: "live", counts: { total: 27, gmailActive: 0, gmailError: 0 }, davidGmailStatus: "UNKNOWN" },
  });
  assert.equal(statusless.state, "UNKNOWN");
  assert.match(statusless.reason, /no gmail_status/);

  const partial = paraformMailboxes({
    status: 200,
    body: { ok: true, paraform: "live", counts: { total: 27, gmailActive: 26, gmailError: 0, other: 1 }, davidGmailStatus: "ACTIVE" },
  });
  assert.equal(partial.state, "DEGRADED");
  assert.match(partial.reason, /1\/27/);
});

test("paraform mailbox endpoint: chooses one enabled representative per owner", () => {
  const representatives = representativeCampaigns([
    { id: "owner-a-old", enabled: false, user: { email: "owner-a@example.test" } },
    { id: "owner-a-live", enabled: true, user: { email: "OWNER-A@example.test" } },
    { id: "owner-b", enabled: false, user: { id: "owner-b" } },
    { id: "missing-owner", enabled: true, user: {} },
  ]);
  assert.deepEqual(representatives.map((row) => row.id), ["owner-a-live", "owner-b"]);
});

test("paraform mailbox endpoint: joins roster to full-campaign gmail_status and never lets Outlook rescue Gmail", () => {
  const accounts = deriveCampaignMailboxAccounts(
    [
      { email: "david@raydar.xyz" },
      { email: "alias@heyraydar.com" },
      { email: "unmapped@raydarcareers.com" },
    ],
    [{
      user: {
        accounts: [
          { email: "david@raydar.xyz", gmail_status: "ACTIVE", outlook_status: "ACTIVE" },
          { email: "alias@heyraydar.com", gmail_status: "ACTIVE", outlook_status: "ACTIVE" },
        ],
      },
      campaign_to_accounts: [{
        account: { email: "ALIAS@heyraydar.com", gmail_status: "ERROR", outlook_status: "ACTIVE" },
      }],
    }],
  );
  assert.deepEqual(accounts, [
    { email: "david@raydar.xyz", gmailStatus: "ACTIVE", outlookStatus: "ACTIVE" },
    { email: "alias@heyraydar.com", gmailStatus: "ERROR", outlookStatus: "ACTIVE" },
    { email: "unmapped@raydarcareers.com", gmailStatus: "UNKNOWN", outlookStatus: null },
  ]);
});

test("paraform mailbox endpoint: excludes the separate persona fleet from the sending-fleet tile", () => {
  const monitored = monitoredParaformRoster([
    { email: "david@raydar.xyz" },
    { email: "david@heyraydar.com" },
    { email: "noah@chatraydar.com" },
    { email: "persona@unrelated-mailbox.test" },
    { email: "david@persona-domain.test" },
  ]);
  assert.deepEqual(monitored.map((row) => row.email), [
    "david@raydar.xyz",
    "david@heyraydar.com",
    "noah@chatraydar.com",
  ]);
});

test("paraform mailbox endpoint: refreshes roster/list plus one full campaign per owner", async () => {
  const calls = [];
  const get = async (procedure, input) => {
    calls.push({ procedure, input });
    if (procedure === "gmail.getActiveUserGmailAccounts") {
      return [
        { email: "david@heyraydar.com" },
        { email: "david@raydarcareers.com" },
        { email: "persona@unrelated-mailbox.test" },
      ];
    }
    if (procedure === "campaigns.getListOfCampaignsOptimized") {
      return [
        { id: "campaign-one", enabled: true, user: { email: "owner-one@example.test" } },
        { id: "campaign-two", enabled: true, user: { email: "owner-two@example.test" } },
        { id: "campaign-one-old", enabled: false, user: { email: "owner-one@example.test" } },
      ];
    }
    const email = input.campaign_id === "campaign-one"
      ? "david@heyraydar.com"
      : "david@raydarcareers.com";
    return { user: { accounts: [{ email, gmail_status: "ACTIVE" }] } };
  };

  const snapshot = await readParaformMailboxSnapshot({ get });
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.campaignCount, 3);
  assert.equal(snapshot.campaignOwnersRead, 2);
  assert.equal(snapshot.paraformRosterCount, 3);
  assert.equal(snapshot.accounts.length, 2);
  assert.equal(snapshot.accounts.every((row) => row.gmailStatus === "ACTIVE"), true);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map((call) => call.procedure), [
    "gmail.getActiveUserGmailAccounts",
    "campaigns.getListOfCampaignsOptimized",
    "campaigns.getCampaign",
    "campaigns.getCampaign",
  ]);
});

test("paraform sequences: a fully blind tick is UNKNOWN — an UNKNOWN inbox result is not an observation", () => {
  const v = paraformSequencesEmail({
    results: { "inbox-health": { state: "UNKNOWN", reason: "offline" } },
  });
  assert.equal(v.state, "UNKNOWN");
});

test("paraform sequences: stale booking-stop sweep is DEGRADED with volume carried", () => {
  const v = paraformSequencesEmail({
    results: {
      "seq-guardian": { raw: { sequenceCount: 41, bookingStop: { stale: true, latestAttemptError: "throttled" } } },
      "inbox-health": { state: "OK" },
    },
  });
  assert.equal(v.state, "DEGRADED");
  assert.equal(v.metrics.sequenceCount, 41);
});

// ---------- beat metrics carrier ----------

test("beatLane surfaces producer metrics without letting them clobber freshness facts", () => {
  const v = beatLane({
    probe: { lane: "interview-invites", maxSilenceMin: 1470 },
    beat: {
      at: iso(-5 * MIN),
      status: "ok",
      metrics: { sent: 12, gmail429: 0, ageMin: 99999, status: 7 },
    },
  });
  assert.equal(v.state, "OK");
  assert.equal(v.metrics.sent, 12);
  assert.equal(v.metrics.gmail429, 0);
  // Reserved keys stay the board's own facts.
  assert.equal(v.metrics.status, "ok");
  assert.ok(v.metrics.ageMin < 10);
});

// ---------- catalog shape ----------

test("catalog: the email group exists and its checks resolve to real evaluators", () => {
  assert.ok(GROUPS.some((g) => g.id === "email"));
  const email = CATALOG.filter((c) => c.group === "email");
  assert.ok(email.length >= 15, `expected a full email census, got ${email.length}`);
  for (const check of CATALOG) {
    if (check.kind === "beat") continue;
    assert.ok(EVALUATORS[check.probe.evaluate], `${check.id} names missing evaluator ${check.probe.evaluate}`);
  }
});

test("catalog: the inbox tile is tier 1 and its witness lanes are all real beat lanes", () => {
  const inbox = byId.get("email-inbox-david");
  assert.equal(inbox.tier, 1);
  const beatLaneIds = new Set(CATALOG.filter((c) => c.kind === "beat").map((c) => c.probe.lane));
  for (const lane of inbox.probe.davidLanes) {
    assert.ok(beatLaneIds.has(lane), `witness lane ${lane} is not a catalog beat lane`);
  }
});

test("catalog: desktop-runner collapse counts laptop lanes wherever they are grouped, never GHA", () => {
  const runnerLanes = CATALOG.filter((c) => c.kind === "beat" && c.runner === "desktop");
  assert.ok(runnerLanes.some((c) => c.group === "email"), "moved email lanes must stay in the collapse");
  assert.ok(runnerLanes.some((c) => c.group === "desktop"));
  for (const c of runnerLanes) assert.ok(!c.id.startsWith("gha-"), `${c.id} is not a laptop lane`);
  const gha = CATALOG.filter((c) => c.id.startsWith("gha-"));
  for (const c of gha) assert.notEqual(c.runner, "desktop");
  // Every previously-collapsing lane still collapses: the live desktop census.
  // Update this list when a lane is genuinely added or retired on the desktop —
  // paraai-interest-observer left on 2026-08-20 (launchd job booted out, plist
  // archived to retired-20260818/) because its pause-watchdog baseline went out
  // of date when David re-armed the interest lane.
  const live = runnerLanes.filter((c) => !c.paused).map((c) => c.probe.lane).sort();
  assert.deepEqual(live, [
    "applicant-hub-watchdog", "applicant-hub-worker", "archive-backfill",
    "booking-resume-email-index", "booking-resume-retry", "booking-resume-sync",
    "interview-invites",
    "resume-feed", "resume-juicebox-bridge-v1", "resume-ledger-backup-v2",
    "resume-watchdog-v2", "tn-reenable",
  ]);
});

test("catalog: interview-invites windows are sized to the real 09:10/13:10/17:10 schedule", () => {
  const row = byId.get("lane-interview-invites");
  assert.equal(row.kind, "beat");
  assert.ok(row.probe.degradedAfterMin > 16 * 60, "must clear the 16h overnight gap");
  assert.ok(row.probe.maxSilenceMin < 26 * 60, "a whole missed day must be DOWN");
});

test("catalog: moved lanes kept their ids so history survives", () => {
  for (const id of [
    "lane-resume-feed", "lane-booking-resume-sync", "lane-booking-resume-retry",
    "lane-booking-resume-email-index", "lane-resume-chase", "lane-archive-backfill",
    "lane-applicant-hub-worker", "lane-hm-chase", "lane-resume-forward-v2",
  ]) {
    const row = byId.get(id);
    assert.ok(row, `${id} vanished`);
    assert.equal(row.group, "email");
  }
});
