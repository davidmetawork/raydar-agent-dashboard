import test from "node:test";
import assert from "node:assert/strict";
import { createSyncHandler, normalizeSourceProfiles } from "../api/applicants/sync.mjs";
import { createFeedHandler } from "../api/applicants/feed.mjs";
import { createProfileHandler } from "../api/applicants/profile.mjs";
import { createCardsHandler } from "../api/applicants/cards.mjs";
import { K } from "../api/applicants/_lib/kv.mjs";
import { normalizeRichProfile, richCardFromProfile, richProfileLogo } from "../api/applicants/_lib/rich-profile.mjs";
import { publicationBody, publishInto, sourceReceiptsFor } from "./helpers/applicant-generation.mjs";

const AT = "2026-09-05T22:00:00.000Z";
const KEY = "core:application000000000000001";
const BINDING = { sourceObservationId: "observation-one", candidateUserId: "candidate000000000001", connectionReceiptId: "receipt-one" };
const SOURCE = { name: "Source Applicant", title: "Application headline", profileSource: "applicant_hub", historyState: "data",
  sourceObservationId: BINDING.sourceObservationId, experiences: [{ roleTitle: "Source role" }], education: [] };
const LOGO = "https://storage.googleapis.com/paraform-company-logo-urls/company-logos/synthetic.png";
const RICH = { ...BINDING, profileEnrichedAt: AT, updatedAt: "2026-09-01T00:00:00Z", title: "Provider headline",
  name: "Provider cannot rename applicant", paraformTier: "A", paraformTierSource: "paraform", paraformTierObservedAt: AT, densityScore: .71,
  experiences: [{ companyId: "company-one", companyName: "Example Company", roleTitle: "Engineer", talentRank: "S", logo: LOGO }],
  education: [{ schoolId: "school-one", school: "Example College", degree: "BS", talentRank: "B", logo: LOGO }] };
const secret = "synthetic-rich-profile-sync-key";
const savedKey = process.env.APPHUB_SYNC_KEY;
test.before(() => { process.env.APPHUB_SYNC_KEY = secret; });
test.after(() => { if (savedKey === undefined) delete process.env.APPHUB_SYNC_KEY; else process.env.APPHUB_SYNC_KEY = savedKey; });
function response() { return { setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } }; }
function fixture() {
  const row = { key: "app000000001:role000000001", cuId: KEY, profileKey: KEY, sourceObservationId: BINDING.sourceObservationId,
    richProfileBinding: BINDING, name: SOURCE.name, tier: "C" };
  const state = { [K.sourceProfile(KEY)]: structuredClone(SOURCE), [K.cards]: { [KEY]: { title: SOURCE.title } },
    [K.sourceProfileReady]: sourceReceiptsFor([row]), [K.facts]: { sentinel: "source facts" }, [K.decisions]: { sentinel: "human decision" }, [K.acks]: {} };
  publishInto(state, { snapshot: { generatedAt: AT, stream: [] }, queue: [row] });
  const writes = [];
  const deps = { kvReady: () => true, readJson: async (key) => state[key] ?? null, readHash: async (key) => state[key] || {},
    readHashMany: async (key, ids) => Object.fromEntries(ids.filter((id) => state[key]?.[id]).map((id) => [id, state[key][id]])),
    writeJson: async (key, value, ttl) => { writes.push([key, value, ttl]); state[key] = value; return "OK"; },
    writeHash: async (key, value) => { writes.push([key, value]); state[key] = { ...state[key], ...value }; return 1; },
    writeImmutableJson: async (key, value) => { if (state[key]) return null; state[key] = value; return "OK"; },
    activateGeneration: async (key, expected, value) => { state[key] = value; return true; },
    readHashKeys: async (key) => Object.keys(state[key] || {}),
    deleteHashFields: async (key, ids) => { for (const id of ids) delete state[key][id]; return ids.length; }, now: () => AT };
  return { row, state, writes, deps };
}
async function post(f, body) { const res = response(); await createSyncHandler(f.deps)({ method: "POST", headers: { authorization: `Bearer ${secret}` }, body }, res); return res; }
async function feed(f, extra = {}) { const res = response(); await createFeedHandler({ ...f.deps, now: () => Date.parse(AT), corsHandler: () => false, authHandler: async () => true, ...extra })({ method: "GET" }, res); return res; }
async function profile(f, extra = {}) { const res = response(); await createProfileHandler({ ...f.deps, now: () => Date.parse(AT), corsHandler: () => false, authHandler: async () => true, ...extra })({ method: "GET", query: { cu: KEY } }, res); return res; }
async function cards(f, extra = {}, query = {}) { const res = response(); const p = f.state[K.activeGeneration]; await createCardsHandler({ ...f.deps, now: () => Date.parse(AT), corsHandler: () => false, authHandler: async () => true, ...extra })({ method: "GET", query: { rich: "1", cus: KEY, generationId: p.generationId, generationDigest: p.digest, ...query } }, res); return res; }

