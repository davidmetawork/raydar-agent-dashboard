import assert from "node:assert/strict";
import test from "node:test";

// Staff picks for held rating-protected subs (2026-11-06). The tick tests at
// the bottom go through runOutreachTick, whose stores snapshot their KV
// configuration at import time, so an in-memory KV is installed before the
// modules load. Any request that is not the fake KV fails the test: no
// Paraform, Gmail or Slack IO may occur. Every name here is made up.
const KV_URL = "https://kv.protected-picks.test";
process.env.KV_REST_API_URL = KV_URL;
process.env.KV_REST_API_TOKEN = "kv-test-token";
process.env.PARAAI_AUTOMATION_RUNNER_KEY = "runner-test-secret";

const kvStore = new Map();
const zsets = new Map();
const hashes = new Map();
const providerCalls = [];

function command([name, ...args]) {
  switch (String(name).toUpperCase()) {
    case "GET": return kvStore.get(args[0]) ?? null;
    case "MGET": return args.map((key) => kvStore.get(key) ?? null);
    case "SET": {
      const [key, value, ...options] = args;
      if (options.includes("NX") && kvStore.has(key)) return null;
      kvStore.set(key, value);
      return "OK";
    }
    case "DEL": return kvStore.delete(args[0]) ? 1 : 0;
    case "ZREVRANGE": return [...(zsets.get(args[0]) || [])].reverse();
    case "HGETALL": return Object.entries(hashes.get(args[0]) || {}).flat();
    case "EVAL": {
      const [script, keyCount, ...rest] = args;
      const keys = rest.slice(0, Number(keyCount));
      if (script.includes("redis.call('GET', KEYS[1]) == ARGV[1]")) {
        if (kvStore.get(keys[0]) === rest[Number(keyCount)]) { kvStore.delete(keys[0]); return 1; }
        return 0;
      }
      throw new Error(`unexpected EVAL in test: ${String(script).slice(0, 60)}`);
    }
    default: throw new Error(`unexpected KV command in test: ${name}`);
  }
}

globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  if (!href.startsWith(KV_URL)) {
    providerCalls.push(href);
    throw new Error(`provider IO must not occur: ${href}`);
  }
  const body = JSON.parse(init.body || "null");
  const result = href.endsWith("/pipeline")
    ? body.map((item) => ({ result: command(item) }))
    : { result: command(body) };
  return new Response(JSON.stringify(result), { status: 200 });
};

const {
  getProtectedPick,
  getProtectedPicks,
  pruneProtectedPicks,
  saveProtectedPick,
} = await import("../api/paraai/_lib/outreach-store.mjs");
const {
  heldProtectedSubs,
  pickProtectedSub,
  PICK_QUEUED_MESSAGE,
  protectedDeliveries,
  skipProtectedSub,
  staffActor,
  staleProtectedPicks,
} = await import("../api/paraai/_lib/outreach-protected-picks.mjs");
const { outreachConfig, runOutreachTick } = await import("../api/paraai/_lib/outreach.mjs");
const { watchUnsentProtectedSubs, PROTECTED_PICKS_PAGE_URL } = await import("../api/paraai/_lib/outreach-protected.mjs");
const { default: handler } = await import("../api/paraai/outreach.mjs");

test.beforeEach(() => {
  kvStore.clear();
  zsets.clear();
  hashes.clear();
  providerCalls.length = 0;
});

// ── Store helpers ────────────────────────────────────────────────────────────

function fakeKv() {
  const hash = new Map();
  const calls = [];
  const kvImpl = async (args) => {
    calls.push(args);
    const [name, key, field, value, ...more] = args;
    assert.equal(key, "paraai:outreach:protected:picks");
    if (name === "HGETALL") return [...hash.entries()].flat();
    if (name === "HSET") { hash.set(field, value); return 1; }
    if (name === "HSETNX") { if (hash.has(field)) return 0; hash.set(field, value); return 1; }
    if (name === "HDEL") { let n = 0; for (const id of [field, value, ...more].filter(Boolean)) n += hash.delete(id) ? 1 : 0; return n; }
    throw new Error(`unexpected ${name}`);
  };
  return { hash, calls, kvImpl };
}

test("picks are kept in their own hash, first writer wins, torn values are skipped, and prune removes them", async () => {
  const { hash, calls, kvImpl } = fakeKv();
  const send = { requestId: "req-a", action: "send", candidateUserId: "cu-1", name: "Trish Jo", linkedinUser: "trish-jo", pickedBy: "staff@raydar.xyz", pickedAt: "2026-11-06T18:00:00.000Z" };
  assert.equal(await saveProtectedPick(send, { kvImpl, onlyIfAbsent: true }), true);
  assert.equal(await saveProtectedPick({ ...send, candidateUserId: "cu-2" }, { kvImpl, onlyIfAbsent: true }), false, "a second picker loses");
  hash.set("req-torn", "{not json");
  hash.set("req-odd", JSON.stringify({ requestId: "req-odd", action: "maybe" }));
  const picks = await getProtectedPicks({ kvImpl });
  assert.deepEqual(Object.keys(picks), ["req-a"]);
  assert.equal(picks["req-a"].candidateUserId, "cu-1");
  // A plain save (a skip over a send) overwrites.
  await saveProtectedPick({ requestId: "req-a", action: "skip", pickedBy: "staff@raydar.xyz", pickedAt: "2026-11-06T18:01:00.000Z" }, { kvImpl });
  assert.equal((await getProtectedPicks({ kvImpl }))["req-a"].action, "skip");
  await assert.rejects(saveProtectedPick({ requestId: "req-b", action: "send" }, { kvImpl }), /candidateUserId/);
  await assert.rejects(saveProtectedPick({ requestId: "", action: "skip" }, { kvImpl }), /requestId/);
  assert.equal(await pruneProtectedPicks(["req-a", "req-torn", ""], { kvImpl }), 2);
  assert.deepEqual(calls.at(-1), ["HDEL", "paraai:outreach:protected:picks", "req-a", "req-torn"]);
  assert.equal(await pruneProtectedPicks([], { kvImpl }), 0);
  // An unreadable store throws, so the tick can tell it from "no picks".
  await assert.rejects(getProtectedPicks({ kvImpl: async () => { throw new Error("down"); } }), /down/);
});

test("stale picks are the ones whose note is gone or two windows old", () => {
  const now = Date.parse("2026-11-20T00:00:00.000Z");
  const subs = new Map([
    ["fresh", { requestId: "fresh", receivedAt: "2026-11-15T00:00:00.000Z" }],
    ["old", { requestId: "old", receivedAt: "2026-11-01T00:00:00.000Z" }],
  ]);
  const picks = { fresh: {}, old: {}, gone: {} };
  assert.deepEqual(staleProtectedPicks({ picks, subs, now, windowMs: 7 * 86400000 }).sort(), ["gone", "old"]);
});

