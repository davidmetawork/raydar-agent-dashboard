// Private immutable funded-employer membership snapshots.
//
// The source rows stay in server-only KV. Rules store one snapshot
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

const SOURCE_KINDS = new Set(["crunchbase_query_export", "public_primary_sources", "crunchbase_2013_snapshot"]);

function httpsUrl(value) {
  const raw = text(value, 2_000);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch { return null; }
}

function calendarDate(value) {
  const raw = text(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw || "")) return null;
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === raw ? raw : null;
}

function normalizedSource(input) {
  const id = text(input?.id, 120);
  const kind = text(input?.kind, 80);
  if (!id || !PROVIDER_ID_RE.test(id) || !SOURCE_KINDS.has(kind)) {
    throw new Error("funded_employer_source_invalid");
  }
  if (kind === "crunchbase_query_export") {
    const exportedAt = iso(input?.exportedAt);
    const sourceFileSha256 = text(input?.sourceFileSha256, 64);
    const query = qualifyingSearch(input?.qualifyingSearch);
    const queryEvidenceSha256 = text(input?.queryEvidenceSha256, 64);
    if (!exportedAt || !/^[a-f0-9]{64}$/i.test(sourceFileSha256 || "") || !query
      || (queryEvidenceSha256 && !/^[a-f0-9]{64}$/i.test(queryEvidenceSha256))) {
      throw new Error("funded_employer_crunchbase_source_invalid");
    }
    return {
      id, kind, exportedAt,
      sourceFileSha256: sourceFileSha256.toLowerCase(),
      qualifyingSearch: query,
      queryEvidenceSha256: queryEvidenceSha256?.toLowerCase() ?? null,
    };
  }
  if (kind === "crunchbase_2013_snapshot") {
    const observedAt = iso(input?.observedAt);
    const sourceFileSha256 = text(input?.sourceFileSha256, 64);
    const datasetUrl = httpsUrl(input?.datasetUrl);
    const attribution = text(input?.attribution, 160);
    if (!observedAt || !/^[a-f0-9]{64}$/i.test(sourceFileSha256 || "") || !datasetUrl
      || attribution !== "Crunchbase 2013 Snapshot © 2013") {
      throw new Error("funded_employer_historical_source_invalid");
    }
    return {
      id, kind, observedAt, sourceFileSha256: sourceFileSha256.toLowerCase(), datasetUrl, attribution,
      snapshotAsOf: "2013-12-31",
      licenseUrl: "https://data.crunchbase.com/docs/license-agreement",
      // The dated historical source can include companies that later exited.
      // Omit the first boundary month because source dates can be imputed.
      qualifyingFrom: "2011-10-01",
      qualifyingThrough: "2013-12-31",
    };
  }
  const observedAt = iso(input?.observedAt);
  const ledgerSha256 = text(input?.ledgerSha256, 64);
  if (!observedAt || (ledgerSha256 && !/^[a-f0-9]{64}$/i.test(ledgerSha256))) {
    throw new Error("funded_employer_public_source_invalid");
  }
  return {
    id, kind, observedAt,
    ledgerSha256: ledgerSha256?.toLowerCase() ?? null,
    label: text(input?.label, 240),
  };
}

