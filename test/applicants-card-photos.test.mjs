import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  allowedPhotoUrl,
  cardFromProfile,
  createSyncHandler,
  normalizeProfiles,
} from "../api/applicants/sync.mjs";
import {
  canonicalSourceProfileJson,
  SOURCE_PROFILE_DIGEST_TEST_VECTOR,
  sourceProfileDigest,
} from "../api/applicants/_lib/source-profile-digest.mjs";

const applicants = readFileSync(resolve("applicants.html"), "utf8");

const PARAFORM = "https://storage.googleapis.com/paraform-images/candidate-profile-pictures/abcdef1234";
const WORKABLE = "https://dvz3vrza543jw.cloudfront.net/uploads/740867/1/2/image/headshot.jpg";

// THE SHARED VECTOR. The identical fixture and the identical hex are asserted
// in the Raydar repo at applicant-core/test/unit/source-profile-digest.test.mjs.
// If the two canonicalizations ever diverge, no receipt matches on either side
// and every Core cycle republishes every profile for ever.
const VECTOR_DIGEST = "5cdc044ac9a14a5a486fb5990d249655b7a2c9dc598df95e4ded0f937dd6285a";

const SAVED_SYNC_KEY = process.env.APPHUB_SYNC_KEY;
const KEY = "apphub-sync-key-0000000000000000001";
test.after(() => {
  if (SAVED_SYNC_KEY === undefined) delete process.env.APPHUB_SYNC_KEY;
  else process.env.APPHUB_SYNC_KEY = SAVED_SYNC_KEY;
});

function fakeStore() {
  const calls = { writeHash: [], writeJson: [] };
  return {
    calls,
    deps: {
      kvReady: () => true,
      readHash: async () => ({}),
      readJson: async () => null,
      writeHash: async (key, fields) => { calls.writeHash.push([key, fields]); return Object.keys(fields).length; },
      writeJson: async (key, value, ttl) => { calls.writeJson.push([key, value, ttl]); return "OK"; },
      readHashKeys: async () => [],
      deleteHashFields: async () => 0,
      now: () => "2026-09-05T00:00:00.000Z",
    },
  };
}

test("the photo allowlist admits exactly two hosts and refuses every measured alternative", () => {
  assert.equal(allowedPhotoUrl(PARAFORM), PARAFORM);
  assert.equal(allowedPhotoUrl(WORKABLE), WORKABLE);
  for (const rejected of [
    // The look-alike the original single-prefix test already guarded.
    "https://storage.googleapis.com/paraform-images.example.com/x",
    "https://paraform-images.example.com/x",
    "https://dvz3vrza543jw.cloudfront.net.example.com/uploads/x",
    // ~17% of Paraform image_src values: LinkedIn's own signed, expiring CDN
    // URLs, every sampled one already expired. Rendering one is a direct
    // media.licdn.com request from the reviewer's browser.
    "https://media.licdn.com/dms/image/v2/x/profile.jpg?e=1&v=beta&t=abc",
    // ~6%: a 42-byte 1x1 transparent GIF, which renders an INVISIBLE avatar
    // rather than falling back to initials.
    "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
    "http://storage.googleapis.com/paraform-images/x.jpg",
    `${PARAFORM}?sig=1`,
    `${PARAFORM}#f`,
    `https://storage.googleapis.com/paraform-images/${"a".repeat(600)}`,
    "", "   ", null, undefined, 7, {}, ["x"],
  ]) {
    assert.equal(allowedPhotoUrl(rejected), null, String(rejected).slice(0, 60));
  }
});

test("a card takes its photo from either host, and an over-long URL is refused not truncated", () => {
  assert.equal(cardFromProfile({ imageSrc: PARAFORM }).photo, PARAFORM);
  assert.equal(cardFromProfile({ imageSrc: WORKABLE }).photo, WORKABLE);
  assert.equal(cardFromProfile({ imageSrc: "https://media.licdn.com/x.jpg" }).photo, null);
  const long = `https://storage.googleapis.com/paraform-images/${"a".repeat(600)}`;
  assert.equal(cardFromProfile({ imageSrc: long }).photo, null,
    "half a URL is a broken image that looks like a real one");
});

