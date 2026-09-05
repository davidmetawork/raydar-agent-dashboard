// Private immutable funded-employer membership snapshots.
//
// The licensed source rows stay in server-only KV. Rules store one snapshot
// id, and the browser receives metadata only. A profile employer matches only
// through a reviewed Paraform company id. Company names, domains and LinkedIn
// URLs are retained as provenance but are never candidate identity signals.

import { getJson, K, setJson, setJsonIfAbsent } from "./kv.mjs";
import { stableDigest } from "./generation.mjs";

export const SNAPSHOT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,119}$/i;
export const QUALIFYING_COUNTRIES = Object.freeze(["CA", "GB", "US"]);
export const QUALIFYING_ROUND_TYPES = Object.freeze([
  "seed", "series_a", "series_b", "series_c", "series_d",
]);
export const QUALIFYING_FROM = "2011-09-05";
export const QUALIFYING_THROUGH = "2026-09-05";
export const MINIMUM_TOTAL_FUNDING_USD = 1_000_000;
export const MAX_SNAPSHOT_ENTRIES = 50_000;

const text = (value, max = 240) => {
  const out = typeof value === "string" ? value.trim() : "";
  return out && out.length <= max ? out : null;
};
const iso = (value) => {
  const out = text(value, 40);
  return out && Number.isFinite(Date.parse(out)) ? new Date(out).toISOString() : null;
};
const sameSet = (actual, expected) => Array.isArray(actual)
  && actual.length === expected.length
  && [...actual].sort().every((value, index) => value === [...expected].sort()[index]);

export function validateFundedEmployerCriteria(criteria) {
  if (!criteria || typeof criteria !== "object" || Array.isArray(criteria)) return "criteria_required";
  if (!sameSet(criteria.headquartersCountryCodes, QUALIFYING_COUNTRIES)) return "criteria_countries_invalid";
  if (criteria.minimumTotalFundingUsd !== MINIMUM_TOTAL_FUNDING_USD) return "criteria_funding_invalid";
  if (!sameSet(criteria.qualifyingFundingRoundTypes, QUALIFYING_ROUND_TYPES)) return "criteria_round_types_invalid";
  if (criteria.qualifyingRoundAnnouncedOnOrAfter !== QUALIFYING_FROM) return "criteria_round_start_invalid";
  if (criteria.qualifyingRoundAnnouncedOnOrBefore !== QUALIFYING_THROUGH) return "criteria_round_end_invalid";
  return null;
}

function normalizeDomain(value) {
  const raw = text(value, 240);
  if (!raw) return null;
  try {
    const parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return parsed.hostname.toLowerCase().replace(/^www\./, "") || null;
  } catch { return null; }
}

function qualifyingSearch(value) {
  if (typeof value === "string") return text(value, 20_000);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const encoded = JSON.stringify(value);
  return encoded.length <= 20_000 ? value : null;
}

function normalizedEntry(input, at) {
  const orgId = text(input?.orgId, 120);
  const name = text(input?.name, 240);
  const countryCode = text(input?.countryCode, 2)?.toUpperCase() ?? null;
  const domain = normalizeDomain(input?.domain);
  const totalFundingUsd = Number(input?.fundingProof?.totalFundingUsd);
  if (!orgId || !PROVIDER_ID_RE.test(orgId) || !name) throw new Error("funded_employer_identity_invalid");
  if (!QUALIFYING_COUNTRIES.includes(countryCode)) throw new Error("funded_employer_country_invalid");
  if (!domain) throw new Error("funded_employer_domain_invalid");
  if (!Number.isFinite(totalFundingUsd) || totalFundingUsd < MINIMUM_TOTAL_FUNDING_USD) {
    throw new Error("funded_employer_total_funding_invalid");
  }
  const rawParaformCompanyIds = (Array.isArray(input?.paraformCompanyIds)
    ? input.paraformCompanyIds : []).map((value) => text(value, 120));
  if (rawParaformCompanyIds.some((value) => !value || !PROVIDER_ID_RE.test(value))) {
    throw new Error("funded_employer_paraform_id_invalid");
  }
  const paraformCompanyIds = [...new Set(rawParaformCompanyIds)];
  const aliases = [...new Set((Array.isArray(input?.aliases) ? input.aliases : [])
    .map((value) => text(value, 240)).filter(Boolean))];
  return {
    orgId,
    name,
    legalName: text(input?.legalName, 240),
    aliases,
    countryCode,
    domain,
    linkedin: text(input?.linkedin, 500),
    paraformCompanyIds,
    fundingProof: {
      totalFundingUsd,
      // The Crunchbase company CSV proves the total; the snapshot's separately
      // retained qualifying-search manifest proves stage/date membership when
      // that export omits individual round UUIDs and announcement dates.
      cohortQualifiedByQuery: true,
      sourceRowId: text(input?.fundingProof?.sourceRowId, 160),
      observedAt: iso(input?.fundingProof?.observedAt) ?? at,
    },
  };
}

