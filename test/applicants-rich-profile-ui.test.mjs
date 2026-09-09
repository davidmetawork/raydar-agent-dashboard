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

function renderHarness({ card, profile, provider = null, source = "queue", rowOverrides = {}, projected = null, profileState = "available" }) {
  const profileCard = { innerHTML: "" };
  const row = { key: "row-one", profileKey: "core:one", cuId: "candidate-one", name: "Source Applicant", roleTitle: "Engineer", company: "Example Co", roleId: "role-one", ...rowOverrides };
  const STATE = {
    cards: { [row.profileKey]: card },
    photos: {},
    profiles: profileState === "pending" ? {} : { [row.profileKey]: profileState === "failed" ? null : { ...profile, ...(provider ? { paraformProfile: provider } : {}) } },
    applicantRowsV2: projected ? { [row.key]: projected } : {},
    modal: { cu: row.profileKey, key: row.key, row, source },
    busy: new Set(),
  };
  const context = {
    STATE, esc,
    profileId: (value) => value?.profileKey || value?.cuId || "",
    applicantRowV2: (value) => STATE.applicantRowsV2?.[value?.key] || null,
    cardFor: (cu) => STATE.cards[cu] || null,
    initials: () => "SA", avatarImg: () => "<img>",
    preferredLinkedinProfileUrl: () => "", liAnchor: () => "", pfAnchor: () => "", tierPill: () => "",
    monthYear: () => "September 2026", shortDate: () => "September 1", relTime: () => "now",
    applicationMomentText: (value) => value?.appliedAt ? "Applied September 1" : "",
    DISPLAY_ONLY_SOURCE_HOLD_CODES: new Set(["source_held", "display_only_source_held"]),
    duration: () => "", effectiveDecision: () => null, interviewHold: () => "", alreadyEmailed: () => false,
    ALREADY_EMAILED_ACTION_TITLE: "", $: (id) => id === "profileCard" ? profileCard : null,
  };
  const selectedHelpers = applicants.slice(applicants.indexOf("function profileSelectionRefused("), applicants.indexOf("function richGenerationKey("));
  const rendered = runInNewContext(`${selectedHelpers}\n${applicants.slice(start, modalEnd)}; ({ historyHtml, renderModal })`, context);
  rendered.renderModal();
  return { card: rendered.historyHtml(row), modal: profileCard.innerHTML };
}

test("selected list history remains available in detail while its read is pending or fails", () => {
  const facts = {
    name: { value: "Selected Applicant", source: "application_source", freshness: "current", state: "fallback" },
    title: { value: "Selected headline", source: "application_source", freshness: "current", state: "fallback" },
    experiences: { entries: [{ roleTitle: "Selected engineer", companyName: "Selected Company", description: "Stored role description" }], source: "application_source", freshness: "current", state: "fallback" },
    education: { entries: [{ school: "Selected University", degree: "Computer Science" }], source: "application_source", freshness: "current", state: "fallback" },
  };
  for (const profileState of ["pending", "failed"]) {
    for (const factsCurrent of [true, false]) {
      const result = renderHarness({ card: {}, profileState,
        rowOverrides: { inputRevision: "input-one", decisionRevision: 0 },
        projected: { profile: { facts }, factSetDigest: "a".repeat(64), factsCurrent,
          inputRevision: "input-one", decisionRevision: 0 } });
      for (const value of ["Selected engineer", "Selected Company", "Selected University"]) {
        assert.ok(result.card.includes(value), value + " is present in the list");
        assert.ok(result.modal.includes(value), value + " remains present in the modal");
      }
      assert.match(result.modal, /Stored role description/);
      assert.match(result.modal, /Application source/);
      assert.doesNotMatch(result.modal, /Pulling the LinkedIn profile|Profile unavailable right now/);
      assert.equal(result.modal.includes('data-rule-fact-kind="experience"'), factsCurrent,
        "a failed detail read does not change the selected fact version's Rule authority");
    }
  }
  const unavailable = renderHarness({ card: {}, profileState: "failed" });
  assert.match(unavailable.modal, /Profile unavailable right now/);
});

