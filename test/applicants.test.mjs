import test from "node:test";
import assert from "node:assert/strict";

import { PROFILE_TTL_SECONDS, validKey } from "../api/applicants/_lib/kv.mjs";
import {
  createSyncHandler,
  MAX_PROFILE_BYTES,
  MAX_SNAPSHOT_BYTES,
  normalizeAcks,
  normalizeProfiles,
} from "../api/applicants/sync.mjs";
import { createDecisionHandler } from "../api/applicants/decision.mjs";
import { createFeedHandler } from "../api/applicants/feed.mjs";

const SAVED_SYNC_KEY = process.env.APPHUB_SYNC_KEY;
const KEY = "apphub-sync-key-0000000000000000001";

test.after(() => {
  if (SAVED_SYNC_KEY === undefined) delete process.env.APPHUB_SYNC_KEY;
  else process.env.APPHUB_SYNC_KEY = SAVED_SYNC_KEY;
});

// `authorization: null` omits the header entirely (undefined would fall back
// to the default valid bearer via destructuring).
function request({ method = "POST", authorization = `Bearer ${KEY}`, body } = {}) {
  return {
    method,
    headers: authorization === null ? {} : { authorization },
    body,
  };
}

function response() {
  return {
    body: undefined,
    headers: {},
    statusCode: undefined,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    status(value) {
      this.statusCode = value;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
    end() {},
  };
}

function fakeStore(initial = {}) {
  const calls = { readHash: [], writeHash: [], writeJson: [] };
  return {
    calls,
    deps: {
      kvReady: () => true,
      readHash: async (key) => {
        calls.readHash.push(key);
        return initial[key] || {};
      },
      writeHash: async (key, fields) => {
        calls.writeHash.push([key, fields]);
        return Object.keys(fields).length;
      },
      writeJson: async (key, value, ttlSeconds) => {
        calls.writeJson.push([key, value, ttlSeconds]);
        return "OK";
      },
      now: () => "2026-08-09T00:00:00.000Z",
    },
  };
}

test("applicant keys are `<cuId>:<roleId>` and nothing else", () => {
  for (const key of [
    "cutestsynthetic0000000001:cmqvf861b00040aksj38cyiwp",
    "abc123:DEF456",
    "a:b",
  ]) {
    assert.equal(validKey(key), true, key);
  }
  for (const key of [
    "", "abc", ":", "abc:", ":def", "a:b:c", "a_b:c", "a:b c", "a-b:c",
    `${"x".repeat(130)}:y`, null, undefined, 42,
  ]) {
    assert.equal(validKey(key), false, String(key));
  }
});

test("sync answers 401 with no detail on a missing, wrong, or unconfigured key", async () => {
  const { calls, deps } = fakeStore();
  const handler = createSyncHandler(deps);

  delete process.env.APPHUB_SYNC_KEY;
  const unconfigured = response();
  await handler(request({ body: { snapshot: {} } }), unconfigured);
  assert.equal(unconfigured.statusCode, 401);
  assert.deepEqual(unconfigured.body, { ok: false, error: "unauthorized" });

  process.env.APPHUB_SYNC_KEY = KEY;
  for (const authorization of [
    null,
    "",
    `Bearer ${KEY.slice(0, -1)}x`,
    `bearer ${KEY}`,
    `Bearer ${KEY} `,
  ]) {
    const res = response();
    await handler(request({ authorization, body: { snapshot: {} } }), res);
    assert.equal(res.statusCode, 401, String(authorization));
    assert.deepEqual(res.body, { ok: false, error: "unauthorized" });
  }
  assert.equal(calls.writeJson.length, 0);
  assert.equal(calls.writeHash.length, 0);
});

test("sync stores a small snapshot and refuses an oversized one before writing", async () => {
  process.env.APPHUB_SYNC_KEY = KEY;
  const { calls, deps } = fakeStore();
  const handler = createSyncHandler(deps);

  const ok = response();
  const snapshot = { generatedAt: "2026-08-09T00:00:00.000Z", counts: { stream: 1 }, stream: [], queue: [] };
  await handler(request({ body: { snapshot } }), ok);
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.body.stored, { snapshot: true, queue: false, acks: 0 });
  assert.equal(calls.writeJson.length, 1);
  assert.equal(calls.writeJson[0][0], "apphub:snapshot");
  assert.deepEqual(calls.writeJson[0][1], snapshot);

  const big = response();
  await handler(request({ body: { snapshot: { blob: "x".repeat(MAX_SNAPSHOT_BYTES) } } }), big);
  assert.equal(big.statusCode, 413);
  assert.equal(big.body.error, "snapshot_too_large");
  assert.equal(calls.writeJson.length, 1); // the oversized snapshot never reached the store

  const notObject = response();
  await handler(request({ body: { snapshot: ["not", "an", "object"] } }), notObject);
  assert.equal(notObject.statusCode, 400);
  assert.equal(notObject.body.error, "invalid_snapshot");
});

