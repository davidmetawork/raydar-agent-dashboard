import test from "node:test";
import assert from "node:assert/strict";

import { hashGetMany, PROFILE_TTL_SECONDS, validKey } from "../api/applicants/_lib/kv.mjs";
import {
  CARD_FIELD_MAX,
  cardFromProfile,
  createSyncHandler,
  MAX_PROFILE_BYTES,
  MAX_SNAPSHOT_BYTES,
  normalizeAcks,
  normalizeProfiles,
} from "../api/applicants/sync.mjs";
import { createCardsHandler, MAX_CARD_IDS } from "../api/applicants/cards.mjs";
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
function request({ method = "POST", authorization = `Bearer ${KEY}`, body, query } = {}) {
  return {
    method,
    headers: authorization === null ? {} : { authorization },
    body,
    query,
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
  const calls = { readHash: [], writeHash: [], writeJson: [], readJson: [], readHashKeys: [], deleteHashFields: [] };
  return {
    calls,
    deps: {
      kvReady: () => true,
      readHash: async (key) => {
        calls.readHash.push(key);
        return initial[key] || {};
      },
      readJson: async (key) => {
        calls.readJson.push(key);
        return initial[key] ?? null;
      },
      writeHash: async (key, fields) => {
        calls.writeHash.push([key, fields]);
        return Object.keys(fields).length;
      },
      writeJson: async (key, value, ttlSeconds) => {
        calls.writeJson.push([key, value, ttlSeconds]);
        return "OK";
      },
      readHashKeys: async (key) => {
        calls.readHashKeys.push(key);
        return Object.keys(initial[key] || {});
      },
      deleteHashFields: async (key, fields) => {
        calls.deleteHashFields.push([key, fields]);
        return fields.length;
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
  // A stored snapshot also refreshes the apphub:counts tripwire doc, so the
  // snapshot write is looked up by key rather than assumed to be the only one.
  const snapshotWrites = () => calls.writeJson.filter(([key]) => key === "apphub:snapshot");
  assert.equal(snapshotWrites().length, 1);
  assert.deepEqual(snapshotWrites()[0][1], snapshot);

  const big = response();
  await handler(request({ body: { snapshot: { blob: "x".repeat(MAX_SNAPSHOT_BYTES) } } }), big);
  assert.equal(big.statusCode, 413);
  assert.equal(big.body.error, "snapshot_too_large");
  assert.equal(snapshotWrites().length, 1); // the oversized snapshot never reached the store

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
  // host and the null were dropped without failing the batch. (The same pass
  // also writes apphub:cards — asserted in its own test below — so this looks
  // up the photos write rather than assuming it is the only hash write.)
  assert.deepEqual(calls.writeHash.find(([key]) => key === "apphub:photos"), [
    "apphub:photos",
    { cutestsynthetic0000000001: withPhoto.imageSrc },
  ]);
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

const BUCKET_PHOTO = "https://storage.googleapis.com/paraform-images/candidate-profile-pictures/abcdef1234";

// Four experiences and four schools on purpose: the card keeps three of each
// while the counts must still report the full history.
const CARD_SOURCE_PROFILE = {
  name: "Applicant Example",
  title: "Founding Engineer",
  location: "San Francisco, CA",
  about: "a".repeat(2_000),
  imageSrc: BUCKET_PHOTO,
  updatedAt: "2026-07-01T00:00:00.000Z",
  experiences: [
    {
      roleTitle: "Staff Engineer",
      companyName: "Example Co",
      start: "2024-01-01",
      end: null,
      current: true,
      logo: "https://storage.googleapis.com/paraform-images/company-logos/example",
      description: "b".repeat(2_000),
      location: "Remote",
      industry: "Software",
      aiTags: ["ai", "infra"],
      talentRank: 3,
    },
    { roleTitle: "Senior Engineer", companyName: "Second Co", start: "2021-01-01", end: "2023-12-31", current: false, logo: null },
    { roleTitle: "Engineer", companyName: "Third Co", start: "2019-01-01", end: "2020-12-31", current: false, logo: null },
    { roleTitle: "Intern", companyName: "Fourth Co", start: "2018-06-01", end: "2018-09-01", current: false, logo: null },
  ],
  education: [
    { school: "Example University", degree: "BSc Computer Science", start: "2014", end: "2018", logo: "https://storage.googleapis.com/paraform-images/school-logos/example", talentRank: 7 },
    { school: "Second School", degree: "MSc", start: "2018", end: "2019", logo: null },
    { school: "Third School", degree: null, start: null, end: null, logo: null },
    { school: "Fourth School", degree: null, start: null, end: null, logo: null },
  ],
};

test("cardFromProfile keeps the top 3 of each list, counts the full ones, and drops the bulk", () => {
  const card = cardFromProfile(CARD_SOURCE_PROFILE);

  assert.deepEqual(Object.keys(card).sort(), [
    "edu", "eduCount", "exp", "expCount", "location", "photo", "title", "updatedAt",
  ]);
  assert.equal(card.photo, BUCKET_PHOTO);
  assert.equal(card.title, "Founding Engineer");
  assert.equal(card.location, "San Francisco, CA");
  assert.equal(card.updatedAt, "2026-07-01T00:00:00.000Z");
  assert.equal(Object.hasOwn(card, "about"), false); // deliberately not a card field
  assert.equal(Object.hasOwn(card, "name"), false); // the row already knows the name

  assert.equal(card.exp.length, 3);
  assert.equal(card.expCount, 4); // the count is of the FULL list, not the slice
  assert.deepEqual(card.exp[0], {
    role: "Staff Engineer",
    company: "Example Co",
    start: "2024-01-01",
    end: null,
    current: true,
    logo: "https://storage.googleapis.com/paraform-images/company-logos/example",
  });
  assert.deepEqual(card.exp[1].role, "Senior Engineer");
  assert.equal(card.exp[1].current, false);
  assert.equal(card.exp[2].role, "Engineer");
  // The 2,000-char description rode in on the profile and stayed out of the card.
  assert.ok(!JSON.stringify(card).includes("b".repeat(50)));

  assert.equal(card.edu.length, 3);
  assert.equal(card.eduCount, 4);
  assert.deepEqual(card.edu[0], {
    school: "Example University",
    degree: "BSc Computer Science",
    start: "2014",
    end: "2018",
    logo: "https://storage.googleapis.com/paraform-images/school-logos/example",
  });
  assert.equal(Object.hasOwn(card.edu[0], "talentRank"), false);
});

test("cardFromProfile nulls a non-bucket photo and caps every string at the field max", () => {
  assert.equal(cardFromProfile({ imageSrc: "https://example.com/pic.jpg" }).photo, null);
  assert.equal(cardFromProfile({ imageSrc: null }).photo, null);
  assert.equal(cardFromProfile({ imageSrc: 42 }).photo, null);
  // Prefix must include the trailing slash — the same lookalike-host rule the
  // photos hash uses.
  assert.equal(
    cardFromProfile({ imageSrc: "https://storage.googleapis.com/paraform-images.example.com/x" }).photo,
    null,
  );

  const long = cardFromProfile({
    title: "t".repeat(CARD_FIELD_MAX + 200),
    location: "l".repeat(CARD_FIELD_MAX + 200),
    experiences: [{ roleTitle: "r".repeat(CARD_FIELD_MAX + 200), companyName: "c".repeat(CARD_FIELD_MAX + 200) }],
    education: [{ school: "s".repeat(CARD_FIELD_MAX + 200) }],
  });
  assert.equal(long.title.length, CARD_FIELD_MAX);
  assert.equal(long.location.length, CARD_FIELD_MAX);
  assert.equal(long.exp[0].role.length, CARD_FIELD_MAX);
  assert.equal(long.exp[0].company.length, CARD_FIELD_MAX);
  assert.equal(long.edu[0].school.length, CARD_FIELD_MAX);
});

test("cardFromProfile always returns the full shape, even on junk input", () => {
  const empty = {
    photo: null, title: null, location: null, updatedAt: null,
    exp: [], expCount: 0, edu: [], eduCount: 0,
  };
  for (const input of [
    {},
    null,
    undefined,
    "not-a-profile",
    ["not", "a", "profile"],
    { experiences: "nope", education: null },
    { experiences: {}, education: 7 },
    { title: "", location: "   " }, // blank strings normalize to null, not ""
  ]) {
    assert.deepEqual(cardFromProfile(input), empty, JSON.stringify(input ?? null));
  }
  // A ragged row still produces every key of the entry shape.
  const ragged = cardFromProfile({ experiences: [{}, null], education: [null] });
  assert.deepEqual(ragged.exp[0], { role: null, company: null, start: null, end: null, current: false, logo: null });
  assert.deepEqual(ragged.exp[1], { role: null, company: null, start: null, end: null, current: false, logo: null });
  assert.equal(ragged.expCount, 2);
  assert.deepEqual(ragged.edu[0], { school: null, degree: null, start: null, end: null, logo: null });
  assert.equal(ragged.eduCount, 1);
});

test("sync writes the cards hash beside the photos hash in one profiles pass", async () => {
  process.env.APPHUB_SYNC_KEY = KEY;
  const { calls, deps } = fakeStore();
  const handler = createSyncHandler(deps);

  const foreignPhoto = { name: "Second Applicant", imageSrc: "https://example.com/pic.jpg", title: "Designer" };
  const ok = response();
  await handler(request({
    body: {
      profiles: {
        abcdef1234: CARD_SOURCE_PROFILE,
        cmqvf861b00040aksj38cyiwp: foreignPhoto,
      },
    },
  }), ok);
  assert.equal(ok.statusCode, 200);
  // The response contract is unchanged — cards are a side effect of `profiles`.
  assert.deepEqual(ok.body.stored, { snapshot: false, queue: false, acks: 0, profiles: 2 });

  assert.deepEqual(calls.writeHash.map(([key]) => key), ["apphub:photos", "apphub:cards"]);
  const [, cards] = calls.writeHash.find(([key]) => key === "apphub:cards");
  // One HSET for the whole batch, and a card for EVERY profile — including the
  // one whose photo was dropped for living off the bucket.
  assert.deepEqual(Object.keys(cards), ["abcdef1234", "cmqvf861b00040aksj38cyiwp"]);
  assert.deepEqual(cards.abcdef1234, cardFromProfile(CARD_SOURCE_PROFILE));
  assert.equal(cards.cmqvf861b00040aksj38cyiwp.photo, null);
  assert.equal(cards.cmqvf861b00040aksj38cyiwp.title, "Designer");
});

test("a full publish prunes cards against the same keep-set as photos, using their own keys", async () => {
  process.env.APPHUB_SYNC_KEY = KEY;
  const { calls, deps } = fakeStore({
    "apphub:photos": { keptcu0001: "url", stalecu001: "url" },
    // `nophotocu1` never had a bucket photo, so it exists only in cards — the
    // case a photos-derived drop list would strand forever.
    "apphub:cards": { keptcu0001: {}, stalecu001: {}, nophotocu1: {} },
  });
  const handler = createSyncHandler(deps);

  const ok = response();
  await handler(request({
    body: {
      snapshot: { generatedAt: "2026-08-09T00:00:00.000Z", stream: [{ cuId: "keptcu0001" }] },
      queue: [{ key: "keptcu0001:role1", cuId: "keptcu0001" }],
    },
  }), ok);
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.body.stored, { snapshot: true, queue: true, acks: 0 });
  assert.deepEqual(calls.readHashKeys, ["apphub:photos", "apphub:cards"]);
  assert.deepEqual(calls.deleteHashFields, [
    ["apphub:photos", ["stalecu001"]],
    ["apphub:cards", ["stalecu001", "nophotocu1"]],
  ]);
});

test("a cards prune failure never fails the push that carried real data", async () => {
  process.env.APPHUB_SYNC_KEY = KEY;
  const { calls, deps } = fakeStore({ "apphub:cards": { stalecu001: {} } });
  const handler = createSyncHandler(deps);
  const ok = response();
  await handler(request({
    body: {
      snapshot: { generatedAt: "2026-08-09T00:00:00.000Z", stream: [] },
      queue: [],
    },
  }), ok);
  // Sanity: the prune ran and wanted to drop the stale card.
  assert.deepEqual(calls.deleteHashFields, [["apphub:cards", ["stalecu001"]]]);

  const exploding = fakeStore({ "apphub:cards": { stalecu001: {} } });
  exploding.deps.deleteHashFields = async () => { throw new Error("kv down"); };
  const survived = response();
  await createSyncHandler(exploding.deps)(request({
    body: {
      snapshot: { generatedAt: "2026-08-09T00:00:00.000Z", stream: [] },
      queue: [],
    },
  }), survived);
  assert.equal(survived.statusCode, 200);
  assert.deepEqual(survived.body.stored, { snapshot: true, queue: true, acks: 0 });
});

test("hashGetMany aligns HMGET to the requested fields and never fires on an empty list", async () => {
  const commands = [];
  const kvImpl = async (command) => {
    commands.push(command);
    return [JSON.stringify({ title: "A" }), null, JSON.stringify({ title: "C" })];
  };
  assert.deepEqual(
    await hashGetMany("apphub:cards", ["abcdef1234", "bcdefa2345", "cdefab3456"], { kvImpl }),
    { abcdef1234: { title: "A" }, cdefab3456: { title: "C" } }, // the miss is absent, not null
  );
  assert.deepEqual(commands, [["HMGET", "apphub:cards", "abcdef1234", "bcdefa2345", "cdefab3456"]]);

  assert.deepEqual(await hashGetMany("apphub:cards", [], { kvImpl }), {});
  assert.deepEqual(await hashGetMany("apphub:cards", null, { kvImpl }), {});
  assert.equal(commands.length, 1); // `HMGET key` with no fields is a protocol error
});

function cardsSetup(initial = {}) {
  const calls = { readHashMany: [] };
  const handler = createCardsHandler({
    corsHandler: () => false,
    authHandler: async () => true,
    kvReady: () => true,
    readHashMany: async (key, fields) => {
      calls.readHashMany.push([key, fields]);
      const store = initial[key] || {};
      return Object.fromEntries(fields.filter((field) => store[field] != null).map((field) => [field, store[field]]));
    },
  });
  return { calls, handler };
}

test("cards returns only the ids the store actually had", async () => {
  const card = cardFromProfile(CARD_SOURCE_PROFILE);
  const { calls, handler } = cardsSetup({ "apphub:cards": { abcdef1234: card } });
  const res = response();
  await handler(request({ method: "GET", body: undefined, query: { cus: "abcdef1234,bcdefa2345" } }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, cards: { abcdef1234: card } }); // the unknown id is absent
  assert.deepEqual(calls.readHashMany, [["apphub:cards", ["abcdef1234", "bcdefa2345"]]]);
  assert.equal(res.headers["cache-control"], "no-store");
});

test("cards drops invalid ids, dedupes, and caps the batch", async () => {
  const { calls, handler } = cardsSetup();
  const res = response();
  // Padding, blanks, a too-short id, punctuation, an over-40-char id, and a repeat.
  const tooLong = "z".repeat(41);
  await handler(request({
    method: "GET",
    body: undefined,
    query: { cus: ` abcdef1234 ,,short,cu_bad_chars12,${tooLong},abcdef1234,bcdefa2345,,` },
  }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls.readHashMany[0][1], ["abcdef1234", "bcdefa2345"]);

  const many = Array.from({ length: MAX_CARD_IDS + 10 }, (_, i) => `cu${String(i).padStart(8, "0")}`);
  const capped = cardsSetup();
  const cappedRes = response();
  await capped.handler(request({ method: "GET", body: undefined, query: { cus: many.join(",") } }), cappedRes);
  assert.equal(cappedRes.statusCode, 200); // an over-eager caller is truncated, not rejected
  assert.deepEqual(capped.calls.readHashMany[0][1], many.slice(0, MAX_CARD_IDS));
});

test("cards answers 200 with an empty map when no id survives, and 405 on non-GET", async () => {
  for (const cus of [undefined, "", "   ", ",,,", "short,cu_bad_chars12", 42]) {
    const { calls, handler } = cardsSetup();
    const res = response();
    await handler(request({ method: "GET", body: undefined, query: { cus } }), res);
    assert.equal(res.statusCode, 200, String(cus));
    assert.deepEqual(res.body, { ok: true, cards: {} });
    assert.equal(calls.readHashMany.length, 0, "no store round-trip for an empty batch");
  }
  const missingQuery = response();
  await cardsSetup().handler(request({ method: "GET", body: undefined }), missingQuery);
  assert.equal(missingQuery.statusCode, 200);
  assert.deepEqual(missingQuery.body, { ok: true, cards: {} });

  for (const method of ["POST", "PUT", "DELETE"]) {
    const res = response();
    await cardsSetup().handler(request({ method, body: undefined, query: { cus: "abcdef1234" } }), res);
    assert.equal(res.statusCode, 405, method);
    assert.deepEqual(res.body, { ok: false, error: "GET only" });
  }
});

test("cards surfaces a store failure as 502, not a blank list", async () => {
  const handler = createCardsHandler({
    corsHandler: () => false,
    authHandler: async () => true,
    kvReady: () => true,
    readHashMany: async () => { throw new Error("kv down"); },
  });
  const res = response();
  await handler(request({ method: "GET", body: undefined, query: { cus: "abcdef1234" } }), res);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, "cards_unavailable");
  assert.equal(res.body.detail, "kv down");

  const unconfigured = createCardsHandler({
    corsHandler: () => false,
    authHandler: async () => true,
    kvReady: () => false,
  });
  const off = response();
  await unconfigured(request({ method: "GET", body: undefined, query: { cus: "abcdef1234" } }), off);
  assert.equal(off.statusCode, 503);
  assert.equal(off.body.error, "state_store_not_configured");
});
