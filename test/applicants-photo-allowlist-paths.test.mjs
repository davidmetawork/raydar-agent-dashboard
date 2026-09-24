// Every path that can put a candidate photo into the Applicants tab's
// <img src> goes through the one photo allowlist (api/applicants/_lib/photo-url.mjs).
//
// Before 2026-09-24 only the photos hash and the cards used it. Two paths
// skipped it: profile.mjs returned Paraform's raw image_src (the avatar
// fallback once a profile was opened), and _lib/paged.mjs copied the paged
// store's profile.photo straight into photos and cards. MEASURED 2026-09-24
// over the 2,592 bound profile facts in Core: 356 signed media.licdn.com links,
// 96 1x1 data: GIFs and 24 crustdata-media S3 links, beside 1,733 on the
// Paraform bucket (all of which pass).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

import { allowedPhotoUrl } from "../api/applicants/_lib/photo-url.mjs";
import { allowedPhotoUrl as reExported, normalizeProfiles } from "../api/applicants/sync.mjs";
import { createProfileHandler } from "../api/applicants/profile.mjs";
import { pagedFeedResponse, projectPagedDocument } from "../api/applicants/_lib/paged.mjs";
import { projectApplicantProfileV2 } from "../api/applicants/_lib/paged-core/applicant-profile-contract.mjs";
import { pagedProfilePins } from "../api/applicants/_lib/paged-core/paged-profile-contract.mjs";

const PARAFORM = "https://storage.googleapis.com/paraform-images/candidate-profile-pictures/abcdef1234";
const WORKABLE = "https://dvz3vrza543jw.cloudfront.net/uploads/740867/1/2/image/headshot.jpg";
const ALLOWED = [PARAFORM, WORKABLE];

// Synthetic values in the measured shapes. Each must become null (or initials)
// on every path.
const REFUSED = {
  "signed LinkedIn link": "https://media.licdn.com/dms/image/v2/C4E03AQ/profile-displayphoto-shrink_200_200/0/1?e=1790000000&v=beta&t=abc",
  "1x1 data: spacer": "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "look-alike bucket": "https://storage.googleapis.com/paraform-images.example.com/x.jpg",
  "look-alike host": "https://storage.googleapis.com.example.net/paraform-images/x.jpg",
  "../ escape": "https://storage.googleapis.com/paraform-images/../another-bucket/x.jpg",
  "%2e%2e escape": "https://storage.googleapis.com/paraform-images/%2e%2e/another-bucket/x.jpg",
  "backslash escape": "https://storage.googleapis.com/paraform-images/..\\another-bucket\\x.jpg",
  "Workable ../ escape": "https://dvz3vrza543jw.cloudfront.net/uploads/../private/x.jpg",
  "enrichment vendor bucket": "https://crustdata-media.s3.us-east-2.amazonaws.com/person/synthetic.jpg",
  "plain http": "http://storage.googleapis.com/paraform-images/x.jpg",
};

const applicants = await readFile(new URL("../applicants.html", import.meta.url), "utf8");
const blockStart = applicants.indexOf("function initials(name)");
const blockEnd = applicants.indexOf("function avatarFallback(img)", blockStart);
assert.ok(blockStart >= 0 && blockEnd > blockStart, "avatar helper block is extractable");
const browser = runInNewContext(
  `${applicants.slice(blockStart, blockEnd)}; ({ allowedPhotoUrl, firstAllowedPhoto, avatarImg })`,
  {
    URL,
    esc: (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[character]),
  },
);

test("the server helper refuses every measured bad shape and keeps the allowed links", () => {
  assert.equal(reExported, allowedPhotoUrl, "sync.mjs re-exports the one helper, not a copy");
  for (const [label, url] of Object.entries(REFUSED)) assert.equal(allowedPhotoUrl(url), null, label);
  for (const url of ALLOWED) assert.equal(allowedPhotoUrl(url), url);
});

test("the browser copy gives the server's answer on every input", () => {
  const inputs = [
    ...Object.values(REFUSED), ...ALLOWED,
    ` ${WORKABLE} `, `${PARAFORM}?x=1`, `${PARAFORM}#f`, `https://storage.googleapis.com/paraform-images/${"a".repeat(600)}`,
    "https://storage.googleapis.com/paraform-images/a/./b.jpg",
    "https://storage.googleapis.com/paraform-images/a/%2E%2E/b.jpg",
    "https://storage.googleapis.com/paraform-images/a/.\t./b.jpg",
    "https://storage.googleapis.com/paraform-images/a b.jpg",
    "https://STORAGE.googleapis.com/paraform-images/x.jpg",
    "https://storage.googleapis.com:443/paraform-images/x.jpg",
    "", null, undefined, 42, {}, ["https://storage.googleapis.com/paraform-images/x"],
  ];
  for (const input of inputs) {
    assert.equal(browser.allowedPhotoUrl(input), allowedPhotoUrl(input), String(input).slice(0, 80));
  }
});