test("sync validates every ack key and status before writing any", async () => {
  process.env.APPHUB_SYNC_KEY = KEY;
  const { calls, deps } = fakeStore();
  const handler = createSyncHandler(deps);

  for (const acks of [
    [{ key: "bad_key!", status: "invited" }],
    [{ key: "cu1:role1", status: "shipped" }],
    { "cu1:role1": { status: "invited" }, "": { status: "blocked" } },
    "not-an-acks-shape",
  ]) {
    const res = response();
    await handler(request({ body: { acks } }), res);
    assert.equal(res.statusCode, 400, JSON.stringify(acks));
    assert.equal(res.body.error, "invalid_ack");
  }
  assert.equal(calls.writeHash.length, 0);

  const ok = response();
  await handler(request({
    body: {
      acks: [
        { key: "cu1:role1", status: "invited", inviteId: "inv1", at: "2026-08-09T01:00:00.000Z" },
        { key: "cu2:role1", status: "blocked", reason: "no email on file" },
      ],
    },
  }), ok);
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.body.stored, { snapshot: false, queue: false, acks: 2 });
  assert.equal(calls.writeHash.length, 1);
  const [hashKey, fields] = calls.writeHash[0];
  assert.equal(hashKey, "apphub:acks");
  assert.deepEqual(fields["cu1:role1"], {
    status: "invited",
    at: "2026-08-09T01:00:00.000Z",
    inviteId: "inv1",
  });
  assert.deepEqual(fields["cu2:role1"], {
    status: "blocked",
    at: "2026-08-09T00:00:00.000Z",
    reason: "no email on file",
  });
});

test("sync GET returns only un-acked interview approvals", async () => {
  process.env.APPHUB_SYNC_KEY = KEY;
  const { deps } = fakeStore({
    "apphub:decisions": {
      "cu1:role1": { action: "interview", at: "2026-08-09T00:01:00.000Z", by: "hi@davidphillips.world" },
      "cu2:role1": { action: "pass", at: "2026-08-09T00:02:00.000Z", by: "hi@davidphillips.world" },
      "cu3:role2": { action: "interview", at: "2026-08-09T00:03:00.000Z", by: "hi@davidphillips.world" },
    },
    "apphub:acks": {
      "cu3:role2": { status: "invited", at: "2026-08-09T00:10:00.000Z" },
    },
  });
  const handler = createSyncHandler(deps);
  const res = response();
  await handler(request({ method: "GET", body: undefined }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.decisions, [{
    key: "cu1:role1",
    action: "interview",
    at: "2026-08-09T00:01:00.000Z",
    by: "hi@davidphillips.world",
  }]);
});

function decisionSetup({ ack = null } = {}) {
  const calls = { wrote: [], deleted: [] };
  const handler = createDecisionHandler({
    corsHandler: () => false,
    authHandler: async (req) => {
      req.authedEmail = "hi@davidphillips.world";
      return true;
    },
    kvReady: () => true,
    readAck: async () => ack,
    writeDecision: async (key, record) => calls.wrote.push([key, record]),
    deleteDecision: async (key) => calls.deleted.push(key),
    now: () => "2026-08-09T00:00:00.000Z",
  });
  return { calls, handler };
}

test("decision validates the key, validates the action, and stamps the session email", async () => {
  const { calls, handler } = decisionSetup();

  for (const body of [
    { key: "not a key", action: "pass" },
    { key: "a:b:c", action: "interview" },
    { key: "", action: "pass" },
  ]) {
    const res = response();
    await handler(request({ body }), res);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.equal(res.body.error, "invalid_key");
  }

  const badAction = response();
  await handler(request({ body: { key: "cu1:role1", action: "reject" } }), badAction);
  assert.equal(badAction.statusCode, 400);
  assert.equal(badAction.body.error, "unsupported_action");
  assert.equal(calls.wrote.length, 0);

  const ok = response();
  await handler(request({
    body: { key: "cu1:role1", action: "interview", name: "Applicant Example", roleTitle: "Founding Engineer" },
  }), ok);
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(calls.wrote, [["cu1:role1", {
    action: "interview",
    at: "2026-08-09T00:00:00.000Z",
    by: "hi@davidphillips.world",
    name: "Applicant Example",
    roleTitle: "Founding Engineer",
  }]]);
  assert.deepEqual(ok.body.decision, calls.wrote[0][1]);
});

test("undo deletes only while un-acked and answers 409 after an ack", async () => {
  const acked = decisionSetup({ ack: { status: "invited", at: "2026-08-09T00:05:00.000Z" } });
  const refused = response();
  await acked.handler(request({ body: { key: "cu1:role1", action: "undo" } }), refused);
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.body.error, "already_acked");
  assert.equal(acked.calls.deleted.length, 0);

  const open = decisionSetup();
  const undone = response();
  await open.handler(request({ body: { key: "cu1:role1", action: "undo" } }), undone);
  assert.equal(undone.statusCode, 200);
  assert.equal(undone.body.undone, true);
  assert.deepEqual(open.calls.deleted, ["cu1:role1"]);
});