// ── The actions ──────────────────────────────────────────────────────────────

const NOW = Date.parse("2026-11-06T18:00:00.000Z");
const CONFIG = {
  ...outreachConfig({}),
  protectedNotBeforeMs: Date.parse("2026-11-05T00:00:00.000Z"),
  protectedSendFromMs: Date.parse("2026-11-01T00:00:00.000Z"),
  protectedWindowMs: 7 * 86400000,
  protectedSkip: new Set(["req-listed-skip"]),
};
const option = (candidateUserId, name, extra = {}) => ({
  candidateUserId, name, linkedinUser: null, roleOnRecord: false, roleRecent: false, roleAt: null, ...extra,
});
const note = (requestId, extra = {}) => ({
  requestId,
  roleId: `role-${requestId}`,
  candidateName: "Trish J.",
  companyName: "Acme",
  submitUrl: `https://www.paraform.com/company/acme/role-${requestId}/recruit/submit_candidate?from_submission_request=true&submission_request_id=${requestId}`,
  receivedAt: "2026-11-06T15:00:00.000Z",
  ...extra,
});
const heldLookup = (requestId, extra = {}) => ({
  requestId,
  version: 3,
  status: "ambiguous",
  nameForm: "initial",
  roleName: "Staff Engineer",
  companyName: "Acme",
  options: [
    option("cu-trish", "Trish Jo", { linkedinUser: "trish-jo", roleOnRecord: true, roleRecent: true, roleAt: "2026-11-06T14:54:00.000Z" }),
    option("cu-tristan", "Trish Jameson"),
  ],
  ...extra,
});

function memoryStore({ subs = [], lookups = {}, picks = {}, states = [], ownStates = {} } = {}) {
  const saved = [];
  return {
    saved,
    picks,
    store: {
      listSubs: async () => subs,
      getLookups: async () => lookups,
      getPicks: async () => picks,
      listStates: async () => states,
      getState: async (candidateUserId) => ownStates[candidateUserId] || null,
      savePick: async (record, { onlyIfAbsent, expected } = {}) => {
        if (onlyIfAbsent && picks[record.requestId]) return false;
        // Compare-and-set, as the store's EVAL does.
        if (expected && JSON.stringify(picks[record.requestId]) !== JSON.stringify(expected)) return false;
        picks[record.requestId] = record;
        saved.push({ record, onlyIfAbsent, expected });
        return true;
      },
    },
  };
}

test("the held list shows unsettled unsent notes with their options, recent picks, and counts the handled ones", () => {
  const subs = [
    note("req-held"),
    note("req-resolved"),
    note("req-sent"),
    note("req-picked"),
    note("req-old", { receivedAt: "2026-10-20T00:00:00.000Z" }),
    note("req-before-cutoff", { receivedAt: "2026-10-31T00:00:00.000Z" }),
    note("req-listed-skip"),
    note("req-new"),
  ];
  const lookups = {
    "req-held": heldLookup("req-held"),
    "req-resolved": { requestId: "req-resolved", version: 3, status: "resolved", candidateUserId: "cu-avery", roleName: "Staff Engineer", companyName: "Acme" },
    "req-sent": heldLookup("req-sent"),
    "req-picked": heldLookup("req-picked"),
  };
  const picks = {
    "req-picked": { requestId: "req-picked", action: "send", candidateUserId: "cu-trish", name: "Trish Jo", pickedBy: "staff@raydar.xyz", pickedAt: "2026-11-06T17:00:00.000Z" },
  };
  const states = [{ candidateUserId: "cu-x", matches: { "req-sent": { sentAt: "2026-11-06T16:00:00.000Z" } } }];
  const result = heldProtectedSubs({ subs, lookups, picks, states, config: CONFIG, now: NOW });
  assert.equal(result.handledAutomatically, 2, "the resolved note and the one already emailed");
  assert.deepEqual(result.items.map((item) => item.requestId), ["req-held", "req-new", "req-picked"]);
  assert.equal(result.needYou, 2);
  const held = result.items[0];
  assert.equal(held.candidateName, "Trish J.");
  assert.equal(held.roleName, "Staff Engineer");
  assert.equal(held.nameForm, "initial");
  // The words are the lookup module's own (lookupReason).
  assert.match(held.reason, /^more than one person on Paraform by that name has this role on their record/);
  assert.equal(held.lookupPending, false);
  assert.deepEqual(held.options[0], { candidateUserId: "cu-trish", name: "Trish Jo", linkedinUser: "trish-jo", roleOnRecord: true, roleRecent: true, roleAt: "2026-11-06T14:54:00.000Z", checked: true });
  assert.equal(held.pick, null);
  assert.equal(result.items[1].lookupPending, true, "not looked up yet");
  assert.equal(result.items[2].pick.pickedBy, "staff@raydar.xyz");
  assert.equal(result.items[2].delivery, null);
});

test("a send pick is saved for a signed-in person who picks one of the options, and says what happens next", async () => {
  const m = memoryStore({ subs: [note("req-held")], lookups: { "req-held": heldLookup("req-held") } });
  const result = await pickProtectedSub({
    actor: "staff@raydar.xyz",
    body: { requestId: "req-held", candidateUserId: "cu-trish", confirmation: "SEND req-held" },
    config: CONFIG,
    now: NOW,
    store: m.store,
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    ok: true,
    action: "pick-protected-sub",
    requestId: "req-held",
    pick: { action: "send", candidateUserId: "cu-trish", name: "Trish Jo", linkedinUser: "trish-jo", pickedBy: "staff@raydar.xyz", pickedAt: "2026-11-06T18:00:00.000Z" },
    next: PICK_QUEUED_MESSAGE,
  });
  assert.equal(m.saved[0].onlyIfAbsent, true);
  assert.equal(m.saved[0].record.requestId, "req-held");
});