test("avatarImg renders initials, never an <img>, for a refused link", () => {
  for (const [label, url] of Object.entries(REFUSED)) {
    const html = browser.avatarImg(url, "Ada Lovelace");
    assert.equal(html, "AL", label);
  }
  for (const url of ALLOWED) {
    assert.match(browser.avatarImg(url, "Ada Lovelace"), new RegExp(`^<img src="${url.replace(/[.?*+^$()[\]{}|\\/]/g, "\\$&")}"`));
  }
  // A refused first candidate does not hide an allowed later one, and nothing
  // allowed at all means no photo.
  assert.equal(browser.firstAllowedPhoto(REFUSED["signed LinkedIn link"], null, WORKABLE), WORKABLE);
  assert.equal(browser.firstAllowedPhoto(...Object.values(REFUSED)), "");
  assert.equal(browser.firstAllowedPhoto(), "");
});

test("every avatar source in the page goes through the allowlist", () => {
  // Both render paths pick through firstAllowedPhoto, and the paged profile
  // read stores only an allowed value in photos and cards.
  assert.match(applicants, /const src = firstAllowedPhoto\(STATE\.photos\[id\], STATE\.cards\[id\]\?\.photo, p && p\.imageSrc\);/);
  assert.match(applicants, /const src = firstAllowedPhoto\(STATE\.photos\[cu\], STATE\.cards\[cu\]\?\.photo, STATE\.profiles\[cu\]\?\.imageSrc\);/);
  assert.match(applicants, /const photo = allowedPhotoUrl\(profile\.imageSrc\);\n\s+STATE\.cards\[cu\] = \{[^}]*imageSrc: photo, profileKey: cu \};\n\s+if \(photo\) STATE\.photos\[cu\] = photo; else delete STATE\.photos\[cu\];/);
  // No other raw read of a photo field reaches the page's avatar code.
  assert.doesNotMatch(applicants, /STATE\.photos\[\w+\] \|\|/);
  assert.doesNotMatch(applicants, /STATE\.photos\[cu\] = profile\.imageSrc/);
});

test("the stored apphub:profile keeps only an allowed photo", () => {
  const input = {};
  const keys = {};
  let n = 0;
  for (const url of [...Object.values(REFUSED), ...ALLOWED]) {
    const cu = `photo${String(n++).padStart(6, "0")}`;
    input[cu] = { name: "A", imageSrc: url };
    keys[cu] = url;
  }
  input.nophoto0001 = { name: "No photo" };
  const result = normalizeProfiles(input);
  assert.equal(result.ok, true);
  for (const [cu, url] of Object.entries(keys)) {
    const expected = ALLOWED.includes(url) ? url : null;
    assert.equal(result.profiles[cu].imageSrc, expected, url.slice(0, 60));
    assert.equal(result.photos[cu] ?? null, expected);
  }
  assert.equal(Object.hasOwn(result.profiles.nophoto0001, "imageSrc"), false, "no key is invented");
});

function response() {
  return {
    statusCode: 0, body: null, headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    end() {},
  };
}

function profileHandler({ store = {}, paged = null, record = null, writes = [] } = {}) {
  return createProfileHandler({
    corsHandler: () => false,
    authHandler: async () => true,
    kvReady: () => true,
    readJson: async (key) => store[key] ?? null,
    readMany: async () => ({}),
    pagedEnabled: () => Boolean(paged),
    readPaged: async () => paged,
    cookieReady: () => Boolean(record),
    readParaform: async (procedure) => (procedure === "candidateUser.getLinkedInCandidate" ? record : null),
    writeJson: async (key, value) => { writes.push([key, value]); return "OK"; },
  });
}

async function servedPhoto(handler, query = { cu: "abcdef1234" }) {
  const res = response();
  await handler({ method: "GET", headers: {}, query }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body).slice(0, 200));
  return res.body.imageSrc;
}

test("profile.mjs allowlists imageSrc on every branch, and caches only the allowed value", async () => {
  const cu = "abcdef1234";
  for (const url of [...Object.values(REFUSED), ...ALLOWED]) {
    const expected = ALLOWED.includes(url) ? url : null;
    const label = url.slice(0, 60);

    const pagedQuery = { applicationId: "a", generationId: "g", generationDigest: "d", rowDigest: "r" };
    assert.equal(await servedPhoto(profileHandler({ paged: {
      profile: { name: "A", imageSrc: url, source: "stored_application" }, row: {}, generation: {},
    } }), pagedQuery), expected, `paged: ${label}`);

    assert.equal(await servedPhoto(profileHandler({ store: {
      [`apphub:source-profile:${cu}`]: { name: "A", imageSrc: url, sourceObservationId: "obs-1" },
    } })), expected, `source profile: ${label}`);

    assert.equal(await servedPhoto(profileHandler({ store: {
      [`apphub:profile:${cu}`]: { name: "A", imageSrc: url },
    } })), expected, `cached apphub:profile: ${label}`);

    const writes = [];
    assert.equal(await servedPhoto(profileHandler({ record: { name: "A", image_src: url }, writes })),
      expected, `live Paraform read: ${label}`);
    assert.deepEqual(writes.map(([key, value]) => [key, value.imageSrc]), [[`apphub:profile:${cu}`, expected]],
      `the 6h cache holds the allowed value: ${label}`);
  }
});

