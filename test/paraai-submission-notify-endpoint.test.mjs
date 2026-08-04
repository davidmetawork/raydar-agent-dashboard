/**
 * End-to-end cover for the submission-notify endpoint: the tick that stitches
 * the three collectors to the dispatcher. The collectors and dispatcher have
 * their own unit tests; these pin the ORCHESTRATION — seeding, stream
 * isolation, dedupe-before-Gmail, the lookup cap, and the auth/config gates.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createSubmissionNotifyHandler, runnerAuthorized } from "../api/paraai/submission-notify.mjs";

function res() {
  const out = { code: null, body: null, headers: {} };
  return {
    out,
    setHeader(k, v) { out.headers[k] = v; },
    status(code) { out.code = code; return this; },
    json(body) { out.body = body; return this; },
  };
}

const handoff = (over = {}) => ({ candidateUserId: "c1", batchId: "b1", roles: ["r1"], ...over });
const candidate = { candidateUserId: "c1", name: "Ada Lovelace" };
const inboxReply = (over = {}) => ({
  sequence_id: "seq1", sequence_name: "Post-call list", candidate_name: "Grace Hopper",
  ccu_id: "ccu1", gmail_id: "g1", snippet: "Sounds great, happy to chat.", ...over,
});

function harness(over = {}) {
  const store = new Map();
  const posted = [];
  const alerts = [];
  const reads = [];
  // The factory destructures its deps once, so tests must mutate STATE the
  // injected functions close over, never the deps object itself.
  const cfg = {
    handoffs: [], candidates: [], states: [], replies: [], partial: false,
    slackUp: true, configured: true, authOk: true, cronOk: true, runnerOk: false,
    handoffsThrows: null, statesThrows: null, feedThrows: null,
    ...over,
  };
  const deps = {
    corsHandler: () => false,
    authHandler: async () => cfg.authOk,
    cronAuthHandler: () => ({ ok: cfg.cronOk }),
    runnerAuth: () => cfg.runnerOk,
    configured: () => cfg.configured,
    kvGet: async (k) => store.get(k) ?? null,
    kvSet: async (k, v) => { store.set(k, v); },
    kvDel: async (k) => { store.delete(k); },
    listHandoffs: async () => {
      if (cfg.handoffsThrows) throw new Error(cfg.handoffsThrows);
      return cfg.handoffs;
    },
    listCandidates: async () => cfg.candidates,
    listStates: async () => {
      if (cfg.statesThrows) throw new Error(cfg.statesThrows);
      return cfg.states;
    },
    sequenceIds: () => ["seq1"],
    buildFeed: async () => {
      if (cfg.feedThrows) throw new Error(cfg.feedThrows);
      return { replies: cfg.replies, partial: cfg.partial };
    },
    mailboxFor: () => "recruiter@raydar.xyz",
    threadFor: async (_m, id) => { reads.push(id); return { messages: [] }; },
    postMessage: async (t) => { if (!cfg.slackUp) return false; posted.push(t); return true; },
    alert: async (t) => { alerts.push(t); return true; },
    textLookupCap: cfg.textLookupCap,
    renotifyCap: cfg.renotifyCap,
  };
  return { store, posted, alerts, reads, cfg, handler: createSubmissionNotifyHandler(deps) };
}

const run = async (h, query) => {
  const r = res();
  await h.handler({ headers: {}, ...(query ? { query } : {}) }, r);
  return r.out;
};

/* ───────────────────────────────────────────────────────── gates before work */

test("an unauthenticated request does no work and never posts", async () => {
    const h = harness({ cronOk: false, authOk: false, handoffs: [handoff()] });
  await run(h);
  assert.equal(h.store.size, 0, "nothing may be read or marked before auth passes");
  assert.equal(h.posted.length, 0);
});

test("an unconfigured Slack channel reports it and does NOT seed", async () => {
  // Seeding while unconfigured would burn the one quiet pass, so the first
  // properly configured run would post the whole backlog.
  const h = harness({ configured: false, handoffs: [handoff()] });
  const out = await run(h);
  assert.equal(out.body.ok, false);
  assert.equal(out.body.error, "not_configured");
  assert.equal(h.store.size, 0, "nothing may be marked seen while unconfigured");
});