test("normalizeAcks reports the first offending key", () => {
  assert.deepEqual(
    normalizeAcks([{ key: "cu1:role1", status: "invited" }, { key: "nope!", status: "invited" }],
      () => "2026-08-09T00:00:00.000Z").badKey,
    "nope!",
  );
  assert.deepEqual(normalizeAcks(null), { ok: false, badKey: null });
});

test("sync stores the split queue doc under its own key with its own cap", async () => {
  process.env.APPHUB_SYNC_KEY = KEY;
  const { calls, deps } = fakeStore();
  const handler = createSyncHandler(deps);
  const rows = [{ key: "cu1:role1", tier: "C" }];
  const ok = response();
  await handler(request({ body: { snapshot: { generatedAt: "2026-08-09T00:00:00.000Z" }, queue: rows } }), ok);
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.body.stored, { snapshot: true, queue: true, acks: 0 });
  const queueWrite = calls.writeJson.find(([key]) => key === "apphub:queue");
  assert.ok(queueWrite, "queue doc written");
  assert.deepEqual(queueWrite[1], { generatedAt: "2026-08-09T00:00:00.000Z", rows });

  const bad = response();
  await handler(request({ body: { queue: "nope" } }), bad);
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.body.error, "invalid_queue");
});

test("sync stores profiles under TTL'd keys and writes only bucket photos to the hash", async () => {
  process.env.APPHUB_SYNC_KEY = KEY;
  const { calls, deps } = fakeStore();
  const handler = createSyncHandler(deps);

  const withPhoto = {
    name: "Applicant Example",
    imageSrc: "https://storage.googleapis.com/paraform-images/candidate-profile-pictures/cutestsynthetic0000000001",
  };
  const foreignPhoto = { name: "Second Applicant", imageSrc: "https://example.com/pic.jpg" };
  const noPhoto = { name: "Third Applicant", imageSrc: null };
  const ok = response();
  await handler(request({
    body: {
      profiles: {
        cutestsynthetic0000000001: withPhoto,
        cmqvf861b00040aksj38cyiwp: foreignPhoto,
        abcdef1234: noPhoto,
      },
    },
  }), ok);
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.body.stored, { snapshot: false, queue: false, acks: 0, profiles: 3 });
  assert.deepEqual(calls.writeJson, [
    ["apphub:profile:cutestsynthetic0000000001", withPhoto, PROFILE_TTL_SECONDS],
    ["apphub:profile:cmqvf861b00040aksj38cyiwp", foreignPhoto, PROFILE_TTL_SECONDS],
    ["apphub:profile:abcdef1234", noPhoto, PROFILE_TTL_SECONDS],
  ]);
  // Only the paraform-images bucket URL made the photos hash; the foreign
  // host and the null were dropped without failing the batch.
  assert.deepEqual(calls.writeHash, [[
    "apphub:photos",
    { cutestsynthetic0000000001: withPhoto.imageSrc },
  ]]);
});