test("a pick is refused without a person, the exact confirmation, a listed option, or a note still in the lane", async () => {
  const base = () => memoryStore({
    subs: [note("req-held"), note("req-old", { receivedAt: "2026-10-20T00:00:00.000Z" }), note("req-listed-skip")],
    lookups: { "req-held": heldLookup("req-held"), "req-old": heldLookup("req-old"), "req-listed-skip": heldLookup("req-listed-skip") },
  });
  const pick = async (body, { actor = "staff@raydar.xyz", m = base(), config = CONFIG } = {}) => {
    const result = await pickProtectedSub({ actor, body, config, now: NOW, store: m.store });
    assert.equal(m.saved.length, 0, "nothing saved");
    return [result.status, result.body.error];
  };
  const good = { requestId: "req-held", candidateUserId: "cu-trish", confirmation: "SEND req-held" };
  assert.deepEqual(await pick(good, { actor: null }), [403, "staff_sign_in_required"]);
  assert.deepEqual(await pick({ ...good, confirmation: "SEND" }), [400, "confirmation_required"]);
  assert.deepEqual(await pick({ ...good, candidateUserId: "cu-somebody-else" }), [409, "candidate_not_an_option"]);
  assert.deepEqual(await pick({ requestId: "req-nope", candidateUserId: "cu-trish", confirmation: "SEND req-nope" }), [404, "protected_sub_not_found"]);
  assert.deepEqual(await pick({ requestId: "req-old", candidateUserId: "cu-trish", confirmation: "SEND req-old" }), [409, "protected_sub_outside_window"]);
  assert.deepEqual(await pick({ requestId: "req-listed-skip", candidateUserId: "cu-trish", confirmation: "SEND req-listed-skip" }), [409, "protected_sub_on_skip_list"]);
  assert.deepEqual(await pick(good, { config: { ...CONFIG, protectedNotBeforeMs: null, protectedSendFromMs: null } }), [503, "protected_subs_off"]);
  const early = { ...CONFIG, protectedSendFromMs: Date.parse("2026-11-06T16:00:00.000Z") };
  assert.deepEqual(await pick(good, { config: early }), [409, "protected_sub_outside_window"], "before the send cutoff");
});

test("a pick is refused once the note was emailed, already picked, or matched automatically", async () => {
  const good = { requestId: "req-held", candidateUserId: "cu-trish", confirmation: "SEND req-held" };
  const run = async (overrides) => {
    const m = memoryStore({ subs: [note("req-held")], lookups: { "req-held": heldLookup("req-held") }, ...overrides });
    const result = await pickProtectedSub({ actor: "staff@raydar.xyz", body: good, config: CONFIG, now: NOW, store: m.store });
    assert.equal(m.saved.length, 0);
    return [result.status, result.body.error];
  };
  assert.deepEqual(
    await run({ states: [{ matches: { "req-held": { sentAt: "2026-11-06T16:00:00.000Z" } } }] }),
    [409, "protected_sub_already_emailed"],
  );
  assert.deepEqual(
    await run({ states: [{ matches: {}, outbox: { "match:req-held": { status: "queued" } } }] }),
    [409, "protected_sub_already_emailed"],
    "queued in the Mailroom counts",
  );
  // The states list is capped; the picked person's own state is read too.
  assert.deepEqual(
    await run({ ownStates: { "cu-trish": { matches: { "req-held": { sentAt: "2026-11-06T16:00:00.000Z" } } } } }),
    [409, "protected_sub_already_emailed"],
  );
  assert.deepEqual(
    await run({ picks: { "req-held": { requestId: "req-held", action: "send", candidateUserId: "cu-tristan" } } }),
    [409, "protected_sub_already_picked"],
  );
  assert.deepEqual(
    await run({ lookups: { "req-held": heldLookup("req-held", { status: "resolved", candidateUserId: "cu-tristan" }) } }),
    [409, "protected_sub_resolved_elsewhere"],
  );
  assert.deepEqual(
    await run({ lookups: { "req-held": heldLookup("req-held", { status: "resolved", candidateUserId: "cu-trish" }) } }),
    [409, "protected_sub_resolved_automatically"],
  );
  assert.deepEqual(
    await run({ lookups: { "req-held": heldLookup("req-held", { status: "role_inactive" }) } }),
    [409, "role_not_active"],
  );
});

test("two people picking at once: only the first is saved", async () => {
  const m = memoryStore({ subs: [note("req-held")], lookups: { "req-held": heldLookup("req-held") } });
  // The second reads before the first writes, so only HSETNX stops it.
  const realGetPicks = m.store.getPicks;
  m.store.getPicks = async () => ({});
  const first = await pickProtectedSub({ actor: "a@raydar.xyz", body: { requestId: "req-held", candidateUserId: "cu-trish", confirmation: "SEND req-held" }, config: CONFIG, now: NOW, store: m.store });
  const second = await pickProtectedSub({ actor: "b@raydar.xyz", body: { requestId: "req-held", candidateUserId: "cu-tristan", confirmation: "SEND req-held" }, config: CONFIG, now: NOW, store: m.store });
  m.store.getPicks = realGetPicks;
  assert.equal(first.status, 200);
  assert.deepEqual([second.status, second.body.error], [409, "protected_sub_already_picked"]);
  assert.equal(m.picks["req-held"].candidateUserId, "cu-trish");
});

test("skip saves a skip pick, can stop an unsent send pick, and a skipped note can still be picked", async () => {
  const m = memoryStore({ subs: [note("req-held")], lookups: { "req-held": heldLookup("req-held") } });
  const refused = await skipProtectedSub({ actor: "staff@raydar.xyz", body: { requestId: "req-held", confirmation: "SEND req-held" }, config: CONFIG, now: NOW, store: m.store });
  assert.deepEqual([refused.status, refused.body.error], [400, "confirmation_required"]);
  const runner = await skipProtectedSub({ actor: null, body: { requestId: "req-held", confirmation: "SKIP req-held" }, config: CONFIG, now: NOW, store: m.store });
  assert.deepEqual([runner.status, runner.body.error], [403, "staff_sign_in_required"]);
  const skipped = await skipProtectedSub({ actor: "staff@raydar.xyz", body: { requestId: "req-held", confirmation: "SKIP req-held" }, config: CONFIG, now: NOW, store: m.store });
  assert.equal(skipped.status, 200);
  assert.equal(skipped.body.pick.action, "skip");
  assert.equal(m.picks["req-held"].action, "skip");
  const again = await skipProtectedSub({ actor: "staff@raydar.xyz", body: { requestId: "req-held", confirmation: "SKIP req-held" }, config: CONFIG, now: NOW, store: m.store });
  assert.deepEqual([again.status, again.body.error], [409, "protected_sub_already_skipped"]);
  // Changing their mind: a send over the skip replaces it.
  const picked = await pickProtectedSub({ actor: "staff@raydar.xyz", body: { requestId: "req-held", candidateUserId: "cu-trish", confirmation: "SEND req-held" }, config: CONFIG, now: NOW, store: m.store });
  assert.equal(picked.status, 200);
  assert.equal(m.saved.at(-1).expected.action, "skip", "replaces only the skip it read");
  assert.equal(m.picks["req-held"].replaced.action, "skip");
  // And stopping that send before it goes is allowed.
  const stopped = await skipProtectedSub({ actor: "staff@raydar.xyz", body: { requestId: "req-held", confirmation: "SKIP req-held" }, config: CONFIG, now: NOW, store: m.store });
  assert.equal(stopped.status, 200);
  assert.equal(m.picks["req-held"].action, "skip");
  // Not once it was emailed.
  const sent = memoryStore({
    subs: [note("req-held")],
    lookups: { "req-held": heldLookup("req-held") },
    picks: { "req-held": { requestId: "req-held", action: "send", candidateUserId: "cu-trish" } },
    ownStates: { "cu-trish": { matches: { "req-held": { sentAt: "2026-11-06T18:01:00.000Z" } } } },
  });
  const late = await skipProtectedSub({ actor: "staff@raydar.xyz", body: { requestId: "req-held", confirmation: "SKIP req-held" }, config: CONFIG, now: NOW, store: sent.store });
  assert.deepEqual([late.status, late.body.error], [409, "protected_sub_already_emailed"]);
});