/* ─────────────────────────────────────────────────────────────── the seeding */

test("the first configured tick seeds silently and posts nothing", async () => {
  const h = harness({ handoffs: [handoff()], candidates: [candidate], replies: [inboxReply()] });
  const out = await run(h);
  assert.equal(out.body.seeding, true);
  assert.equal(h.posted.length, 0);
  assert.ok(out.body.seeded >= 2, "existing history must be marked, not posted");
});

test("a request reply names the candidate and links straight to them", async () => {
  // The 2026-08-04 report: every message in the channel read "Unknown
  // candidate". Nothing had to be matched — the state already held all of this.
  const replied = (over = {}) => ({
    candidateUserId: "cu_1",
    candidateName: "Ada Lovelace",
    candidateEmail: "ada@example.com",
    repliedAt: "2026-08-04T10:00:00Z",
    threadId: "t1",
    latestMatchId: "m1",
    matches: {
      m1: { roleId: "r_1", roleName: "Account Executive", companyName: "Acme", sentAt: "2026-08-01T00:00:00Z" },
    },
    ...over,
  });
  const h = harness({ states: [replied({ intentCheckedThrough: 1000 })] });
  await run(h);                                              // seed
  h.cfg.states = [replied({ intentCheckedThrough: 2000 })];  // a new reply
  await run(h);

  assert.equal(h.posted.length, 1, h.posted.join("\n"));
  const [message] = h.posted;
  assert.ok(!message.includes("Unknown candidate"), message);
  assert.match(message, /Ada Lovelace/);
  assert.match(message, /Account Executive @ Acme/);
  assert.match(message, /candidates\?id=cu_1&r_id=r_1/);
});

/* ─────────────────────────── the replay: reposting a message posted wrong ── */

const AUG = (day, hour) => Date.UTC(2026, 7, day, hour);
const repliedAt = (ms, over = {}) => ({
  candidateUserId: `cu_${ms}`,
  candidateName: `Candidate ${ms}`,
  repliedAt: new Date(ms).toISOString(),
  intentCheckedThrough: ms,
  ...over,
});

test("a replay reposts only the window asked for, in the same tick", async () => {
  const h = harness({ states: [repliedAt(AUG(1, 9)), repliedAt(AUG(4, 9))] });
  await run(h);                              // seed: both marked, nothing posted
  assert.equal(h.posted.length, 0);

  const out = await run(h, { renotify: "request", since: "2026-08-03T00:00:00Z" });
  assert.equal(out.body.replay.cleared, 1, "only the reply inside the window");
  assert.equal(h.posted.length, 1);
  assert.match(h.posted[0], new RegExp(`Candidate ${AUG(4, 9)}`));
});

test("a replayed event is re-marked, so a second replay is needed to repost it", async () => {
  const h = harness({ states: [repliedAt(AUG(4, 9))] });
  await run(h);
  await run(h, { renotify: "request", since: "2026-08-01T00:00:00Z" });
  assert.equal(h.posted.length, 1);
  await run(h);                              // an ordinary tick must stay quiet
  assert.equal(h.posted.length, 1, "the replay must not leave the event permanently un-deduped");
});

test("a replay without a window is refused rather than replaying everything", async () => {
  const h = harness({ states: [repliedAt(AUG(1, 9))] });
  await run(h);
  const out = await run(h, { renotify: "request" });
  assert.equal(out.code, 400);
  assert.match(out.body.error, /since/);
  assert.equal(h.posted.length, 0, "a refused replay must post nothing");
});

test("only the request stream can be replayed, because only its ids are ordered", async () => {
  const h = harness({ handoffs: [handoff()], candidates: [candidate] });
  await run(h);
  const out = await run(h, { renotify: "interest", since: "2026-08-01T00:00:00Z" });
  assert.equal(out.code, 400);
  assert.equal(h.posted.length, 0);
});