test("rich publication lands only in three display stores and both reads preserve source identity", async () => {
  const f = fixture();
  const sourceBefore = structuredClone(f.state[K.sourceProfile(KEY)]);
  const res = await post(f, { richProfiles: { [KEY]: RICH } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.stored.richProfiles, 1);
  assert.deepEqual(f.writes.map(([key]) => key), [K.richProfile(KEY), K.richCards, K.richProfileReady]);
  assert.equal(f.writes[0][2], 30 * 24 * 60 * 60);
  assert.deepEqual(f.state[K.sourceProfile(KEY)], sourceBefore);
  assert.deepEqual(f.state[K.facts], { sentinel: "source facts" });
  assert.deepEqual(f.state[K.decisions], { sentinel: "human decision" });
  const list = await feed(f);
  assert.equal(list.statusCode, 200);
  assert.equal(list.body.snapshot.queue[0].name, SOURCE.name);
  assert.equal(list.body.snapshot.queue[0].tier, "C");
  assert.equal(list.body.cards[KEY].paraformProfile, undefined, "the feed stays bounded without nested provider payloads");
  const card = (await cards(f)).body.cards[KEY].paraformProfile;
  assert.equal(card.title, "Provider headline");
  assert.equal(card.exp[0].role, "Engineer");
  assert.equal(card.exp[0].company, "Example Company");
  assert.equal(card.exp[0].talentRank, "S");
  assert.equal(card.edu[0].logo, LOGO);
  assert.equal(card.expCount, 1); assert.equal(card.eduCount, 1);
  const modal = await profile(f);
  assert.equal(modal.body.name, SOURCE.name);
  assert.equal(modal.body.title, SOURCE.title);
  assert.equal(modal.body.paraformProfile.experiences[0].roleTitle, "Engineer");
  assert.equal(modal.body.paraformProfile.name, undefined);
});

for (const field of Object.keys(BINDING)) test(`a changed ${field} rejects the overlay without changing the application`, async () => {
  const f = fixture();
  const res = await post(f, { richProfiles: { [KEY]: { ...RICH, [field]: "changed000000000001" } } });
  assert.equal(res.body.stored.richProfiles, 0);
  assert.equal(res.body.rejected[KEY], "current_binding_mismatch");
  assert.deepEqual(f.writes, []);
  assert.equal((await feed(f)).body.snapshot.queue.length, 1);
});

test("source revision change suppresses a formerly valid overlay at both read paths", async () => {
  const f = fixture(); await post(f, { richProfiles: { [KEY]: RICH } });
  const moved = { ...f.row, sourceObservationId: "observation-two", richProfileBinding: { ...BINDING, sourceObservationId: "observation-two" } };
  publishInto(f.state, { generationId: "next-generation", snapshot: { generatedAt: AT, stream: [] }, queue: [moved] });
  f.state[K.sourceProfileReady] = sourceReceiptsFor([moved]);
  f.state[K.sourceProfile(KEY)] = { ...SOURCE, sourceObservationId: "observation-two" };
  assert.equal((await cards(f)).body.cards[KEY].paraformProfile, undefined);
  assert.equal((await profile(f)).body.paraformProfile, undefined);
});

test("missing active binding and unbound nested source values never bypass the overlay fence", async () => {
  const f = fixture();
  f.state[K.sourceProfile(KEY)].paraformProfile = RICH;
  f.state[K.cards][KEY].paraformProfile = RICH;
  assert.equal((await profile(f)).body.paraformProfile, undefined);
  assert.equal((await feed(f)).body.cards[KEY].paraformProfile, undefined);
  assert.equal(normalizeSourceProfiles({ [KEY]: { ...SOURCE, paraformProfile: RICH } }).ok, false);
  const noBinding = { ...f.row }; delete noBinding.richProfileBinding;
  publishInto(f.state, { generationId: "unbound-generation", snapshot: { generatedAt: AT, stream: [] }, queue: [noBinding] });
  assert.equal((await post(f, { richProfiles: { [KEY]: RICH } })).body.stored.richProfiles, 0);
});

test("refresh-due snapshots remain visible until retention ends", async () => {
  const f = fixture(); await post(f, { richProfiles: { [KEY]: RICH } });
  const day2 = { now: () => Date.parse(AT) + 2 * 86400_000 };
  assert.ok((await cards(f, day2)).body.cards[KEY].paraformProfile);
  assert.ok((await profile(f, day2)).body.paraformProfile);
  const day31 = { now: () => Date.parse(AT) + 31 * 86400_000 };
  assert.equal((await cards(f, day31)).body.cards[KEY].paraformProfile, undefined);
  assert.equal((await profile(f, day31)).body.paraformProfile, undefined);
});

test("optional store failure leaves the source feed and modal available", async () => {
  const f = fixture();
  const list = await feed(f, { readHash: async (key) => { if (key === K.richCards) throw new Error("cache unavailable"); return f.state[key] || {}; } });
  assert.equal(list.statusCode, 200); assert.equal(list.body.snapshot.queue.length, 1);
  const visible = await cards(f, { readHashMany: async (key, ids) => { if (key === K.richCards) throw new Error("cache unavailable"); return f.deps.readHashMany(key, ids); } });
  assert.equal(visible.statusCode, 200); assert.equal(visible.body.cards[KEY].paraformProfile, undefined);
  const modal = await profile(f, { readJson: async (key) => { if (key === K.activeGeneration) throw new Error("cache unavailable"); return f.state[key] ?? null; } });
  assert.equal(modal.statusCode, 200); assert.equal(modal.body.name, SOURCE.name);
});

test("a generation change during a modal read suppresses the optional overlay", async () => {
  const f = fixture(); await post(f, { richProfiles: { [KEY]: RICH } });
  const modal = await profile(f, { readJson: async (key) => {
    const value = f.state[key] ?? null;
    if (key === K.richProfile(KEY)) publishInto(f.state, {
      generationId: "changed-during-modal", snapshot: { generatedAt: AT, stream: [] }, queue: [f.row],
    });
    return value;
  } });
  assert.equal(modal.statusCode, 200);
  assert.equal(modal.body.name, SOURCE.name);
  assert.equal(modal.body.paraformProfile, undefined);
});

test("rich writes reject mixed mutation channels and invalid payloads before any write", async () => {
  for (const body of [
    { richProfiles: { [KEY]: RICH }, sourceProfiles: { [KEY]: SOURCE } },
    { richProfiles: { [KEY]: { ...RICH, profileEnrichedAt: "invalid" } } },
    { richProfiles: { [KEY]: { ...RICH, profileEnrichedAt: "2030-01-01T00:00:00Z" } } },
    { richProfiles: { [KEY]: { ...RICH, about: "x".repeat(31_000) } } },
  ]) { const f = fixture(); assert.equal((await post(f, body)).statusCode, 400); assert.deepEqual(f.writes, []); }
});

test("refresh receipts are read-only, explicit for absent keys, and written only after projections", async () => {
  const f = fixture(); await post(f, { richProfiles: { [KEY]: RICH } });
  const before = f.writes.length;
  const missing = "core:application000000000000002";
  const res = await post(f, { richProfileReceiptKeys: [KEY, missing] });
  assert.equal(f.writes.length, before);
  assert.equal(res.body.richProfileReceipts[missing], null);
  assert.equal(res.body.richProfileReceipts[KEY].source, "paraform");
  assert.equal(Date.parse(res.body.richProfileReceipts[KEY].expiresAt), Date.parse(AT) + 86400_000);
  const failed = fixture(); failed.deps.writeHash = async () => { throw new Error("write failed"); };
  assert.equal((await post(failed, { richProfiles: { [KEY]: RICH } })).statusCode, 502);
  assert.equal(failed.state[K.richProfileReady], undefined);
});

test("only explicit provider letters and verified logo URLs survive normalization", () => {
  const result = normalizeRichProfile({ ...RICH, paraformTierSource: "guessed", experiences: [{ companyName: "No ID", talentRank: "S", logo: "https://evil.test/logo.png" }] }, { cachedAt: AT });
  assert.equal(result.paraformTier, null); assert.equal(result.experiences[0].talentRank, null); assert.equal(result.experiences[0].logo, null);
  assert.equal(result.densityScore, .71);
  assert.equal(richCardFromProfile(normalizeRichProfile(RICH, { cachedAt: AT })).edu[0].talentRank, "B");
  for (const url of [LOGO + "?token=x", LOGO + "#fragment", LOGO.replace("https:", "http:"), LOGO.replace("storage.googleapis.com", "storage.googleapis.com.evil.test")]) assert.equal(richProfileLogo(url), null);
});

test("a full publication prunes expired rich hashes even while the application stays active", async () => {
  const f = fixture(); await post(f, { richProfiles: { [KEY]: RICH } });
  const expired = "2026-09-04T00:00:00Z";
  f.state[K.richCards][KEY].richProfileRetainedUntil = expired;
  f.state[K.richProfileReady][KEY].richProfileRetainedUntil = expired;
  const res = await post(f, publicationBody({ generationId: "prune-generation", snapshot: { generatedAt: AT, stream: [] }, queue: [f.row] }));
  assert.equal(res.statusCode, 200);
  assert.equal(f.state[K.richCards][KEY], undefined);
  assert.equal(f.state[K.richProfileReady][KEY], undefined);
  assert.equal(f.state[K.cards][KEY].title, SOURCE.title);
});

test("bounded rich card requests reject changed generations and never read more than 60 keys", async () => {
  const f = fixture(); await post(f, { richProfiles: { [KEY]: RICH } });
  assert.equal((await cards(f, {}, { generationId: "old-generation" })).statusCode, 409);
  const reads = [];
  const ids = Array.from({ length: 100 }, (_, i) => `core:application${String(i).padStart(16, "0")}`);
  const res = await cards(f, { readHashMany: async (key, keys) => { reads.push([key, keys.length]); return {}; } }, { cus: ids.join(",") });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(reads, [[K.cards, 60], [K.richCards, 60], [K.sourceProfileReady, 60]]);
  let pointerReads = 0;
  const raced = await cards(f, { readJson: async (key) => {
    if (key === K.activeGeneration && ++pointerReads > 1) return null;
    return f.state[key] ?? null;
  } });
  assert.equal(raced.statusCode, 409);
  f.state[K.sourceProfileReady][KEY].sourceObservationId = "new-observation-before-next-generation";
  assert.equal((await cards(f)).body.cards[KEY].paraformProfile, undefined);
});
