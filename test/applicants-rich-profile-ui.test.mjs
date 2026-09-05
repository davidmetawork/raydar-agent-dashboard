import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const applicants = await readFile(new URL("../applicants.html", import.meta.url), "utf8");
const start = applicants.indexOf("const PARAFORM_TIERS");
const end = applicants.indexOf("function renderModal", start);
assert.ok(start >= 0 && end > start, "rich-profile helpers are extractable from the shipped page");

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[character]));
const helpers = runInNewContext(
  `${applicants.slice(start, end)}; ({ explicitParaformTier, paraformScore, allowedParaformLogo, entityLogoHtml, entityTierHtml, richProfile, visibleCardProfile, profileFactsHtml })`,
  { esc },
);

test("rich profile tiers are explicit provider letters; numbers never become a letter", () => {
  for (const tier of ["S", "A", "B", "C", " s "]) {
    assert.ok(helpers.explicitParaformTier(tier, "paraform"), tier);
  }
  for (const value of [3, 7, 0.73, "7", "D", "S", null, undefined]) {
    assert.equal(helpers.explicitParaformTier(value, value === "S" ? "application" : "paraform"), null, String(value));
  }
  assert.equal(helpers.paraformScore(0.73), 0.73);
  assert.equal(helpers.paraformScore("0.73"), null);
  assert.equal(helpers.paraformScore(Infinity), null);
});

test("only the confirmed public Paraform company-logo origin can render", () => {
  const publicLogo = "https://storage.googleapis.com/paraform-company-logo-urls/company-logos/synthetic.png";
  assert.equal(helpers.allowedParaformLogo(publicLogo), publicLogo);
  for (const rejected of [
    "https://storage.googleapis.com/paraform-images/company-logos/synthetic.png",
    "https://storage.googleapis.com/paraform-company-logo-urls.example.com/company-logos/x.png",
    `${publicLogo}?signature=secret`, `${publicLogo}#fragment`, `http${publicLogo.slice(5)}`,
    "https://media.licdn.com/dms/image/x.png", "", null,
  ]) assert.equal(helpers.allowedParaformLogo(rejected), "", String(rejected));
  const html = helpers.entityLogoHtml({ logo: publicLogo }, "company");
  assert.match(html, /referrerpolicy="no-referrer"/);
  assert.match(html, /onerror="entityLogoFallback\(this\)"/);
  assert.match(helpers.entityLogoHtml({ logo: "https://media.licdn.com/x.png" }, "school"), /School logo unavailable/);
});

test("the compact overlay wins for display without replacing the application profile", () => {
  const source = { title: "Application title", exp: [], edu: [] };
  const overlay = { title: "Cached LinkedIn headline", exp: [], edu: [], paraformTier: "C", paraformTierSource: "paraform" };
  assert.equal(helpers.visibleCardProfile({ ...source, paraformProfile: overlay }), overlay);
  assert.equal(helpers.visibleCardProfile(source), source);
  assert.match(helpers.entityTierHtml({ talentRank: "B" }), /Paraform B/);
  assert.equal(helpers.entityTierHtml({ talentRank: 3 }), "");
  assert.match(helpers.profileFactsHtml(overlay), /C tier/);
  assert.match(helpers.profileFactsHtml(null), /No cached LinkedIn profile is available/);
});

test("the page preserves provenance and keeps rules on application history only", () => {
  assert.match(applicants, /const provider = richProfile\(p\.paraformProfile\);/);
  assert.match(applicants, /const displayProfile = provider \|\| p;/);
  assert.match(applicants, /Cached LinkedIn profile · as of/);
  assert.match(applicants, /<details class="p-source"><summary>Application profile/);
  assert.match(applicants, /historySectionsHtml\(p, \{ allowRuleFacts: modal\.source === "queue" \}\)/);
  assert.match(applicants, /historySectionsHtml\(displayProfile, \{ allowRuleFacts: !provider && modal\.source === "queue", isParaformProfile: Boolean\(provider\) \}\)/);
  assert.match(applicants, /displayProfile\.title \|\| p\.title/);
  assert.doesNotMatch(applicants.slice(start, end), /paraformProfile\?\./);
});