test("a replay is capped, and says what it did not do", async () => {
  const states = [AUG(4, 1), AUG(4, 2), AUG(4, 3)].map((ms) => repliedAt(ms));
  const h = harness({ states, renotifyCap: 2 });
  await run(h);
  const out = await run(h, { renotify: "request", since: "2026-08-01T00:00:00Z" });
  assert.equal(out.body.replay.cleared, 2);
  assert.equal(out.body.replay.skipped, 1);
  assert.ok(out.body.errors.some((e) => /capped at 2 of 3/.test(e)), out.body.errors.join("; "));
  assert.equal(h.posted.length, 2, "the capped one waits for a narrower replay, it is not lost");
});

test("a replay during seeding clears nothing, so it cannot un-seed the lane", async () => {
  // Seeding posts nothing, so clearing marks there would only hand the next
  // tick a backlog to flood with.
  const h = harness({ states: [repliedAt(AUG(4, 9))] });
  const out = await run(h, { renotify: "request", since: "2026-08-01T00:00:00Z" });
  assert.equal(out.body.seeding, true);
  assert.equal(out.body.replay.cleared, 0);
  assert.equal(h.posted.length, 0);
});

test("after a clean seed, only genuinely new events post", async () => {
  const h = harness({ handoffs: [handoff()], candidates: [candidate] });
  await run(h);                                  // seed
  const quiet = await run(h);
  assert.equal(quiet.body.seeding, false);
  assert.equal(h.posted.length, 0);

  h.cfg.handoffs = [handoff(), handoff({ batchId: "b2" })];
  const out = await run(h);
  assert.equal(out.body.posted, 1);
  assert.match(h.posted[0], /Ada Lovelace/);
});

test("a seeding pass with a failed stream is NOT marked seeded", async () => {
  // The defect this guards: marking seeded after a partial pass would make the
  // failed stream's whole backlog look brand new on the next tick.
  const h = harness({ handoffs: [handoff()], candidates: [candidate], feedThrows: "inbox down" });
  const first = await run(h);
  assert.equal(first.body.seeding, true);
  assert.ok(first.body.errors.join(" ").includes("inbox down"));

  h.cfg.feedThrows = null; h.cfg.replies = [inboxReply()];
  const second = await run(h);
  assert.equal(second.body.seeding, true, "still seeding until a clean pass completes");
  assert.equal(h.posted.length, 0, "and the recovered stream's history is seeded, not posted");

  const third = await run(h);
  assert.equal(third.body.seeding, false);
});

/* ─────────────────────────────────────────────────────── all three streams */

test("all three streams reach the one channel in a single tick", async () => {
  const h = harness({ handoffs: [handoff()], candidates: [candidate], states: [{ candidateUserId: "c2", repliedAt: "x", intentCheckedThrough: 1, threadId: "t1" }], replies: [inboxReply()] });
  await run(h); // seed

  h.cfg.handoffs = [handoff({ batchId: "b9" })];
  h.cfg.states = [{ candidateUserId: "c2", repliedAt: "x", intentCheckedThrough: 99, threadId: "t1" }];
  h.cfg.replies = [inboxReply({ gmail_id: "g9" })];

  const out = await run(h);
  assert.equal(out.body.posted, 3);
  assert.equal(out.body.counts.interest, 1);
  assert.equal(out.body.counts.request, 1);
  assert.equal(out.body.counts.sequence, 1);
  assert.equal(h.posted.filter((t) => /Grace Hopper/.test(t)).length, 1);
});

/* ───────────────────────────────────────────────────── isolation and outages */

test("one dead stream does not silence the others, and is surfaced", async () => {
  const h = harness({ handoffs: [handoff()], candidates: [candidate] });
  await run(h); // clean seed

  h.cfg.statesThrows = "gmail down";
  h.cfg.handoffs = [handoff({ batchId: "b2" })];
  const out = await run(h);

  assert.equal(out.body.posted, 1, "interest still notified");
  assert.match(out.body.errors.join(" "), /gmail down/);
  assert.equal(h.alerts.length, 1, "a persistently failing stream must not be invisible");
});

test("a Slack outage loses nothing: the backlog delivers on recovery", async () => {
  const h = harness({ handoffs: [handoff()], candidates: [candidate], slackUp: false });
  await run(h); // seed
  h.cfg.handoffs = [handoff({ batchId: "b2" })];

  const down = await run(h);
  assert.equal(down.body.posted, 0);
  assert.equal(down.body.failed, 1);

  h.cfg.slackUp = true;
  const back = await run(h);
  assert.equal(back.body.posted, 1);
});