test("the photos hash follows the same allowlist as the card", () => {
  const result = normalizeProfiles({
    abcdef1234: { name: "A", imageSrc: PARAFORM },
    bcdefa2345: { name: "B", imageSrc: WORKABLE },
    cdefab3456: { name: "C", imageSrc: "https://media.licdn.com/dms/image/x?e=1" },
    defabc4567: { name: "D", imageSrc: "https://storage.googleapis.com/paraform-images.example.com/x" },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.photos, { abcdef1234: PARAFORM, bcdefa2345: WORKABLE });
});

test("the shared source-profile digest vector hashes to its exact published hex", () => {
  assert.equal(sourceProfileDigest(SOURCE_PROFILE_DIGEST_TEST_VECTOR), VECTOR_DIGEST);
});

test("a Date updatedAt hashes exactly like the ISO string the Monitor receives", () => {
  // THE CASE THE PINNED VECTOR HIDES, and the reason this mirror exists. Core
  // builds updatedAt from a pg timestamptz, so node-pg hands it a JS Date; the
  // Monitor only ever sees the ISO string JSON.stringify made of it. Both sides
  // canonicalize the wire form, so the two hash identically — otherwise no
  // receipt would ever match and Core would republish for ever.
  const iso = "2026-09-05T00:00:00.000Z";
  const asDate = { ...SOURCE_PROFILE_DIGEST_TEST_VECTOR, updatedAt: new Date(iso) };
  assert.equal(sourceProfileDigest(asDate), VECTOR_DIGEST);
  assert.equal(sourceProfileDigest(JSON.parse(JSON.stringify(asDate))), VECTOR_DIGEST);
  assert.match(canonicalSourceProfileJson(asDate), new RegExp(`"updatedAt":"${iso}"`));
});

test("the source-profile receipt records the digest of what was STORED", async () => {
  process.env.APPHUB_SYNC_KEY = KEY;
  const { calls, deps } = fakeStore();
  const handler = createSyncHandler(deps);
  const key = "core:1234567890abcdef1234567890abcdef";
  // Deliberately ragged in the two ways normalizeSourceProfiles rewrites:
  // an upper-case history state and a padded observation id.
  const sent = {
    profileSource: "applicant_hub",
    name: "Applicant",
    imageSrc: WORKABLE,
    historyState: " DATA ",
    sourceObservationId: " obs-1 ",
    experiences: [{ roleTitle: "Engineer", companyName: "Example" }],
    education: [],
  };
  const res = {
    statusCode: 0, body: null, headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    end() {},
  };
  await handler({ method: "POST", headers: { authorization: `Bearer ${KEY}` }, body: { sourceProfiles: { [key]: sent } } }, res);
  assert.equal(res.statusCode, 200);

  const stored = calls.writeJson.find(([name]) => name === `apphub:source-profile:${key}`)[1];
  const receipt = calls.writeHash.find(([name]) => name === "apphub:source-profile-ready")[1][key];
  assert.equal(receipt.payloadDigest, sourceProfileDigest(stored),
    "the digest must describe the object the Monitor actually persisted");
  assert.equal(receipt.payloadDigest, sourceProfileDigest(sent),
    "and hashing the object Core SENT must give the same answer, or nothing ever matches");
  // The pre-existing receipt fields are unchanged: profileReceiptReady reads
  // only these, so the publish fence and the rules tick are untouched.
  assert.equal(receipt.source, "applicant_hub");
  assert.equal(receipt.durable, true);
  assert.equal(receipt.historyState, "data");
  assert.equal(receipt.sourceObservationId, "obs-1");

  const facts = calls.writeHash.find(([name]) => name === "apphub:facts")[1][key];
  assert.equal(facts.sourceObservationId, receipt.sourceObservationId);
  assert.equal(facts.sourcePayloadDigest, receipt.payloadDigest,
    "funded-employer facts must be bound to the same exact source payload as the durable receipt");

  // And the card written in the same breath carries the photo.
  const cards = calls.writeHash.find(([name]) => name === "apphub:cards")[1];
  assert.equal(cards[key].photo, WORKABLE);
});

test("a dead photo falls back to initials instead of a broken-image glyph", () => {
  // Both render paths go through one helper, so the fallback cannot be added to
  // the list and forgotten on the modal (or the other way round).
  assert.match(applicants, /function avatarImg\(src, name\)/);
  assert.match(applicants, /onerror="avatarFallback\(this\)"/);
  assert.match(applicants, /function avatarFallback\(img\)\s*\{/);
  assert.match(applicants, /parent\.textContent = img\.getAttribute\("data-initials"\) \|\| "\?"/);
  assert.match(applicants, /const img = src \? avatarImg\(src, row\.name\) : esc\(initials\(row\.name\)\)/);
  assert.match(applicants, /el\.innerHTML = avatarImg\(src, name\)/);
  // Lazy, async-decoded, and leaking no referrer to either CDN.
  assert.match(applicants, /loading="lazy" decoding="async"/);
  assert.match(applicants, /referrerpolicy="no-referrer"/);
  // Core rows are keyed core:<id>, so the CARD channel is the one that carries
  // their photo; the cuId-keyed photos hash can never hold them.
  assert.match(applicants, /STATE\.photos\[id\] \|\| STATE\.cards\[id\]\?\.photo/);
});