function normalizedEntry(input, at, sourcesById) {
  const orgId = text(input?.orgId, 120);
  const name = text(input?.name, 240);
  const countryCode = text(input?.countryCode, 2)?.toUpperCase() ?? null;
  const domain = normalizeDomain(input?.domain);
  const totalFundingUsd = Number(input?.fundingProof?.totalFundingUsd);
  const sourceRef = text(input?.sourceRef, 120);
  if (!orgId || !PROVIDER_ID_RE.test(orgId) || !name) throw new Error("funded_employer_identity_invalid");
  if (!QUALIFYING_COUNTRIES.includes(countryCode)) throw new Error("funded_employer_country_invalid");
  if (!Number.isFinite(totalFundingUsd) || totalFundingUsd < MINIMUM_TOTAL_FUNDING_USD) {
    throw new Error("funded_employer_total_funding_invalid");
  }
  const source = sourceRef ? sourcesById.get(sourceRef) : null;
  if (!source) throw new Error("funded_employer_source_ref_invalid");
  if (!domain && (source.kind !== "crunchbase_2013_snapshot"
    || (Array.isArray(input?.paraformCompanyIds) && input.paraformCompanyIds.length))) {
    throw new Error("funded_employer_domain_invalid");
  }
  const qualification = input?.fundingProof?.qualification;
  let normalizedQualification;
  let totalFundingSourceUrl = null;
  if (qualification?.kind === "query_cohort") {
    if (source.kind !== "crunchbase_query_export" || qualification.sourceRef !== sourceRef) {
      throw new Error("funded_employer_query_qualification_invalid");
    }
    normalizedQualification = { kind: "query_cohort", sourceRef };
  } else if (qualification?.kind === "historical_round") {
    const stage = text(qualification.stage, 40)?.toLowerCase() ?? null;
    const announcedDate = calendarDate(qualification.announcedDate);
    const sourceRoundId = text(qualification.sourceRoundId, 120);
    const sourceObjectId = text(qualification.sourceObjectId, 120);
    const rawCode = text(qualification.rawRoundCode, 20)?.toLowerCase() ?? null;
    const codeToStage = { seed: "seed", a: "series_a", b: "series_b", c: "series_c", d: "series_d" };
    const amountUsd = qualification.amountUsd == null ? null : Number(qualification.amountUsd);
    if (source.kind !== "crunchbase_2013_snapshot" || !sourceRoundId || !sourceObjectId
      || !Object.hasOwn(codeToStage, rawCode) || codeToStage[rawCode] !== stage
      || !announcedDate || announcedDate < source.qualifyingFrom || announcedDate > source.qualifyingThrough
      || (amountUsd != null && (!Number.isFinite(amountUsd) || amountUsd < 0))) {
      throw new Error("funded_employer_historical_round_invalid");
    }
    totalFundingSourceUrl = source.datasetUrl;
    normalizedQualification = {
      kind: "historical_round", stage, announcedDate, amountUsd, sourceRoundId, sourceObjectId,
      rawRoundCode: rawCode, rawRoundType: text(qualification.rawRoundType, 80),
      sourceUrl: text(qualification.sourceUrl, 2000),
    };
  } else if (qualification?.kind === "explicit_round") {
    if (source.kind !== "public_primary_sources") {
      throw new Error("funded_employer_round_source_invalid");
    }
    const stage = text(qualification.stage, 40)?.toLowerCase() ?? null;
    const announcedDate = calendarDate(qualification.announcedDate);
    const amountUsd = Number(qualification.amountUsd);
    const primarySourceUrl = httpsUrl(qualification.primarySourceUrl);
    totalFundingSourceUrl = httpsUrl(input?.fundingProof?.totalFundingSourceUrl);
    if (!QUALIFYING_ROUND_TYPES.includes(stage)
      || !announcedDate
      || announcedDate < QUALIFYING_FROM || announcedDate > QUALIFYING_THROUGH
      || !Number.isFinite(amountUsd) || amountUsd <= 0 || amountUsd > totalFundingUsd
      || !primarySourceUrl || !totalFundingSourceUrl) {
      throw new Error("funded_employer_explicit_round_invalid");
    }
    normalizedQualification = {
      kind: "explicit_round", stage, announcedDate, amountUsd, primarySourceUrl,
    };
  } else {
    throw new Error("funded_employer_qualification_invalid");
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
    sourceRef,
    paraformCompanyIds,
    fundingProof: {
      totalFundingUsd,
      totalFundingBasis: text(input?.fundingProof?.totalFundingBasis, 120),
      totalFundingSourceUrl,
      sourceRowId: text(input?.fundingProof?.sourceRowId, 160),
      observedAt: iso(input?.fundingProof?.observedAt) ?? at,
      qualification: normalizedQualification,
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
  const sourceInputs = Array.isArray(manifest?.provenance?.sources) ? manifest.provenance.sources : null;
  if (!sourceInputs?.length || sourceInputs.length > 100) {
    throw new Error("funded_employer_provenance_invalid");
  }
  const sources = sourceInputs.map(normalizedSource);
  const sourcesById = new Map();
  for (const source of sources) {
    if (sourcesById.has(source.id)) throw new Error("funded_employer_source_duplicate");
    sourcesById.set(source.id, source);
  }

  const entries = entriesInput.map((entry) => normalizedEntry(entry, generatedAt, sourcesById));
  const orgIds = new Set();
  const byParaformId = Object.create(null);
  for (const entry of entries) {
    if (orgIds.has(entry.orgId)) throw new Error("funded_employer_org_id_duplicate");
    orgIds.add(entry.orgId);
    for (const companyId of entry.paraformCompanyIds) {
      if (Object.hasOwn(byParaformId, companyId) && byParaformId[companyId].orgId !== entry.orgId) {
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
    provenance: { sources },
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
      provider: sources.every((source) => source.kind === "crunchbase_query_export")
        ? "Crunchbase" : sources.every((source) => source.kind === "public_primary_sources")
          ? "Public primary sources" : sources.every((source) => source.kind === "crunchbase_2013_snapshot")
            ? "Crunchbase 2013 Snapshot" : "Mixed verified sources",
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
      provider: ["Crunchbase", "Public primary sources", "Crunchbase 2013 Snapshot", "Mixed verified sources"].includes(item.provider)
        ? item.provider : "Verified sources",
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
  const out = Object.create(null);
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
  const index = snapshot?.byParaformId;
  const matched = id && index && typeof index === "object" && Object.hasOwn(index, id)
    ? index[id] : null;
  return matched ? { matched: true, companyName: company?.name || matched.name, orgId: matched.orgId } : null;
}