const richStart = applicants.indexOf("const RICH_CARDS");
const richEnd = applicants.indexOf("function pendingRows", richStart);
assert.ok(richStart >= 0 && richEnd > richStart, "viewport rich-card helpers are extractable from the shipped page");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
async function settle() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}
function richHarness() {
  const requests = [];
  const patches = [];
  let feedLoads = 0;
  const STATE = {
    cards: {},
    generation: { generationId: "generation-one", digest: "digest-one" },
  };
  const context = {
    STATE,
    window: {},
    URLSearchParams,
    fetch: (url, options) => {
      const request = deferred();
      requests.push({ url, options, ...request });
      return request.promise;
    },
    showGate: () => { throw new Error("unexpected auth gate"); },
    patchRow: (id) => patches.push(id),
    loadFeed: async () => { feedLoads += 1; },
  };
  const source = `${applicants.slice(richStart, richEnd)}; ({ RICH_CARDS, syncRichGeneration, requestVisibleRichCards, cardFor })`;
  const helpers = runInNewContext(source, context);
  return { STATE, requests, patches, helpers, feedLoads: () => feedLoads };
}
function ok(generation, cards) {
  return { status: 200, ok: true, json: async () => ({ ok: true, generation, cards }) };
}

test("visible rich-card batches cap at 60, dedupe inflight ids, and ignore an old generation response", async () => {
  const h = richHarness();
  const ids = Array.from({ length: 80 }, (_, index) => `core:visible-${index}`);
  for (const id of ids) h.STATE.cards[id] = { title: `Application ${id}` };
  const rows = ids.map((profileKey, index) => ({ key: `row-${index}`, profileKey }));

  h.helpers.requestVisibleRichCards(rows);
  h.helpers.requestVisibleRichCards(rows.slice(0, 60));
  assert.equal(h.requests.length, 1, "repaint while a request is pending does not duplicate it");
  const first = new URL(h.requests[0].url, "https://fixture.invalid").searchParams;
  assert.equal(first.get("rich"), "1");
  assert.equal(first.get("generationId"), "generation-one");
  assert.equal(first.get("generationDigest"), "digest-one");
  assert.equal(first.get("cus").split(",").length, 60);

  h.STATE.generation = { generationId: "generation-two", digest: "digest-two" };
  h.helpers.syncRichGeneration();
  h.helpers.requestVisibleRichCards(rows.slice(0, 2));
  assert.equal(h.requests.length, 2);
  h.requests[0].resolve(ok({ generationId: "generation-one", digest: "digest-one" }, {
    [ids[0]]: { paraformProfile: { title: "stale provider profile" } },
  }));
  await settle();
  assert.equal(h.helpers.cardFor(ids[0]).paraformProfile, undefined, "an old response cannot paint into the newer generation");
  assert.deepEqual(h.patches, []);

  h.helpers.requestVisibleRichCards(rows.slice(0, 2));
  assert.equal(h.requests.length, 2, "the old finally handler leaves the newer request deduped");
  h.requests[1].resolve(ok({ generationId: "generation-two", digest: "digest-two" }, {
    [ids[0]]: { paraformProfile: { title: "current provider profile" } },
  }));
  await settle();
  assert.equal(h.helpers.cardFor(ids[0]).paraformProfile.title, "current provider profile");
  assert.deepEqual(h.patches, ids.slice(0, 2), "only the current visible rows are patched");
});

test("a rich-card generation conflict refreshes the feed once", async () => {
  const h = richHarness();
  const id = "core:conflict";
  h.STATE.cards[id] = { title: "Application" };
  h.helpers.requestVisibleRichCards([{ profileKey: id }]);
  h.requests[0].resolve({ status: 409, ok: false, json: async () => ({ ok: false, error: "generation_changed" }) });
  await settle();
  assert.equal(h.feedLoads(), 1);
});