test("only a signed-in person is a picker: never a runner bearer, never an open (unconfigured) sign-in", () => {
  assert.equal(staffActor({ automationBearer: true, authedEmail: "staff@raydar.xyz" }), null);
  assert.equal(staffActor({}), null);
  assert.equal(staffActor({ authedEmail: "Staff@Raydar.xyz" }), "staff@raydar.xyz");
  assert.deepEqual([...protectedDeliveries([{ matches: { a: { sentAt: "x" } }, outbox: { "match:b": { status: "claimed" }, "match:c": { status: "failed" } } }])], [["a", "sent"], ["b", "queued"]]);
});

// ── Through the handler ──────────────────────────────────────────────────────

function responseRecorder() {
  return {
    statusCode: null,
    body: null,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

test("the handler refuses a pick or skip from the runner bearer, and from an unsigned request when sign-in is off", async () => {
  for (const body of [
    { action: "pick-protected-sub", requestId: "req-held", candidateUserId: "cu-trish", confirmation: "SEND req-held" },
    { action: "skip-protected-sub", requestId: "req-held", confirmation: "SKIP req-held" },
  ]) {
    const runner = responseRecorder();
    await handler({ method: "POST", headers: { authorization: "Bearer runner-test-secret" }, body }, runner);
    assert.equal(runner.statusCode, 403, body.action);
    assert.equal(runner.body.error, "staff_sign_in_required");
    // No GOOGLE_CLIENT_ID here, so requireAuth lets it in with no email: still no pick.
    const open = responseRecorder();
    await handler({ method: "POST", headers: {}, body }, open);
    assert.equal(open.statusCode, 403, body.action);
    assert.equal(open.body.error, "staff_sign_in_required");
  }
  assert.deepEqual(hashes.get("paraai:outreach:protected:picks"), undefined, "nothing written");
  assert.deepEqual(providerCalls, []);
});

test("the handler lists held notes for the runner bearer too (read-only)", async () => {
  // The handler reads the real clock, so the note is dated from it.
  const receivedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  hashes.set("paraai:outreach:protected:subs", { "req-held": JSON.stringify(note("req-held", { receivedAt })) });
  hashes.set("paraai:outreach:protected:lookup", { "req-held": JSON.stringify(heldLookup("req-held")) });
  const previous = { ...process.env };
  process.env.PARAAI_PROTECTED_SUBS_NOT_BEFORE = new Date(Date.now() - 2 * 86400000).toISOString();
  try {
    const res = responseRecorder();
    await handler({ method: "POST", headers: { authorization: "Bearer runner-test-secret" }, body: { action: "list-protected-held" } }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.action, "list-protected-held");
    assert.equal(res.body.laneOn, true);
    assert.deepEqual(res.body.items.map((item) => item.requestId), ["req-held"]);
    assert.equal(res.body.items[0].options.length, 2);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});

// ── The tick ─────────────────────────────────────────────────────────────────

const openOutreachConfig = () => ({
  ...outreachConfig({}),
  approved: true,
  sendApproved: true,
  dryRun: false,
  notBeforeMs: Date.parse("2026-12-01T00:00:00.000Z"),
  protectedNotBeforeMs: Date.parse("2026-11-04T17:46:07.000Z"),
  gmailConfigured: true,
  storeConfigured: true,
  mailbox: "david@raydar.xyz",
});
const tickSubs = () => new Map([
  ["req-held", note("req-held", { receivedAt: "2026-11-04T18:05:00.000Z" })],
  ["req-auto", note("req-auto", { receivedAt: "2026-11-04T18:05:00.000Z", candidateName: "Avery Quill" })],
]);

test("the tick reads picks, passes them to the rows and the lookups, and prunes picks for notes gone", async () => {
  let rowsWith = null;
  let lookedWith = null;
  let pruned = null;
  let watchedWith = null;
  const picks = {
    "req-held": { requestId: "req-held", action: "send", candidateUserId: "cu-trish", name: "Trish Jo", pickedBy: "staff@raydar.xyz", pickedAt: "2026-11-04T19:00:00.000Z" },
    "req-gone": { requestId: "req-gone", action: "skip", pickedBy: "staff@raydar.xyz", pickedAt: "2026-11-04T19:00:00.000Z" },
  };
  const lookupModule = await import("../api/paraai/_lib/outreach-protected-lookup.mjs");
  const result = await runOutreachTick({
    config: openOutreachConfig(),
    now: Date.parse("2026-11-04T19:10:00.000Z"),
    pauseState: async () => ({ paused: false }),
    historyImpl: async () => [],
    protectedScanImpl: async () => ({ scanned: true, subs: tickSubs(), added: [], unparsed: [] }),
    protectedMatchRecordImpl: async () => {},
    protectedLookupsReadImpl: async () => ({
      "req-held": heldLookup("req-held"),
      "req-auto": { requestId: "req-auto", version: 3, status: "resolved", candidateUserId: "cu-avery", roleName: "Staff Engineer", companyName: "Acme" },
    }),
    protectedPicksReadImpl: async () => picks,
    protectedPicksPruneImpl: async (ids) => { pruned = ids; },
    protectedLookupImpl: async (options) => { lookedWith = options; return { looked: 0, lookups: {} }; },
    protectedWatchImpl: async (options) => { watchedWith = options; return []; },
    replyPassImpl: async (options) => { rowsWith = options; return { enabled: true }; },
  });
  assert.equal(lookedWith.picks, picks, "the lookups get the picks, so a picked note is not looked up again");
  assert.equal(watchedWith.picks, picks, "the unsent watch gets the picks, so a skipped note does not page");
  assert.deepEqual(pruned, ["req-gone"]);
  assert.deepEqual(rowsWith.history, [], "no protected row reaches the reply pass");
  // The resolved note is a row whatever the lookup module does with picks.
  assert.ok(result.results.some((item) => item.requestId === "req-auto"));
  // The "send" pick makes the held note a row (via staff_pick), counted.
  assert.ok(result.results.some((item) => item.requestId === "req-held"));
  assert.equal(result.protectedSubs.rows, 2);
  assert.equal(result.protectedSubs.pickedRows, 1);
  const rows = lookupModule.syntheticProtectedRequests({
    subs: tickSubs(), lookups: { "req-held": heldLookup("req-held") }, picks, notBeforeMs: 0, now: Date.parse("2026-11-04T19:10:00.000Z"),
  });
  assert.equal(rows[0].protectedSub.via, "staff_pick");
  assert.equal(rows[0].candidateUserId, "cu-trish");
});

test("an unreadable picks store makes no protected rows that tick, runs no lookups and no unsent watch, and prunes nothing", async () => {
  // 2026-11-06 review: without picks the lookups would re-look decided
  // notes and the watch would spend a skipped note's one alert.
  let lookedWith = null;
  let watched = false;
  let pruned = false;
  const result = await runOutreachTick({
    config: openOutreachConfig(),
    now: Date.parse("2026-11-04T19:10:00.000Z"),
    pauseState: async () => ({ paused: false }),
    historyImpl: async () => [],
    protectedScanImpl: async () => ({ scanned: true, subs: tickSubs(), added: [], unparsed: [] }),
    protectedMatchRecordImpl: async () => {},
    protectedLookupsReadImpl: async () => ({
      "req-auto": { requestId: "req-auto", version: 3, status: "resolved", candidateUserId: "cu-avery", roleName: "Staff Engineer", companyName: "Acme" },
    }),
    protectedPicksReadImpl: async () => { throw new Error("store down"); },
    protectedPicksPruneImpl: async () => { pruned = true; },
    protectedLookupImpl: async (options) => { lookedWith = options; return { looked: 0, lookups: {} }; },
    protectedWatchImpl: async () => { watched = true; return []; },
    replyPassImpl: async () => ({ enabled: true }),
  });
  assert.deepEqual(result.results.filter((item) => item.requestId), [], "a skip a person chose must never be missed");
  assert.equal(result.protectedSubs.rows, 0);
  assert.equal(result.protectedSubs.picksError, "picks_store_unreadable");
  assert.equal(lookedWith, null);
  assert.equal(watched, false);
  assert.equal(pruned, false);
});

// ── The unsent watch ─────────────────────────────────────────────────────────

test("the unsent page links the pick page for a note the lookup did not settle, and only then", async () => {
  const alerts = [];
  const subs = new Map([
    ["req-held", note("req-held", { receivedAt: "2026-11-06T15:00:00.000Z" })],
    ["req-row", note("req-row", { receivedAt: "2026-11-06T15:00:00.000Z" })],
  ]);
  await watchUnsentProtectedSubs({
    subs,
    history: [{ id: "req-row", status: "submitted" }],
    lookups: { "req-held": heldLookup("req-held") },
    now: NOW,
    claimImpl: async () => true,
    notifyImpl: async (text) => { alerts.push(text); return true; },
  });
  assert.equal(alerts.length, 2);
  assert.ok(alerts[0].endsWith(`\nPick the right person: ${PROTECTED_PICKS_PAGE_URL}`));
  assert.equal(PROTECTED_PICKS_PAGE_URL, "https://monitor.raydar.xyz/protected-subs.html");
  assert.ok(!alerts[1].includes("Pick the right person"));
  assert.ok(!alerts.some((text) => /@/.test(text)), "no email address in Slack");
});

test("a note staff skipped does not page as unsent; a send pick still does until it goes", async () => {
  const alerts = [];
  const claimed = [];
  const subs = new Map([
    ["req-skipped", note("req-skipped", { receivedAt: "2026-11-06T15:00:00.000Z" })],
    ["req-picked", note("req-picked", { receivedAt: "2026-11-06T15:00:00.000Z" })],
  ]);
  const alerted = await watchUnsentProtectedSubs({
    subs,
    lookups: { "req-skipped": heldLookup("req-skipped"), "req-picked": heldLookup("req-picked") },
    picks: {
      "req-skipped": { requestId: "req-skipped", action: "skip", pickedBy: "staff@raydar.test" },
      "req-picked": { requestId: "req-picked", action: "send", candidateUserId: "cu-avery", pickedBy: "staff@raydar.test" },
    },
    now: NOW,
    claimImpl: async (key) => { claimed.push(key); return true; },
    notifyImpl: async (text) => { alerts.push(text); return true; },
  });
  assert.deepEqual(alerted.map((row) => row.requestId), ["req-picked"]);
  assert.deepEqual(claimed, ["unsent:req-picked"], "a skipped note never uses its one alert");
  assert.equal(alerts.length, 1);
});

// ── Review fixes (2026-11-06) ────────────────────────────────────────────────

test("review fix: replacing a pick is compare-and-set on the pick that was read", async () => {
  const hash = new Map();
  const calls = [];
  const kvImpl = async (args) => {
    calls.push(args);
    const [name] = args;
    if (name === "HGET") return hash.get(args[2]) ?? null;
    if (name === "HSETNX") { if (hash.has(args[2])) return 0; hash.set(args[2], args[3]); return 1; }
    if (name === "EVAL") {
      const [, script, keyCount, key, field, expected, value] = args;
      assert.equal(keyCount, "1");
      assert.equal(key, "paraai:outreach:protected:picks");
      assert.match(script, /HGET/);
      if (hash.get(field) !== expected) return 0;
      hash.set(field, value);
      return 1;
    }
    throw new Error(`unexpected ${name}`);
  };
  const skip = { requestId: "req-a", action: "skip", candidateUserId: null, name: null, linkedinUser: null, pickedBy: "a@raydar.xyz", pickedAt: "2026-11-06T18:00:00.000Z" };
  assert.equal(await saveProtectedPick(skip, { kvImpl, onlyIfAbsent: true }), true);
  const read = (await getProtectedPicks({ kvImpl: async () => [...hash.entries()].flat() }))["req-a"];
  const toX = { requestId: "req-a", action: "send", candidateUserId: "cu-x", pickedBy: "a@raydar.xyz", pickedAt: "2026-11-06T18:01:00.000Z" };
  const toY = { ...toX, candidateUserId: "cu-y", pickedBy: "b@raydar.xyz" };
  // Both read the same skip; only the first replacement lands.
  assert.equal(await saveProtectedPick(toX, { kvImpl, expected: read }), true);
  assert.equal(await saveProtectedPick(toY, { kvImpl, expected: read }), false);
  assert.equal((await getProtectedPick("req-a", { kvImpl })).candidateUserId, "cu-x");
  assert.equal(await getProtectedPick("req-none", { kvImpl }), null);
});

test("review fix: two people replacing a skip at once: only the first wins, the second is told", async () => {
  const skip = { requestId: "req-held", action: "skip", candidateUserId: null, pickedBy: "c@raydar.xyz", pickedAt: "2026-11-06T17:00:00.000Z" };
  const m = memoryStore({ subs: [note("req-held")], lookups: { "req-held": heldLookup("req-held") }, picks: { "req-held": skip } });
  // Both read the skip before either writes.
  m.store.getPicks = async () => ({ "req-held": skip });
  const [first, second] = await Promise.all([
    pickProtectedSub({ actor: "a@raydar.xyz", body: { requestId: "req-held", candidateUserId: "cu-trish", confirmation: "SEND req-held" }, config: CONFIG, now: NOW, store: m.store }),
    pickProtectedSub({ actor: "b@raydar.xyz", body: { requestId: "req-held", candidateUserId: "cu-tristan", confirmation: "SEND req-held" }, config: CONFIG, now: NOW, store: m.store }),
  ]);
  assert.equal(first.status, 200);
  assert.deepEqual([second.status, second.body.error], [409, "protected_sub_already_picked"]);
  assert.equal(m.picks["req-held"].candidateUserId, "cu-trish");
});

test("review fix: a pick over a skip checks the person the skip replaced, and a skip checks the automatically matched person", async () => {
  const skip = { requestId: "req-held", action: "skip", pickedBy: "c@raydar.xyz", pickedAt: "2026-11-06T17:00:00.000Z", replaced: { action: "send", candidateUserId: "cu-tristan" } };
  const m = memoryStore({
    subs: [note("req-held")],
    lookups: { "req-held": heldLookup("req-held") },
    picks: { "req-held": skip },
    ownStates: { "cu-tristan": { outbox: { "match:req-held": { status: "claimed", requestId: "req-held" } } } },
  });
  const result = await pickProtectedSub({ actor: "a@raydar.xyz", body: { requestId: "req-held", candidateUserId: "cu-trish", confirmation: "SEND req-held" }, config: CONFIG, now: NOW, store: m.store });
  assert.deepEqual([result.status, result.body.error], [409, "protected_sub_already_emailed"]);
  const auto = memoryStore({
    subs: [note("req-auto")],
    lookups: { "req-auto": { requestId: "req-auto", version: 3, status: "resolved", candidateUserId: "cu-avery", roleName: "Staff Engineer", companyName: "Acme" } },
    ownStates: { "cu-avery": { outbox: { "match:req-auto": { status: "claimed", requestId: "req-auto" } } } },
  });
  const skipped = await skipProtectedSub({ actor: "a@raydar.xyz", body: { requestId: "req-auto", confirmation: "SKIP req-auto" }, config: CONFIG, now: NOW, store: auto.store });
  assert.deepEqual([skipped.status, skipped.body.error], [409, "protected_sub_already_emailed"]);
  assert.equal(auto.saved.length, 0);
});

test("review fix: the held list says when a role was not checked, and why a send pick will not go", () => {
  const subs = [note("req-many"), note("req-blocked", { roleId: "role-x" })];
  const lookups = {
    "req-many": heldLookup("req-many", { status: "too_many", options: [{ ...option("cu-1", "Avery Quill"), checked: false }] }),
    "req-blocked": heldLookup("req-blocked"),
  };
  const picks = { "req-blocked": { requestId: "req-blocked", action: "send", candidateUserId: "cu-trish", name: "Trish Jo", pickedBy: "staff@raydar.xyz", pickedAt: "2026-11-06T17:00:00.000Z" } };
  const states = [{ candidateUserId: "cu-trish", matches: { other: { requestId: "other", roleId: "role-x", sentAt: "2026-11-05T00:00:00.000Z" } } }];
  const result = heldProtectedSubs({ subs, lookups, picks, states, config: CONFIG, now: NOW });
  const many = result.items.find((item) => item.requestId === "req-many");
  assert.equal(many.options[0].checked, false);
  assert.equal(many.pickBlocked, null);
  const blocked = result.items.find((item) => item.requestId === "req-blocked");
  assert.match(blocked.pickBlocked, /already emailed about this role/);
});

test("review fix: a send-picked note with no row pages why it did not send, without the pick link", async () => {
  const alerts = [];
  const sub = note("req-picked", { receivedAt: "2026-11-06T15:00:00.000Z", roleId: "role-x" });
  const alerted = await watchUnsentProtectedSubs({
    subs: new Map([["req-picked", sub]]),
    lookups: { "req-picked": heldLookup("req-picked", { status: "too_many" }) },
    picks: { "req-picked": { requestId: "req-picked", action: "send", candidateUserId: "cu-trish", name: "Trish Jo", pickedBy: "staff@raydar.test" } },
    states: [{ candidateUserId: "cu-trish", matches: { other: { requestId: "other", roleId: "role-x", sentAt: "2026-11-05T00:00:00.000Z" } } }],
    now: NOW,
    claimImpl: async () => true,
    notifyImpl: async (text) => { alerts.push(text); return true; },
  });
  assert.match(alerted[0].why, /^staff picked Trish Jo, but it was not sent because that person was already emailed about this role/);
  assert.ok(!alerts[0].includes("Pick the right person"));
  assert.ok(!alerts[0].includes("held for a staff pick"));
});

test("review fix: a signed-in pick or skip must come from the dashboard's own origin", async () => {
  const body = { action: "skip-protected-sub", requestId: "req-held", confirmation: "SKIP req-held" };
  const sibling = responseRecorder();
  await handler({ method: "POST", authedEmail: "staff@raydar.xyz", headers: { origin: "https://www.raydar.xyz", host: "monitor.raydar.xyz" }, body: JSON.stringify(body) }, sibling);
  assert.deepEqual([sibling.statusCode, sibling.body.error], [403, "same_origin_required"]);
  const own = responseRecorder();
  await handler({ method: "POST", authedEmail: "staff@raydar.xyz", headers: { origin: "https://monitor.raydar.xyz", host: "monitor.raydar.xyz" }, body }, own);
  assert.notEqual(own.body.error, "same_origin_required");
  assert.deepEqual(hashes.get("paraai:outreach:protected:picks"), undefined, "nothing written");
  assert.deepEqual(providerCalls, []);
});

// The page's own render functions, run in a sandbox (no network, no DOM).
async function loadPage() {
  const { readFile } = await import("node:fs/promises");
  const vm = await import("node:vm");
  const html = await readFile(new URL("../protected-subs.html", import.meta.url), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\ninit\(\);\s*$/, "\n");
  const element = () => ({ addEventListener() {}, set onclick(_) {}, textContent: "", innerHTML: "", className: "" });
  const elements = new Map();
  const context = vm.createContext({
    document: { getElementById: (id) => elements.get(id) || elements.set(id, element()).get(id), querySelectorAll: () => [] },
    location: { origin: "https://monitor.raydar.xyz", href: "https://monitor.raydar.xyz/protected-subs.html" },
    URL,
  });
  vm.runInContext(script, context);
  return context;
}

test("review fix: the page labels old links with their year, unchecked roles as not checked, and warns in the send confirm", async () => {
  const page = await loadPage();
  const item = { requestId: "req-held", candidateName: "Trish J.", companyName: "Acme", roleName: "Staff Engineer", status: "incomplete", reason: "the search did not finish", options: [], pick: null, delivery: null };
  const recent = option("cu-1", "Trish Jo", { roleOnRecord: true, roleRecent: true, roleAt: "2026-11-06T14:54:00.000Z", linkedinUser: "trish-jo" });
  const old = option("cu-2", "Trish Jo", { roleOnRecord: true, roleRecent: false, roleAt: "2025-11-03T18:00:00.000Z" });
  const unchecked = { ...option("cu-3", "Trish Jameson"), checked: false };
  assert.match(page.optionRow(item, recent, 0, true), /class="on">on this role on Paraform since Nov 6, 2026/);
  assert.match(page.optionRow(item, old, 1, true), /had this role before, dated Nov 3, 2025/);
  assert.doesNotMatch(page.optionRow(item, old, 1, true), /class="on"/);
  assert.match(page.optionRow(item, unchecked, 2, true), /role not checked/);
  assert.match(page.optionRow(item, option("cu-4", "Trish Jun"), 3, true), /not on this role/);
  assert.match(page.confirmSendText(item, recent), /Staff Engineer at Acme[\s\S]*LinkedIn: trish-jo/);
  assert.doesNotMatch(page.confirmSendText(item, recent), /Warning/);
  assert.match(page.confirmSendText(item, old), /Warning: this person's link to this role is old/);
  assert.match(page.confirmSendText(item, unchecked), /Warning: this person is NOT shown on this role/);
  assert.match(page.card({ ...item, options: [unchecked] }), /this list may be missing people/);
});

test("review fix: the page can stop an unsent send pick, re-pick a skip, and never promises a send that will not go", async () => {
  const page = await loadPage();
  const options = [option("cu-1", "Trish Jo", { roleOnRecord: true, roleRecent: true })];
  const base = { requestId: "req-held", candidateName: "Trish J.", companyName: "Acme", options, delivery: null };
  const justNow = new Date(Date.now() - 60_000).toISOString();
  const sendPick = { action: "send", candidateUserId: "cu-1", name: "Trish Jo", pickedBy: "staff@raydar.xyz", pickedAt: justNow };
  const picked = page.card({ ...base, pick: sendPick });
  assert.match(picked, /data-stop="1"[^>]*>Stop this send/);
  assert.doesNotMatch(picked, /data-send=/);
  assert.match(picked, /sends within about 5 minutes/);
  assert.doesNotMatch(page.card({ ...base, pick: sendPick, delivery: "queued" }), /Stop this send/);
  const skipped = page.card({ ...base, pick: { action: "skip", pickedBy: "staff@raydar.xyz", pickedAt: justNow } });
  assert.match(skipped, /data-send="req-held"/);
  assert.doesNotMatch(skipped, /Skip this note/);
  assert.match(page.pickLine({ ...base, pick: sendPick, pickBlocked: "that person was already emailed about this role under another request" }), /will not send: that person was already emailed/);
  assert.match(page.pickLine({ ...base, pick: { ...sendPick, pickedAt: new Date(Date.now() - 20 * 60_000).toISOString() } }), /not sent yet/);
  page.render({ items: [], outreachOpen: false });
  assert.match(page.pickLine({ ...base, pick: sendPick }), /outreach lane is shut/);
  page.render({ items: [], outreachOpen: true });
  assert.match(page.pickLine({ ...base, pick: sendPick }), /sends within about 5 minutes/);
});

// ── Second review (2026-11-06) ───────────────────────────────────────────────

test("second review: the tick does not work a row of Paraform's own read whose note staff skipped", async () => {
  const inRead = {
    id: "req-held",
    status: "pending",
    candidateUserId: "cu-trish",
    candidateName: "Trish J.",
    roleId: "role-req-held",
    roleName: "Staff Engineer",
    companyName: "Acme",
    createdAt: "2026-11-04T18:00:00.000Z",
    createdAtMs: Date.parse("2026-11-04T18:00:00.000Z"),
    reachedOut: false,
    reachedOutAt: null,
    reachedOutAtMs: null,
    recipientTypes: [],
    ownRequest: true,
  };
  // Each run is its own tick: the tick's slot in the fake KV is cleared.
  const run = (picks) => {
    kvStore.clear();
    return runOutreachTick({
      config: { ...openOutreachConfig(), protectedSkip: new Set(["req-listed-skip"]) },
      now: Date.parse("2026-11-04T19:10:00.000Z"),
      pauseState: async () => ({ paused: false }),
      historyImpl: async () => [{ ...inRead }],
      protectedScanImpl: async () => ({ scanned: true, subs: new Map([["req-held", note("req-held", { receivedAt: "2026-11-04T18:05:00.000Z" })]]), added: [], unparsed: [] }),
      protectedMatchRecordImpl: async () => {},
      protectedLookupsReadImpl: async () => ({}),
      protectedPicksReadImpl: async () => picks,
      protectedPicksPruneImpl: async () => {},
      protectedLookupImpl: async () => ({ looked: 0, lookups: {} }),
      protectedWatchImpl: async (options) => { watchedWith = options; return []; },
      replyPassImpl: async () => ({ enabled: true }),
    });
  };
  let watchedWith = null;
  const skipped = await run({ "req-held": { requestId: "req-held", action: "skip", pickedBy: "staff@raydar.xyz", pickedAt: "2026-11-04T19:00:00.000Z" } });
  assert.deepEqual(skipped.results.filter((item) => item.requestId), [], "a skipped note's own Paraform row is not worked");
  // The watch is told the skip list and the send cutoff, for its pick link.
  assert.ok(watchedWith.skip.has("req-listed-skip"));
  assert.equal(watchedWith.sendFromMs, Date.parse("2026-11-04T17:46:07.000Z"));
  const other = await run({ "req-held": { requestId: "req-held", action: "send", candidateUserId: "cu-other", pickedBy: "staff@raydar.xyz", pickedAt: "2026-11-04T19:00:00.000Z" } });
  assert.deepEqual(other.results.filter((item) => item.requestId), [], "nor one staff picked someone else for");
  // With no pick it is worked as before.
  const open = await run({});
  assert.deepEqual(open.results.filter((item) => item.requestId).map((item) => item.requestId), ["req-held"]);
});

test("second review: a skip holds the send path's candidate lock, and is refused while a send holds it", async () => {
  const { acquireOutreachLock, releaseOutreachLock } = await import("../api/paraai/_lib/outreach-store.mjs");
  const sendPick = { requestId: "req-held", action: "send", candidateUserId: "cu-trish", name: "Trish Jo", pickedBy: "a@raydar.xyz", pickedAt: "2026-11-06T17:00:00.000Z" };
  const m = memoryStore({ subs: [note("req-held")], lookups: { "req-held": heldLookup("req-held") }, picks: { "req-held": { ...sendPick } } });
  // A tick is mid-send for the picked person (processMatchRequest's lock).
  const sendToken = await acquireOutreachLock("cu-trish");
  assert.ok(sendToken);
  const busy = await skipProtectedSub({ actor: "b@raydar.xyz", body: { requestId: "req-held", confirmation: "SKIP req-held" }, config: CONFIG, now: NOW, store: m.store });
  assert.deepEqual([busy.status, busy.body.error], [409, "protected_sub_busy"]);
  assert.equal(m.saved.length, 0, "nothing saved while the send may be claiming");
  assert.equal(m.picks["req-held"].action, "send");
  await releaseOutreachLock("cu-trish", sendToken);
  // The state is read under the lock: a claim the send saved is seen.
  let lockedWhileReading = null;
  const realGetState = m.store.getState;
  m.store.getState = async (id) => {
    lockedWhileReading = [...kvStore.keys()].some((key) => key.startsWith("paraai:outreach:lock:"));
    return realGetState(id);
  };
  const skipped = await skipProtectedSub({ actor: "b@raydar.xyz", body: { requestId: "req-held", confirmation: "SKIP req-held" }, config: CONFIG, now: NOW, store: m.store });
  assert.equal(skipped.status, 200);
  assert.equal(lockedWhileReading, true, "the person's state is checked under their lock");
  assert.equal(m.picks["req-held"].action, "skip");
  // And the lock is released after.
  const after = await acquireOutreachLock("cu-trish");
  assert.ok(after, "the skip released the lock");
  await releaseOutreachLock("cu-trish", after);
  // A note with nobody to email (no pick, not resolved) needs no lock.
  const plain = memoryStore({ subs: [note("req-plain")], lookups: { "req-plain": heldLookup("req-plain") } });
  const locks = [];
  const plainSkip = await skipProtectedSub({ actor: "b@raydar.xyz", body: { requestId: "req-plain", confirmation: "SKIP req-plain" }, config: CONFIG, now: NOW, store: { ...plain.store, lock: async (id) => { locks.push(id); return "t"; } } });
  assert.equal(plainSkip.status, 200);
  assert.deepEqual(locks, []);
});

test("second review: the unsent page links the pick page only for a note that page lists, and never pages a do-not-send note", async () => {
  const alerts = [];
  const subs = new Map([
    ["req-resolved", note("req-resolved", { receivedAt: "2026-11-06T15:00:00.000Z", roleId: "role-x" })],
    ["req-listed-skip", note("req-listed-skip", { receivedAt: "2026-11-06T15:00:00.000Z" })],
    ["req-early", note("req-early", { receivedAt: "2026-11-06T15:00:00.000Z" })],
    ["req-held", note("req-held", { receivedAt: "2026-11-06T16:00:00.000Z" })],
  ]);
  const alerted = await watchUnsentProtectedSubs({
    subs,
    lookups: {
      "req-resolved": { requestId: "req-resolved", version: 3, status: "resolved", candidateUserId: "cu-avery", roleName: "Staff Engineer", companyName: "Acme" },
      "req-listed-skip": heldLookup("req-listed-skip", { status: "not_found" }),
      "req-early": heldLookup("req-early"),
      "req-held": heldLookup("req-held"),
    },
    states: [{ candidateUserId: "cu-avery", matches: { other: { requestId: "other", roleId: "role-x", sentAt: "2026-11-05T00:00:00.000Z" } } }],
    skip: new Set(["req-listed-skip"]),
    // The page lists from here: req-early is before it.
    sendFromMs: Date.parse("2026-11-06T15:30:00.000Z"),
    now: NOW,
    claimImpl: async () => true,
    notifyImpl: async (text) => { alerts.push(text); return true; },
  });
  assert.deepEqual(alerted.map((row) => row.requestId), ["req-resolved", "req-early", "req-held"], "the do-not-send note never pages");
  assert.match(alerted[0].why, /already emailed about this role under another request/);
  assert.ok(!alerts[0].includes("Pick the right person"), "a resolved note is not on the page");
  assert.ok(!alerts[1].includes("Pick the right person"), "a note before the send cutoff is not on the page");
  assert.ok(alerts[2].endsWith(`\nPick the right person: ${PROTECTED_PICKS_PAGE_URL}`));
});

test("second review: a skipped note that was emailed anyway never reads as skipped on the page", async () => {
  const page = await loadPage();
  const base = { requestId: "req-held", candidateName: "Trish J.", companyName: "Acme", options: [] };
  const skip = { action: "skip", pickedBy: "staff@raydar.xyz", pickedAt: new Date().toISOString() };
  assert.match(page.pickLine({ ...base, pick: skip, delivery: "sent" }), /Skipped by staff@raydar\.xyz, but the email had already gone out/);
  assert.match(page.pickLine({ ...base, pick: skip, delivery: "queued" }), /already been queued/);
  assert.match(page.pickLine({ ...base, pick: skip, delivery: null }), /class="done skipped">Skipped by/);
});