test("sync rejects the whole profiles batch on a bad cuId or oversize profile", async () => {
  process.env.APPHUB_SYNC_KEY = KEY;
  const { calls, deps } = fakeStore();
  const handler = createSyncHandler(deps);

  const good = { name: "Applicant Example" };
  for (const profiles of [
    { shortcu: good }, // under 10 chars
    { "cu_bad_chars12": good }, // invalid characters
    { ["x".repeat(41)]: good }, // over 40 chars
    { cutestsynthetic0000000001: "not-an-object" },
    { cutestsynthetic0000000001: ["not", "a", "plain", "object"] },
    { cutestsynthetic0000000001: null },
    { cutestsynthetic0000000001: { blob: "x".repeat(MAX_PROFILE_BYTES) } }, // over cap once serialized
    { abcdef1234: good, nope: good }, // one bad entry poisons the batch
    ["not", "a", "profiles", "shape"],
  ]) {
    const res = response();
    await handler(request({ body: { profiles } }), res);
    assert.equal(res.statusCode, 400, JSON.stringify(profiles).slice(0, 80));
    assert.equal(res.body.error, "invalid_profile");
  }
  assert.equal(calls.writeJson.length, 0); // nothing was written, good entries included
  assert.equal(calls.writeHash.length, 0);
});

test("normalizeProfiles reports the offending cuId and filters photos to the bucket prefix", () => {
  const bad = normalizeProfiles({ abcdef1234: { name: "A" }, "nope!": { name: "B" } });
  assert.deepEqual(bad, { ok: false, badCu: "nope!" });
  assert.deepEqual(normalizeProfiles("not-an-object"), { ok: false, badCu: null });

  const bucketUrl = "https://storage.googleapis.com/paraform-images/candidate-profile-pictures/abcdef1234";
  const good = normalizeProfiles({
    abcdef1234: { name: "A", imageSrc: bucketUrl },
    // Prefix must include the trailing slash — a lookalike host fails.
    bcdefa2345: { name: "B", imageSrc: "https://storage.googleapis.com/paraform-images.example.com/x" },
  });
  assert.equal(good.ok, true);
  assert.deepEqual(Object.keys(good.profiles), ["abcdef1234", "bcdefa2345"]);
  assert.deepEqual(good.photos, { abcdef1234: bucketUrl });
});

function feedSetup(initial = {}) {
  const calls = { readJson: [], readHash: [] };
  const handler = createFeedHandler({
    corsHandler: () => false,
    authHandler: async () => true,
    kvReady: () => true,
    readJson: async (key) => {
      calls.readJson.push(key);
      return initial[key] ?? null;
    },
    readHash: async (key) => {
      calls.readHash.push(key);
      return initial[key] || {};
    },
  });
  return { calls, handler };
}

test("feed returns the photos hash alongside the snapshot and overlays", async () => {
  const photoUrl = "https://storage.googleapis.com/paraform-images/candidate-profile-pictures/cu1abcdef0";
  const { calls, handler } = feedSetup({
    "apphub:snapshot": { generatedAt: "2026-08-09T00:00:00.000Z", stream: [] },
    "apphub:queue": { generatedAt: "2026-08-09T00:00:00.000Z", rows: [{ key: "cu1abcdef0:role1" }] },
    "apphub:decisions": { "cu1abcdef0:role1": { action: "pass" } },
    "apphub:photos": { cu1abcdef0: photoUrl },
  });
  const res = response();
  await handler(request({ method: "GET", body: undefined }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.photos, { cu1abcdef0: photoUrl });
  // The pre-photos merge behavior is intact: split queue doc back onto the snapshot.
  assert.deepEqual(res.body.snapshot.queue, [{ key: "cu1abcdef0:role1" }]);
  assert.deepEqual(res.body.decisions, { "cu1abcdef0:role1": { action: "pass" } });
  assert.deepEqual(res.body.acks, {});
  assert.equal(res.headers["cache-control"], "no-store");
  assert.ok(calls.readHash.includes("apphub:photos"));
});
