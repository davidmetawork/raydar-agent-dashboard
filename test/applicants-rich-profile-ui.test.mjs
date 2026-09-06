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
  `${applicants.slice(start, end)}; ({ explicitParaformTier, paraformScore, formatParaformScore, allowedParaformLogo, entityLogoHtml, entityLogoFallback, entityTierHtml, richProfile, presentText, hasProviderProfile, hasProviderHistory, hasProviderContent, paraformRatingText, visibleCardProfile, profileFactsHtml })`,
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
  assert.equal(helpers.paraformScore(0), 0);
  assert.equal(helpers.paraformScore("0.73"), null);
  assert.equal(helpers.paraformScore(Infinity), null);
});

test("Paraform scores are rounded only when displayed", () => {
  assert.equal(helpers.formatParaformScore(0), "0");
  assert.equal(helpers.formatParaformScore(0.3033333333333333), "0.3");
  assert.equal(helpers.formatParaformScore(12.345), "12.35");
  assert.equal(helpers.formatParaformScore(null), "");
  assert.equal(helpers.formatParaformScore(NaN), "");
  assert.equal(helpers.formatParaformScore(Infinity), "");
  const provider = { paraformTier: "A", paraformTierSource: "paraform", densityScore: 0.3033333333333333 };
  assert.equal(helpers.paraformRatingText(provider), "A tier · score 0.3");
  assert.match(helpers.profileFactsHtml(provider), /Paraform score<\/span><span class="value">0\.3<\/span>/);
  assert.equal(provider.densityScore, 0.3033333333333333, "rendering never changes the cached numeric score");
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

test("logo accessible names describe loaded entities and become unavailable on image failure", () => {
  const publicLogo = "https://storage.googleapis.com/paraform-company-logo-urls/company-logos/synthetic.png";
  const company = helpers.entityLogoHtml({ logo: publicLogo, companyName: "A & <B>" }, "company");
  assert.match(company, /aria-label="A &amp; &lt;B&gt; company logo"/);
  assert.doesNotMatch(company, /logo unavailable/);
  assert.match(helpers.entityLogoHtml({ logo: publicLogo, school: "State University" }, "school"), /aria-label="State University school logo"/);
  assert.match(helpers.entityLogoHtml({ logo: publicLogo }, "school"), /aria-label="School logo"/);

  const attributes = new Map();
  const parent = {
    dataset: { kind: "company" },
    classList: { add: (name) => attributes.set("class", name) },
    setAttribute: (name, value) => attributes.set(name, value),
    innerHTML: "",
  };
  helpers.entityLogoFallback({ parentNode: parent });
  assert.equal(attributes.get("class"), "missing");
  assert.equal(attributes.get("aria-label"), "Company logo unavailable");
  assert.match(parent.innerHTML, /<svg/);
});

test("the compact overlay is used only for meaningful provider content", () => {
  const source = { title: "Application title", exp: [], edu: [] };
  const overlay = { title: "Cached LinkedIn headline", exp: [], edu: [], paraformTier: "C", paraformTierSource: "paraform" };
  const sparse = { paraformTier: "A", paraformTierSource: "paraform", densityScore: .71, updatedAt: "2026-09-01T00:00:00Z" };
  const overlayCard = { ...source, paraformProfile: overlay };
  const sparseCard = { ...source, paraformProfile: sparse };
  assert.equal(helpers.visibleCardProfile(overlayCard), overlay);
  assert.equal(helpers.visibleCardProfile(sparseCard), sparseCard);
  assert.equal(helpers.hasProviderProfile(sparse), false);
  assert.equal(helpers.hasProviderHistory(sparse), false);
  assert.equal(helpers.hasProviderContent(sparse), false);
  assert.equal(helpers.paraformRatingText(sparse), "A tier · score 0.71");
  assert.equal(helpers.visibleCardProfile(source), source);
  assert.match(helpers.entityTierHtml({ talentRank: "B" }), /Paraform B/);
  assert.equal(helpers.entityTierHtml({ talentRank: 3 }), "");
  assert.match(helpers.profileFactsHtml(overlay), /C tier/);
  assert.equal(helpers.profileFactsHtml({ updatedAt: "2026-09-01T00:00:00Z" }), "");
  assert.equal(helpers.profileFactsHtml(null), "");
});

const modalEnd = applicants.indexOf("/* ---- event delegation", start);
assert.ok(modalEnd > start, "modal rendering helpers are extractable from the shipped page");

function renderHarness({ card, profile, provider = null, source = "queue" }) {
  const profileCard = { innerHTML: "" };
  const row = { key: "row-one", profileKey: "core:one", cuId: "candidate-one", name: "Source Applicant", roleTitle: "Engineer", company: "Example Co", roleId: "role-one" };
  const STATE = {
    cards: { [row.profileKey]: card },
    photos: {},
    profiles: { [row.profileKey]: { ...profile, ...(provider ? { paraformProfile: provider } : {}) } },
    modal: { cu: row.profileKey, key: row.key, row, source },
    busy: new Set(),
  };
  const context = {
    STATE, esc,
    profileId: (value) => value?.profileKey || value?.cuId || "",
    cardFor: (cu) => STATE.cards[cu] || null,
    initials: () => "SA", avatarImg: () => "<img>",
    preferredLinkedinProfileUrl: () => "", liAnchor: () => "", pfAnchor: () => "", tierPill: () => "",
    monthYear: () => "September 2026", shortDate: () => "September 1", relTime: () => "now",
    duration: () => "", effectiveDecision: () => null, interviewHold: () => "", alreadyEmailed: () => false,
    ALREADY_EMAILED_ACTION_TITLE: "", $: (id) => id === "profileCard" ? profileCard : null,
  };
  const rendered = runInNewContext(`${applicants.slice(start, modalEnd)}; ({ historyHtml, renderModal })`, context);
  rendered.renderModal();
  return { card: rendered.historyHtml(row), modal: profileCard.innerHTML };
}

test("tier-only and identity-only overlays keep source card and modal history primary", () => {
  const sourceCard = { exp: [{ role: "Source card role", company: "Source Co" }], edu: [] };
  const sourceProfile = { name: "Source Applicant", title: "Application headline", updatedAt: "2026-09-01T00:00:00Z", experiences: [{ roleTitle: "Source modal role", companyName: "Source Co" }], education: [] };
  const tierOnly = { paraformTier: "A", paraformTierSource: "paraform", densityScore: .71, updatedAt: "2026-09-02T00:00:00Z" };
  const tier = renderHarness({ card: { ...sourceCard, paraformProfile: tierOnly }, profile: sourceProfile, provider: tierOnly });
  assert.match(tier.card, /Application profile/);
  assert.match(tier.card, /source record/);
  assert.match(tier.card, /Paraform rating/);
  assert.match(tier.card, /Paraform A tier · score 0.71/);
  assert.match(tier.card, /Source card role/);
  assert.doesNotMatch(tier.card, /Cached LinkedIn profile/);
  assert.match(tier.modal, /Paraform tier/);
  assert.match(tier.modal, /A tier/);
  assert.match(tier.modal, /Paraform score/);
  assert.match(tier.modal, /0.71/);
  assert.match(tier.modal, /Application profile <span>source record<\/span>/);
  assert.match(tier.modal, /Source modal role/);
  assert.doesNotMatch(tier.modal, /Cached LinkedIn profile/);
  assert.doesNotMatch(tier.modal, /<details class="p-source">/);

  const identityOnly = renderHarness({ card: { ...sourceCard, paraformProfile: { updatedAt: "2026-09-02T00:00:00Z" } }, profile: sourceProfile, provider: { updatedAt: "2026-09-02T00:00:00Z" } });
  assert.match(identityOnly.card, /Application profile.*source record/);
  assert.match(identityOnly.card, /Source card role/);
  assert.doesNotMatch(identityOnly.card, /Cached LinkedIn profile|Paraform rating/);
  assert.match(identityOnly.modal, /Application profile <span>source record<\/span>/);
  assert.match(identityOnly.modal, /Source modal role/);
  assert.match(identityOnly.modal, /Application profile as of/);
  assert.doesNotMatch(identityOnly.modal, /Cached LinkedIn profile|Paraform tier|Paraform score/);
});

test("headline-only overlays keep source history primary and real provider history stays read-only", () => {
  const sourceCard = { exp: [{ role: "Source card role", company: "Source Co" }], edu: [] };
  const sourceProfile = { name: "Source Applicant", title: "Application headline", experiences: [{ roleTitle: "Source modal role", companyName: "Source Co" }], education: [] };
  const headlineOnly = { title: "Cached LinkedIn headline", exp: [], edu: [], updatedAt: "2026-09-02T00:00:00Z" };
  const headline = renderHarness({ card: { ...sourceCard, paraformProfile: headlineOnly }, profile: sourceProfile, provider: headlineOnly });
  assert.match(headline.card, /Application profile.*source record/);
  assert.match(headline.card, /Source card role/);
  assert.doesNotMatch(headline.card, /Cached LinkedIn profile|Tier not provided/);
  assert.match(headline.modal, /Cached LinkedIn headline/);
  assert.match(headline.modal, /Cached LinkedIn profile · as of/);
  assert.match(headline.modal, /Application profile <span>source record<\/span>/);
  assert.match(headline.modal, /Source modal role/);
  assert.match(headline.modal, /data-rule-fact-kind="experience"/);
  assert.doesNotMatch(headline.modal, /<details class="p-source">/);

  const rich = { title: "Cached LinkedIn headline", experiences: [{ roleTitle: "Provider role", companyName: "Provider Co" }], education: [] };
  const full = renderHarness({ card: { ...sourceCard, paraformProfile: { title: rich.title, exp: [{ role: "Provider card role", company: "Provider Co" }], edu: [] } }, profile: sourceProfile, provider: rich });
  assert.match(full.modal, /Provider role/);
  assert.match(full.modal, /<details class="p-source">/);
  assert.match(full.modal, /Source modal role/);
  assert.doesNotMatch(full.modal.slice(0, full.modal.indexOf('<details class="p-source">')), /data-rule-fact-kind="experience"/);
});

test("the page preserves provenance and keeps rules on application history only", () => {
  assert.match(applicants, /const provider = richProfile\(p\.paraformProfile\);/);
  assert.match(applicants, /const providerProfile = hasProviderProfile\(provider\);/);
  assert.match(applicants, /const providerHistory = hasProviderHistory\(provider\);/);
  assert.match(applicants, /const primaryProfile = providerHistory \? provider : p;/);
  assert.match(applicants, /historySectionsHtml\(primaryProfile, \{ allowRuleFacts: !providerHistory && modal\.source === "queue", isParaformProfile: providerHistory \}\)/);
  assert.match(applicants, /historySectionsHtml\(p, \{ allowRuleFacts: modal\.source === "queue" \}\)/);
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