export function compileFundedEmployerSnapshot(manifest) {
  const snapshotId = text(manifest?.snapshotId, 80);
  if (!snapshotId || !SNAPSHOT_ID_RE.test(snapshotId)) throw new Error("funded_employer_snapshot_id_invalid");
  const generatedAt = iso(manifest?.generatedAt);
  if (!generatedAt) throw new Error("funded_employer_generated_at_invalid");
  const criteriaError = validateFundedEmployerCriteria(manifest?.criteria);
  if (criteriaError) throw new Error(criteriaError);
  const entriesInput = Array.isArray(manifest?.entries) ? manifest.entries : null;
  if (!entriesInput?.length || entriesInput.length > MAX_SNAPSHOT_ENTRIES) {
    throw new Error("funded_employer_entries_invalid");
  }
  const provenance = manifest?.provenance;
  const query = qualifyingSearch(provenance?.qualifyingSearch);
  const queryEvidenceSha256 = text(provenance?.queryEvidenceSha256, 64);
  if (!provenance || provenance.provider !== "crunchbase"
    || !text(provenance.sourceFileSha256, 64)?.match(/^[a-f0-9]{64}$/i)
    || !iso(provenance.exportedAt)
    || !query
    || (queryEvidenceSha256 && !/^[a-f0-9]{64}$/i.test(queryEvidenceSha256))) {
    throw new Error("funded_employer_provenance_invalid");
  }

  const entries = entriesInput.map((entry) => normalizedEntry(entry, generatedAt));
  const orgIds = new Set();
  const byParaformId = {};
  for (const entry of entries) {
    if (orgIds.has(entry.orgId)) throw new Error("funded_employer_org_id_duplicate");
    orgIds.add(entry.orgId);
    for (const companyId of entry.paraformCompanyIds) {
      if (byParaformId[companyId] && byParaformId[companyId].orgId !== entry.orgId) {
        throw new Error("funded_employer_paraform_id_ambiguous");
      }
      byParaformId[companyId] = { orgId: entry.orgId, name: entry.name };
    }
  }
  const canonical = {
    schemaVersion: 1,
    snapshotId,
    generatedAt,
    criteria: {
      headquartersCountryCodes: [...QUALIFYING_COUNTRIES],
      minimumTotalFundingUsd: MINIMUM_TOTAL_FUNDING_USD,
      qualifyingFundingRoundTypes: [...QUALIFYING_ROUND_TYPES],
      qualifyingRoundAnnouncedOnOrAfter: QUALIFYING_FROM,
      qualifyingRoundAnnouncedOnOrBefore: QUALIFYING_THROUGH,
    },
    provenance: {
      provider: "crunchbase",
      exportedAt: new Date(provenance.exportedAt).toISOString(),
      sourceFileSha256: provenance.sourceFileSha256.toLowerCase(),
      qualifyingSearch: query,
      queryEvidenceSha256: queryEvidenceSha256?.toLowerCase() ?? null,
    },
    entries,
    byParaformId,
  };
  const digest = stableDigest(canonical);
  return {
    snapshot: { ...canonical, digest },
    metadata: {
      id: snapshotId,
      generatedAt,
      companyCount: entries.length,
      reviewedParaformIdCount: Object.keys(byParaformId).length,
      digest,
      provider: "Crunchbase",
      criteria: manifest.criteria,
    },
  };
}