test("profile detail preserves the exact applied-to company and labels an unknown source", () => {
  const known = renderHarness({ card: {}, profile: {}, rowOverrides: { company: "  Applied Co  " } }).modal;
  assert.match(known, /Applied to <b>Engineer<\/b> @ Applied Co/);
  const unknown = renderHarness({ card: {}, profile: {}, rowOverrides: { company: "" } }).modal;
  assert.match(unknown, /Applied to <b>Engineer<\/b> @ Unknown company/);
  assert.doesNotMatch(unknown, /Source Co|Provider Co/);
});

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

test("the page offers verified rich facts and source facts with separate provenance", () => {
  assert.match(applicants, /const provider = richProfile\(p\.paraformProfile\);/);
  assert.match(applicants, /const providerHistory = hasProviderHistory\(provider\);/);
  assert.match(applicants, /const primaryProfile = providerHistory \? provider : p;/);
  assert.match(applicants, /historySectionsHtml\(primaryProfile, \{ allowRuleFacts: canUseFact\(providerHistory \? "paraform" : "source"\), isParaformProfile: providerHistory \}\)/);
  assert.match(applicants, /historySectionsHtml\(p, \{ allowRuleFacts: canUseFact\("source"\) \}\)/);
  assert.match(applicants, /provider\?\.ruleFactsEligible === true/);
  assert.doesNotMatch(applicants.slice(start, end), /paraformProfile\?\./);
});

test("verified rich profile controls point to rich rows while source controls remain separate", () => {
  const profile = { title: "Source headline", location: "Source City", experiences: [{ companyId: "source-co", companyName: "Source Co", roleTitle: "Source role" }], education: [] };
  const provider = { ruleFactsEligible: true, location: "Rich City", title: "Rich headline", experiences: [{ companyId: "rich-co", companyName: "Rich Co", roleTitle: "Rich role" }], education: [{ schoolId: "rich-school", school: "Rich University" }] };
  const { modal } = renderHarness({ card: {}, profile, provider });
  const split = modal.indexOf('<details class="p-source">');
  assert.ok(split > 0);
  assert.match(modal.slice(0, split), /data-rule-fact-kind="experience" data-rule-fact-source="paraform" data-rule-fact-index="0"/);
  assert.match(modal.slice(0, split), /data-rule-fact-kind="education" data-rule-fact-source="paraform"/);
  assert.match(modal.slice(split), /data-rule-fact-kind="experience" data-rule-fact-source="source" data-rule-fact-index="0"/);
  assert.match(modal, /Rich City<button[^>]+data-rule-fact-kind="location" data-rule-fact-source="paraform"/);
  const stream = renderHarness({ card: {}, profile, provider, source: "stream" }).modal;
  assert.doesNotMatch(stream, /data-rule-fact-kind/);
  const fallback = renderHarness({ card: {}, profile, provider: { ...provider, location: null } }).modal;
  assert.match(fallback, /Source City<button[^>]+data-rule-fact-kind="location" data-rule-fact-source="source"/);
});