test("profile.mjs leaves a profile with no imageSrc without one", async () => {
  const handler = profileHandler({ store: { "apphub:profile:abcdef1234": { name: "A" } } });
  const res = response();
  await handler({ method: "GET", headers: {}, query: { cu: "abcdef1234" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(Object.hasOwn(res.body, "imageSrc"), false);
});

// The paged store's photo reaches the page through projectPagedDocument, built
// here from a real pinned provider payload like Core's.
const applicationId = "11111111-1111-4111-8111-111111111111";
const observationId = "22222222-2222-4222-8222-222222222222";
const application = { applicationId, tenantScopeId: "tenant-one", personId: "person-one",
  sourceObservationId: observationId, rowRevision: observationId,
  appliedTo: { roleVersionId: "role-version-one", roleId: "role-one", title: "Engineer",
    hiringCompany: { roleVersion: { name: "Client Co", version: "role-version-one",
      observedAt: "2026-09-09T12:00:00Z" } } } };

function pagedDocumentWithPhoto(photo) {
  const payload = { name: "Provider Person", title: "Provider Engineer", photo };
  const provider = { scope: { tenantScopeId: "tenant-one", personId: "person-one" },
    sourceObservationId: observationId, state: "verified", observedAt: "2026-09-09T12:00:00Z",
    factVersion: "provider-one", freshness: "current", facts: payload };
  const selected = { ...projectApplicantProfileV2({ application, paraformProfile: provider,
    actionability: { eligibility: "ready" } }), factsCurrent: true, inputRevision: "input-one", decisionRevision: 0 };
  const pins = pagedProfilePins(selected);
  return {
    current: true, source: {}, resume: null,
    profile: { tenantScopeId: "tenant-one", personId: "person-one", sourceObservationId: observationId,
      factVersion: "provider-one", observedAt: "2026-09-09T12:00:00Z", payloadState: "available",
      freshness: "current", payload },
    row: { id: "33333333-3333-4333-8333-333333333333", application_id: applicationId,
      row_revision: 7, row_digest: "a".repeat(64), monitor_key: "candidate:role",
      role_id: "role-one", role_title: "Engineer", company: "Client Co",
      application_date: "2026-09-08",
      index_payload: { profilePins: pins, appliedAt: "2026-09-09T12:00:00Z", tier: "A" },
      source_observation_id: observationId, fact_set_digest: pins.factSetDigest,
      source_status: "current", partition: "ready", view_states: ["ready"], problems: [],
      decision_revision: 0, created_at: "2026-09-09T12:00:00Z" },
  };
}

test("the paged store's photo is allowlisted on imageSrc, the photos hash, the card and profileV2", () => {
  for (const url of [...Object.values(REFUSED), ...ALLOWED]) {
    const expected = ALLOWED.includes(url) ? url : null;
    const label = url.slice(0, 60);
    const projected = projectPagedDocument(pagedDocumentWithPhoto(url));
    assert.equal(projected.row.name, "Provider Person", "the fixture reaches the provider facts");
    assert.equal(projected.profile.imageSrc, expected, `imageSrc: ${label}`);
    assert.equal(projected.photo, expected, `photo: ${label}`);
    assert.equal(projected.card.imageSrc, expected, `card: ${label}`);
    assert.equal(projected.profileV2.profile.photo, expected, `profileV2 sent to the browser: ${label}`);
    assert.equal(projected.profile.profileV2.profile.photo, expected);
    // The photo sits outside factSetDigest, so filtering it cannot move one.
    assert.equal(projected.profileV2.factSetDigest,
      projectPagedDocument(pagedDocumentWithPhoto(PARAFORM)).profileV2.factSetDigest);

    const feed = pagedFeedResponse({
      manifest: { generationId: "g", generationDigest: "d", publishedAt: "2026-09-09T12:00:00Z",
        counts: {}, rowCount: 1 },
      page: { nextCursor: null }, view: "ready", applicants: [projected],
    });
    assert.equal(feed.photos[projected.row.profileKey] ?? null, expected, `feed photos hash: ${label}`);
    assert.equal(feed.cards[projected.row.profileKey].imageSrc, expected, `feed card: ${label}`);
    assert.equal(feed.applicantRowsV2[projected.row.key].profile.photo, expected, `feed profileV2: ${label}`);
  }
});
