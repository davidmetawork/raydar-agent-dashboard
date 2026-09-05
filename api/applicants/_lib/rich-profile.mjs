// Optional Paraform display cache: never a source-history receipt or rule fact.
export const RICH_PROFILE_RETENTION_SECONDS = 30 * 24 * 60 * 60;
export const RICH_PROFILE_REFRESH_SECONDS = 24 * 60 * 60;
const FIELDS = ["sourceObservationId", "candidateUserId", "connectionReceiptId"];
const TIERS = new Set(["S", "A", "B", "C"]);
const str = (value, max = 500) => typeof value === "string" ? value.trim().slice(0, max) || null : null;
const date = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
const score = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;

export function richProfileBinding(value) {
  if (!value || FIELDS.some((field) => !str(value[field], 200) || value[field].length > 200)) return null;
  if (!/^[a-z0-9_-]{1,128}$/i.test(value.candidateUserId)) return null;
  return Object.fromEntries(FIELDS.map((field) => [field, value[field]]));
}

export function richBindingsForSnapshot(snapshot) {
  const bindings = new Map();
  const conflicts = new Set();
  for (const row of [...(snapshot?.queue || []), ...(snapshot?.stream || [])]) {
    const key = row?.profileKey || row?.cuId;
    const binding = richProfileBinding(row?.richProfileBinding);
    if (!key || !binding || binding.sourceObservationId !== row.sourceObservationId) continue;
    if (bindings.has(key) && FIELDS.some((field) => bindings.get(key)[field] !== binding[field])) conflicts.add(key);
    else bindings.set(key, binding);
  }
  for (const key of conflicts) bindings.delete(key);
  return bindings;
}

export function richProfileMatches(binding, profile, { now = Date.now() } = {}) {
  return Boolean(binding && profile?.profileSource === "paraform"
    && FIELDS.every((field) => binding[field] === profile[field])
    && date(profile.richProfileRetainedUntil) && Date.parse(profile.richProfileRetainedUntil) > now);
}

// Company/school logos use their own verified bucket, not the photo allowlist.
export function richProfileLogo(value) {
  if (typeof value !== "string" || value.length > 1000) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "storage.googleapis.com"
      && !url.username && !url.password && !url.port && !url.search && !url.hash
      && url.pathname.startsWith("/paraform-company-logo-urls/company-logos/")
      && url.pathname.length > "/paraform-company-logo-urls/company-logos/".length ? url.href : null;
  } catch { return null; }
}

export function normalizeRichProfile(input, { cachedAt = new Date().toISOString() } = {}) {
  const binding = richProfileBinding(input);
  if (!binding || !date(input.profileEnrichedAt)
    || Date.parse(input.profileEnrichedAt) > Date.parse(cachedAt) + 60_000
    || Buffer.byteLength(JSON.stringify(input)) > 30_000) return null;
  const tier = input.paraformTierSource === "paraform" && TIERS.has(input.paraformTier) && date(input.paraformTierObservedAt)
    ? input.paraformTier : null;
  const rank = (value) => TIERS.has(value) ? value : null;
  return {
    ...binding,
    profileSource: "paraform",
    profileEnrichedAt: input.profileEnrichedAt,
    profileProviderUpdatedAt: date(input.profileProviderUpdatedAt || input.updatedAt),
    updatedAt: date(input.updatedAt || input.profileProviderUpdatedAt),
    richProfileRefreshDueAt: new Date(Date.parse(cachedAt) + RICH_PROFILE_REFRESH_SECONDS * 1000).toISOString(),
    richProfileRetainedUntil: new Date(Date.parse(cachedAt) + RICH_PROFILE_RETENTION_SECONDS * 1000).toISOString(),
    title: str(input.title), location: str(input.location), about: str(input.about, 5000),
    densityScore: score(input.densityScore),
    paraformTier: tier,
    paraformTierSource: tier ? "paraform" : null,
    paraformTierObservedAt: tier ? input.paraformTierObservedAt : null,
    experiences: (Array.isArray(input.experiences) ? input.experiences : []).slice(0, 60).map((row) => ({
      companyId: str(row?.companyId, 100), companyName: str(row?.companyName), roleTitle: str(row?.roleTitle),
      start: str(row?.start, 100), end: str(row?.end, 100), current: row?.current === true,
      description: str(row?.description, 2000), location: str(row?.location), industry: str(row?.industry),
      aiTags: (Array.isArray(row?.aiTags) ? row.aiTags : []).map((tag) => str(tag, 100)).filter(Boolean).slice(0, 2),
      logo: richProfileLogo(row?.logo), talentRank: row?.companyId ? rank(row?.talentRank) : null,
    })),
    education: (Array.isArray(input.education) ? input.education : []).slice(0, 30).map((row) => ({
      schoolId: str(row?.schoolId, 100), school: str(row?.school), degree: str(row?.degree),
      start: str(row?.start, 100), end: str(row?.end, 100), logo: richProfileLogo(row?.logo),
      talentRank: row?.schoolId ? rank(row?.talentRank) : null,
    })),
  };
}

export function richCardFromProfile(profile) {
  const { about, experiences, education, ...common } = profile;
  return { ...common,
    exp: experiences.slice(0, 3).map(({ roleTitle, companyName, description, aiTags, industry, location, ...row }) =>
      ({ ...row, role: roleTitle, company: companyName })),
    edu: education.slice(0, 3), expCount: experiences.length, eduCount: education.length,
  };
}

export function sourceCardsOnly(cards) {
  return Object.fromEntries(Object.entries(cards || {}).map(([key, card]) => {
    const { paraformProfile, ...source } = card || {};
    return [key, source];
  }));
}

export function attachRichCards(cards, richCards, snapshot, options) {
  const result = sourceCardsOnly(cards);
  for (const [key, binding] of richBindingsForSnapshot(snapshot)) {
    const profile = richCards?.[key];
    if (richProfileMatches(binding, profile, options)) result[key] = { ...result[key], paraformProfile: profile };
  }
  return result;
}