/* ──────────────────────────────────────── dedupe before Gmail, and the cap */

test("Gmail is read only for replies not already notified", async () => {
  const h = harness();
  await run(h); // seed with no replies

  h.cfg.states = [{ candidateUserId: "c1", repliedAt: "x", intentCheckedThrough: 10, threadId: "t1" }];
  await run(h);
  assert.deepEqual(h.reads, ["t1"], "one read for the new reply");

  await run(h);
  assert.equal(h.reads.length, 1, "no further read once notified");
});

test("seeding does not spend Gmail reads at all", async () => {
  const h = harness({ states: [{ candidateUserId: "c1", repliedAt: "x", intentCheckedThrough: 10, threadId: "t1" }] });
  await run(h);
  assert.equal(h.reads.length, 0);
});

test("the Gmail lookup cap bounds reads per tick without dropping events", async () => {
  const reads = [];
  const states = Array.from({ length: 5 }, (_, i) => ({
    candidateUserId: `c${i}`, repliedAt: "x", intentCheckedThrough: 10 + i, threadId: `t${i}`,
  }));
  const h = harness({ textLookupCap: 2 });
  await run(h); // seed with no replies
  h.cfg.states = states;

  const out = await run(h);
  assert.equal(h.reads.length, 2, "reads are capped");
  assert.equal(out.body.posted, 5, "but every event still notifies, uncapped ones as unclear");
});

test("a candidate with no thread id still notifies rather than being dropped", async () => {
  const h = harness();
  await run(h);
  h.cfg.states = [{ candidateUserId: "c1", repliedAt: "x", intentCheckedThrough: 7 }];
  const out = await run(h);
  assert.equal(out.body.posted, 1);
  assert.match(h.posted[0], /Unclear/);
});

/* ──────────────────────────────────────────────────────────── stream scoping */

test("replies from unrelated sequences never reach the channel", async () => {
  const h = harness({ replies: [inboxReply()] });
  await run(h); // seed
  h.cfg.replies = [inboxReply({ gmail_id: "g2", sequence_id: "someone-elses-campaign" })];
  const out = await run(h);
  assert.equal(out.body.posted, 0);
});

test("a partial inbox feed is reported but its replies still notify", async () => {
  const h = harness();
  await run(h); // seed
  h.cfg.replies = [inboxReply({ gmail_id: "g5" })]; h.cfg.partial = true;
  const out = await run(h);
  assert.equal(out.body.posted, 1, "some replies beat none");
  assert.match(out.body.errors.join(" "), /partial/);
});

/* ─────────────────────────────────────────────────────────── the runner key */

test("the runner key is accepted, so the tick is observable by hand", async () => {
  // Without this the tick cannot be invoked, and a cron that returns nothing is
  // indistinguishable from a cron that never fired.
  const h = harness({ authOk: false, cronOk: false, runnerOk: true, handoffs: [handoff()] });
  const out = await run(h);
  assert.equal(out.body.seeding, true, "it ran rather than 401ing");
});

test("a wrong or absent runner key still cannot run the tick", async () => {
  const h = harness({ authOk: false, cronOk: false, runnerOk: false, handoffs: [handoff()] });
  await run(h);
  assert.equal(h.store.size, 0, "no work, no writes");
});

test("runnerAuthorized compares the real secret, not a prefix", async () => {
  const env = { PARAAI_AUTOMATION_RUNNER_KEY: "s3cret-value" };
  const mk = (t) => ({ headers: { authorization: `Bearer ${t}` } });
  assert.equal(runnerAuthorized(mk("s3cret-value"), env), true);
  assert.equal(runnerAuthorized(mk("s3cret"), env), false, "a prefix must not pass");
  assert.equal(runnerAuthorized(mk("s3cret-value-extra"), env), false);
  assert.equal(runnerAuthorized({ headers: {} }, env), false);
  assert.equal(runnerAuthorized(mk("anything"), {}), false, "no secret configured = closed");
});