export async function importFundedEmployerSnapshot(manifest, {
  readJson = getJson,
  writeJson = setJson,
  writeIfAbsent = setJsonIfAbsent,
} = {}) {
  const compiled = compileFundedEmployerSnapshot(manifest);
  const key = K.fundedEmployerSnapshot(compiled.metadata.id);
  const created = await writeIfAbsent(key, compiled.snapshot);
  if (!created) {
    const existing = await readJson(key);
    if (existing?.digest !== compiled.metadata.digest) throw new Error("funded_employer_snapshot_id_conflict");
  }
  const catalog = await readJson(K.fundedEmployerCatalog);
  const snapshots = Array.isArray(catalog?.snapshots) ? catalog.snapshots : [];
  const next = {
    activeSnapshotId: compiled.metadata.id,
    snapshots: [...snapshots.filter((item) => item?.id !== compiled.metadata.id), compiled.metadata]
      .sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)))
      .slice(0, 24),
    updatedAt: new Date().toISOString(),
  };
  await writeJson(K.fundedEmployerCatalog, next);
  return { created: Boolean(created), catalog: next, metadata: compiled.metadata };
}

export async function readFundedEmployerCatalog({ readJson = getJson } = {}) {
  const catalog = await readJson(K.fundedEmployerCatalog);
  const snapshots = Array.isArray(catalog?.snapshots) ? catalog.snapshots.filter((item) =>
    item && SNAPSHOT_ID_RE.test(String(item.id || "")) && /^[a-f0-9]{64}$/i.test(String(item.digest || "")))
    .map((item) => ({
      id: String(item.id),
      generatedAt: iso(item.generatedAt),
      companyCount: Number.isInteger(item.companyCount) && item.companyCount >= 0 ? item.companyCount : 0,
      reviewedParaformIdCount: Number.isInteger(item.reviewedParaformIdCount) && item.reviewedParaformIdCount >= 0
        ? item.reviewedParaformIdCount : 0,
      digest: String(item.digest).toLowerCase(),
      provider: item.provider === "Crunchbase" ? "Crunchbase" : "Verified source",
      criteria: validateFundedEmployerCriteria(item.criteria) === null ? {
        headquartersCountryCodes: [...QUALIFYING_COUNTRIES],
        minimumTotalFundingUsd: MINIMUM_TOTAL_FUNDING_USD,
        qualifyingFundingRoundTypes: [...QUALIFYING_ROUND_TYPES],
        qualifyingRoundAnnouncedOnOrAfter: QUALIFYING_FROM,
        qualifyingRoundAnnouncedOnOrBefore: QUALIFYING_THROUGH,
      } : null,
    })) : [];
  return {
    activeSnapshotId: snapshots.some((item) => item.id === catalog?.activeSnapshotId)
      ? String(catalog.activeSnapshotId) : null,
    snapshots,
  };
}

export function fundedEmployerSnapshotIds(rules) {
  return [...new Set((Array.isArray(rules) ? rules : []).flatMap((rule) =>
    (Array.isArray(rule?.conditions) ? rule.conditions : [])
      .filter((condition) => condition?.field === "employment.fundedEmployerSnapshot")
      .map((condition) => condition.value)
      .filter((value) => typeof value === "string" && SNAPSHOT_ID_RE.test(value))))];
}

export async function loadFundedEmployerSnapshots(rules, { readJson = getJson } = {}) {
  const out = {};
  await Promise.all(fundedEmployerSnapshotIds(rules).map(async (snapshotId) => {
    let snapshot;
    try { snapshot = await readJson(K.fundedEmployerSnapshot(snapshotId)); }
    catch { return; }
    const digest = String(snapshot?.digest || "");
    const { digest: _storedDigest, ...payload } = snapshot && typeof snapshot === "object" ? snapshot : {};
    if (snapshot?.snapshotId !== snapshotId || snapshot?.schemaVersion !== 1
      || !/^[a-f0-9]{64}$/i.test(digest) || stableDigest(payload) !== digest
      || !snapshot?.byParaformId || typeof snapshot.byParaformId !== "object") return;
    out[snapshotId] = snapshot;
  }));
  return out;
}

export function matchFundedEmployer(company, snapshot) {
  const id = text(company?.id, 120);
  const matched = id ? snapshot?.byParaformId?.[id] : null;
  return matched ? { matched: true, companyName: company?.name || matched.name, orgId: matched.orgId } : null;
}