const richStart = applicants.indexOf("const RICH_CARDS");
const richEnd = applicants.indexOf("function pendingRows", richStart);
assert.ok(richStart >= 0 && richEnd > richStart, "viewport rich-card helpers are extractable from the shipped page");

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function settle() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}
function richHarness() {
  const requests = [];
  const patches = [];
  let feedLoads = 0;
  let now = Date.parse("2026-09-07T00:00:00Z");
  const STATE = {
    cards: {},
    generation: { generationId: "generation-one", digest: "digest-one" },
  };
  const context = {
    STATE,
    window: {},
    Date: { now: () => now },
    richProfile: (value) => value && typeof value === "object" && !Array.isArray(value) ? value : null,
    hasProviderHistory: (provider) => Boolean(provider && [provider.exp, provider.edu, provider.experiences, provider.education]
      .some((items) => Array.isArray(items) && items.length > 0)),
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
  return { STATE, requests, patches, helpers, feedLoads: () => feedLoads, advance: (milliseconds) => { now += milliseconds; } };
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

test("an absent rich card is retried after the bounded delay and can appear in the same generation", async () => {
  const h = richHarness();
  const id = "core:late-rich";
  const row = { profileKey: id };
  h.STATE.cards[id] = { title: "Application headline" };

  h.helpers.requestVisibleRichCards([row]);
  h.requests[0].resolve(ok(h.STATE.generation, { [id]: { title: "Application headline" } }));
  await settle();
  assert.equal(h.helpers.cardFor(id).paraformProfile, undefined);
  h.helpers.requestVisibleRichCards([row]);
  assert.equal(h.requests.length, 1, "a negative response cannot create a repaint request loop");

  h.advance(60_000);
  h.helpers.requestVisibleRichCards([row]);
  assert.equal(h.requests.length, 2);
  h.requests[1].resolve(ok(h.STATE.generation, {
    [id]: { title: "Separately read source headline", paraformProfile: {
      title: "Later cached LinkedIn headline", exp: [{ role: "Provider role", company: "Provider Co" }], edu: [],
    } },
  }));
  await settle();
  assert.equal(h.helpers.cardFor(id).title, "Application headline", "the rich side channel cannot replace the feed's source card");
  assert.equal(h.helpers.cardFor(id).paraformProfile.title, "Later cached LinkedIn headline");
  h.advance(60_000);
  h.helpers.requestVisibleRichCards([row]);
  assert.equal(h.requests.length, 2, "a positive overlay stays cached for the generation");
});

test("a sparse rich card stays visible while the same generation retries for provider history", async () => {
  const h = richHarness();
  const id = "core:sparse-rich";
  const row = { profileKey: id };
  h.STATE.cards[id] = { title: "Application headline" };
  const sparse = { title: "Cached LinkedIn headline", paraformTier: "A", paraformTierSource: "paraform", exp: [], edu: [] };

  h.helpers.requestVisibleRichCards([row]);
  h.requests[0].resolve(ok(h.STATE.generation, { [id]: { paraformProfile: sparse } }));
  await settle();
  assert.equal(h.helpers.cardFor(id).paraformProfile.title, "Cached LinkedIn headline");
  h.helpers.requestVisibleRichCards([row]);
  assert.equal(h.requests.length, 1);

  h.advance(60_000);
  h.helpers.requestVisibleRichCards([row]);
  assert.equal(h.requests.length, 2);
  h.requests[1].resolve(ok(h.STATE.generation, {
    [id]: { paraformProfile: { ...sparse, exp: [{ role: "Provider role", company: "Provider Co" }] } },
  }));
  await settle();
  assert.equal(h.helpers.cardFor(id).paraformProfile.exp[0].role, "Provider role");
  h.advance(60_000);
  h.helpers.requestVisibleRichCards([row]);
  assert.equal(h.requests.length, 2, "populated provider history completes the generation cache");
});

test("a transient rich-card error keeps source data and retries no faster than the bound", async () => {
  const h = richHarness();
  const id = "core:temporary-error";
  const row = { profileKey: id };
  h.STATE.cards[id] = { title: "Source remains visible" };

  h.helpers.requestVisibleRichCards([row]);
  h.requests[0].resolve({ status: 502, ok: false, json: async () => ({ ok: false, error: "cards_unavailable" }) });
  await settle();
  assert.equal(h.helpers.cardFor(id).title, "Source remains visible");
  h.helpers.requestVisibleRichCards([row]);
  assert.equal(h.requests.length, 1);
  h.advance(59_999);
  h.helpers.requestVisibleRichCards([row]);
  assert.equal(h.requests.length, 1);
  h.advance(1);
  h.helpers.requestVisibleRichCards([row]);
  assert.equal(h.requests.length, 2);
});

const profileFetchStart = applicants.indexOf("function invalidateProfileSelection");
const profileFetchEnd = applicants.indexOf("/* ---- profile modal", profileFetchStart);
assert.ok(profileFetchStart >= 0 && profileFetchEnd > profileFetchStart, "profile fetch helper is extractable from the shipped page");

function profileFetchHarness({ paged = false, projected = null } = {}) {
  const requests = [];
  let now = Date.parse("2026-09-07T00:00:00Z");
  const row = { key: "row-one", applicationId: "application-one", sourceObservationId: "observation-one",
    profileKey: "application:one:row", rowDigest: "d".repeat(64), name: "Selected Applicant",
    inputRevision: "input-one", decisionRevision: 0 };
  const STATE = { profiles: {}, generation: { generationId: "generation-one", digest: "digest-one" }, paged,
    snapshot: { queue: [row], stream: [] }, applicantRowsV2: { [row.key]: projected, sibling: { sentinel: true } },
    cards: { [row.profileKey]: { title: "Old selected headline" }, sibling: { sentinel: true } },
    photos: { [row.profileKey]: "old-photo", sibling: "sibling-photo" }, checked: new Set([row.key]), busy: new Set(), local: {} };
  let gates=0,ruleActions=0;
  const context = {
    STATE,
    Date: { now: () => now },
    encodeURIComponent,
    URLSearchParams,
    rowByCu: (cu) => STATE.snapshot.queue.find(candidate=>candidate.profileKey===cu),
    queueRows: () => STATE.snapshot.queue,
    window: { RaydarRuleFacts: { close() {} }, RaydarRules: { fromApplicant() { ruleActions++; } } },
    renderLists() {}, toast() {},
    richGenerationKey: () => `${STATE.generation.generationId}:${STATE.generation.digest}`,
    richProfile: (value) => value && typeof value === "object" && !Array.isArray(value) ? value : null,
    hasProviderHistory: (provider) => Boolean(provider && [provider.exp, provider.edu, provider.experiences, provider.education]
      .some((items) => Array.isArray(items) && items.length > 0)),
    showGate: () => { gates++; },
    fetch: (url, options) => {
      const request = deferred();
      requests.push({ url, options, ...request });
      return request.promise;
    },
  };
  const selectedHelpers = applicants.slice(applicants.indexOf("function profileSelectionRefused("), applicants.indexOf("function richGenerationKey("));
  const control = applicants.slice(applicants.indexOf("function interviewControl("), applicants.indexOf("function rowCardHtml("));
  const decide = applicants.slice(applicants.indexOf("async function decide("), applicants.indexOf("/* ---- visible shell band"));
  const rule = applicants.slice(applicants.indexOf("function makeRuleFrom("), applicants.indexOf('document.addEventListener("click", async (event)', applicants.indexOf("function makeRuleFrom(")));
  const source = `const RICH_RETRY_MS = 60_000; const PROFILE_RETRY_AT = new Map(); ${selectedHelpers}\n${control}\n${decide}\n${rule}\n${applicants.slice(profileFetchStart, profileFetchEnd)}; ({ fetchProfile, PROFILE_RETRY_AT, interviewControl, decide, makeRuleFrom })`;
  const extracted = runInNewContext(source, context);
  return { STATE, row, requests, helpers: extracted, gates:()=>gates, ruleActions:()=>ruleActions,
    advance: (milliseconds) => { now += milliseconds; } };
}

const selectedProjection = () => ({
  application: { applicationId: "application-one", sourceObservationId: "observation-one" },
  factSetDigest: "a".repeat(64), inputRevision: "input-one", decisionRevision: 0, factsCurrent: true,
  actionability: { eligibility: "ready" },
  profile: { facts: { experiences: { source: "application_source", state: "fallback", freshness: "current",
    entries: [{ roleTitle: "Stored engineer", companyName: "Stored Company" }] },
    education: { source: "application_source", state: "fallback", freshness: "current", entries: [{ school: "Stored University" }] } } },
});

test("paged transport and temporary 503 failures preserve exact selected facts", async () => {
  for (const failure of ["transport",503]) {
    const selected=selectedProjection(),h=profileFetchHarness({paged:true,projected:selected});
    const request=h.helpers.fetchProfile(h.row.profileKey);
    if(failure==="transport")h.requests[0].reject(new TypeError("network unavailable"));
    else h.requests[0].resolve({status:503,ok:false});
    await assert.rejects(request);
    assert.equal(h.STATE.applicantRowsV2[h.row.key],selected);
    assert.equal(h.row.profileReadRefused,undefined);
    const rendered=renderHarness({card:{},profileState:"failed",projected:selected,rowOverrides:h.row});
    assert.match(rendered.modal,/Stored Company/);assert.match(rendered.modal,/Stored University/);
    assert.equal(h.helpers.interviewControl(h.row).enabled,true);
  }
});

test("paged authoritative refusals erase only the exact cached selection and block actions until a fresh feed", async () => {
  for (const status of [400,401,403,404,409,500]) {
    const h=profileFetchHarness({paged:true,projected:selectedProjection()});
    const request=h.helpers.fetchProfile(h.row.profileKey);
    h.requests[0].resolve({status,ok:false});await assert.rejects(request);
    assert.equal(h.STATE.applicantRowsV2[h.row.key],undefined);
    assert.equal(h.STATE.cards[h.row.profileKey],undefined);assert.equal(h.STATE.photos[h.row.profileKey],undefined);
    assert.equal(h.STATE.applicantRowsV2.sibling.sentinel,true);assert.equal(h.STATE.cards.sibling.sentinel,true);
    assert.equal(h.STATE.photos.sibling,"sibling-photo");assert.equal(h.STATE.checked.has(h.row.key),false);
    assert.equal(h.helpers.interviewControl(h.row).enabled,false);
    await assert.rejects(h.helpers.decide(h.row.key,"pass",h.row,true),/Refresh Applicants/);
    h.helpers.makeRuleFrom(h.row.profileKey,h.row.key);assert.equal(h.ruleActions(),0);
    const rendered=renderHarness({card:{},profileState:"failed",rowOverrides:h.row});
    assert.match(rendered.modal,/Applicant needs refresh/);
    assert.doesNotMatch(rendered.modal,/Selected Applicant|Stored Company|Stored University|data-act=|data-rule-fact-kind=/);
    h.advance(120_000);await h.helpers.fetchProfile(h.row.profileKey);
    assert.equal(h.requests.length,1,"a timer cannot restore refused authority");
    assert.equal(h.gates(),[401,403].includes(status)?1:0);
  }
});

test("a validated paged detail replaces selected facts, while malformed or contained success cannot revive them",async()=>{
  for(const malformed of [false,'identity','contained']){
    const selected=selectedProjection(),h=profileFetchHarness({paged:true,projected:selected});
    const refreshed={...selected,factsCurrent:false,actionability:{eligibility:'unknown'},
      profile:{facts:{experiences:{entries:[],state:'unavailable'},education:{entries:[],state:'unavailable'}}}};
    const body={ok:true,name:'Selected Applicant',application:{applicationId:h.row.applicationId},profileV2:refreshed,
      row:{...h.row,factsCurrent:false,rowCurrent:false},
      generation:{generationId:'generation-one',generationDigest:'digest-one'}};
    if(malformed==='identity')body.row.applicationId='different-application';
    if(malformed==='contained')body.source='profile_reconstruction_pending';
    const request=h.helpers.fetchProfile(h.row.profileKey);h.requests[0].resolve(profileResponse(body));
    if(malformed){await assert.rejects(request);assert.equal(h.row.profileReadRefused,true);}
    else{await request;assert.equal(h.STATE.applicantRowsV2[h.row.key],refreshed);
      assert.equal(h.helpers.interviewControl(h.row).enabled,false);
      assert.equal(h.STATE.cards[h.row.profileKey].experiences,undefined);}
  }
});

test("a refusal invalidates the same immutable selection even after a feed replaces its row object",async()=>{
  for(const status of [401,403,409]){
    const h=profileFetchHarness({paged:true,projected:selectedProjection()});
    const request=h.helpers.fetchProfile(h.row.profileKey);
    const freshRow={...h.row};h.STATE.snapshot.queue=[freshRow];
    h.requests[0].resolve({status,ok:false});await assert.rejects(request);
    assert.equal(h.STATE.applicantRowsV2[h.row.key],undefined);
    assert.equal(freshRow.profileReadRefused,true);
    assert.equal(h.STATE.profileReadRefusals[h.row.key],true);
    assert.equal(h.helpers.interviewControl(freshRow).enabled,false);
    assert.equal(h.STATE.cards.sibling.sentinel,true);
  }
});

test("a prior refusal cannot invalidate a different row version or generation",async()=>{
  for(const changed of ['rowDigest','sourceObservationId','generation']){
    const selected=selectedProjection(),h=profileFetchHarness({paged:true,projected:selected});
    const request=h.helpers.fetchProfile(h.row.profileKey);
    const freshRow={...h.row};h.STATE.snapshot.queue=[freshRow];
    if(changed==='generation')h.STATE.generation={generationId:'generation-two',digest:'digest-two'};
    else freshRow[changed]='new-value';
    h.requests[0].resolve({status:409,ok:false});await assert.rejects(request);
    assert.equal(h.STATE.applicantRowsV2[h.row.key],selected);
    assert.equal(freshRow.profileReadRefused,undefined);
    assert.equal(h.STATE.profileReadRefusals?.[h.row.key],undefined);
    assert.equal(Object.hasOwn(h.STATE.profiles,h.row.profileKey),false);
  }
});

test("an older success cannot replace facts from a completed feed read of the same immutable row",async()=>{
  const selected=selectedProjection(),h=profileFetchHarness({paged:true,projected:selected});
  const request=h.helpers.fetchProfile(h.row.profileKey);
  h.STATE.snapshot.queue=[{...h.row}];
  const body={ok:true,application:{applicationId:h.row.applicationId},profileV2:{...selected,factsCurrent:false},
    row:{...h.row},generation:{generationId:'generation-one',generationDigest:'digest-one'}};
  h.requests[0].resolve(profileResponse(body));assert.equal(await request,null);
  assert.equal(h.STATE.applicantRowsV2[h.row.key],selected);
});

function profileResponse(profile) {
  return { status: 200, ok: true, json: async () => profile };
}

test("reopening a source-only modal can pick up a later rich profile in the same generation", async () => {
  const h = profileFetchHarness();
  const id = "core:late-modal";
  const source = { title: "Application headline", experiences: [{ roleTitle: "Source role" }] };

  const first = h.helpers.fetchProfile(id);
  h.requests[0].resolve(profileResponse(source));
  assert.equal((await first).paraformProfile, undefined);
  assert.equal(await h.helpers.fetchProfile(id), source);
  assert.equal(h.requests.length, 1, "reopening immediately uses the visible source response");

  h.advance(60_000);
  const second = h.helpers.fetchProfile(id);
  assert.equal(h.requests.length, 2);
  h.requests[1].resolve(profileResponse({ ...source, paraformProfile: { experiences: [{ roleTitle: "Provider role" }] } }));
  assert.equal((await second).paraformProfile.experiences[0].roleTitle, "Provider role");
  h.advance(60_000);
  await h.helpers.fetchProfile(id);
  assert.equal(h.requests.length, 2, "a positive modal overlay stays cached for the generation");
});

test("reopening a sparse rich modal retains its provider facts and later picks up history", async () => {
  const h = profileFetchHarness();
  const id = "core:sparse-modal";
  const sparse = {
    title: "Application headline",
    experiences: [{ roleTitle: "Source role" }],
    paraformProfile: { title: "Cached LinkedIn headline", paraformTier: "B", paraformTierSource: "paraform", experiences: [], education: [] },
  };

  const first = h.helpers.fetchProfile(id);
  h.requests[0].resolve(profileResponse(sparse));
  assert.equal((await first).paraformProfile.paraformTier, "B");
  assert.equal((await h.helpers.fetchProfile(id)).paraformProfile.title, "Cached LinkedIn headline");
  assert.equal(h.requests.length, 1);

  h.advance(60_000);
  const second = h.helpers.fetchProfile(id);
  assert.equal(h.requests.length, 2);
  h.requests[1].resolve(profileResponse({
    ...sparse,
    paraformProfile: { ...sparse.paraformProfile, experiences: [{ roleTitle: "Provider role" }] },
  }));
  assert.equal((await second).paraformProfile.experiences[0].roleTitle, "Provider role");
});

test("a failed modal request renders as unavailable and observes the same retry bound", async () => {
  const h = profileFetchHarness();
  const id = "core:modal-error";
  const first = h.helpers.fetchProfile(id);
  h.requests[0].resolve({ status: 502, ok: false, json: async () => ({ ok: false, error: "profile_unavailable" }) });
  await assert.rejects(first, /Profile fetch failed/);
  assert.equal(Object.hasOwn(h.STATE.profiles, id), true);
  assert.equal(h.STATE.profiles[id], null);
  assert.equal(await h.helpers.fetchProfile(id), null);
  assert.equal(h.requests.length, 1);
  h.advance(60_000);
  const second = h.helpers.fetchProfile(id);
  assert.equal(h.requests.length, 2);
  h.requests[1].resolve(profileResponse({ title: "Source profile recovered" }));
  assert.equal((await second).title, "Source profile recovered");
});
