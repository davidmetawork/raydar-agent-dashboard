// Public, fail-closed US school-country evidence.
//
// This module resolves only a country fact. It intentionally has no Paraform
// identifiers and never claims accreditation, degree completion, ranking, or a
// campus identity. It is kept separate from facts.mjs so callers can combine
// it with the existing per-profile location/site evidence conservatively.

import DATA from "./school-country-registry-data.json" with { type: "json" };
import { locationNamesForeignCountry } from "./school-us.mjs";

/**
 * Preserve every word, including parenthetical campus/country qualifiers.
 * This is intentionally NOT school-top's normalizer: removing `(Qatar)` from
 * `Carnegie Mellon University (Qatar)` would turn foreign evidence into a US
 * match.
 */
export function normalizeSchoolCountryName(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const byNormalizedName = new Map();
for (const institution of DATA.institutions) {
  for (const normalized of [institution.nameNormalized, ...institution.aliasesNormalized]) {
    if (!normalized) continue;
    const rows = byNormalizedName.get(normalized) ?? [];
    rows.push(institution);
    byNormalizedName.set(normalized, rows);
  }
}

const reviewedByNormalizedName = new Map();
for (const alias of DATA.reviewedCountryOnlyAliases) {
  const candidates = reviewedByNormalizedName.get(alias.nameNormalized) ?? [];
  candidates.push(alias);
  reviewedByNormalizedName.set(alias.nameNormalized, candidates);
}

function locationExplicitlyNamesForeignCountry(location) {
  const text = String(location ?? "").trim();
  if (!text) return false;
  // `locationNamesForeignCountry` intentionally requires a comma-delimited
  // location. Add a neutral leading segment for a bare country such as
  // `India`, without changing school-us.mjs's established behavior.
  if (locationNamesForeignCountry(text)) return true;
  // A bare `Georgia` is ambiguous between the US state and the country. The
  // existing location helper deliberately refuses a bare state, so preserve
  // that fail-closed state behavior rather than turn it into a foreign veto.
  const bare = text.toLowerCase().replace(/\.$/, "").trim();
  if (bare === "georgia") return false;
  return locationNamesForeignCountry(`School, ${text}`);
}

function uniqueInstitution(normalized) {
  const candidates = byNormalizedName.get(normalized) ?? [];
  const unique = new Map(candidates.map((candidate) => [candidate.unitid, candidate]));
  return unique.size === 1 ? unique.values().next().value : null;
}

/**
 * Resolve public evidence that a school is in a US state or DC.
 *
 * `null` means unknown, ambiguous, a territory/policy case, no name, or a
 * location that explicitly names a foreign country, including a bare country
 * name such as `India`. `website` is accepted so
 * callers have one stable argument shape; this registry does not infer a
 * country from domains.
 */
export function resolveSchoolCountryEvidence({ name = null, location = null, website = null } = {}) {
  // Preserve the existing explicit-country veto. It beats a US name, a .edu
  // website, and every registry entry, including legacy foreign .edu holders.
  if (locationExplicitlyNamesForeignCountry(location)) return null;

  const nameNormalized = normalizeSchoolCountryName(name);
  if (!nameNormalized) return null;

  const institution = uniqueInstitution(nameNormalized);
  if (institution) {
    return {
      country: "United States",
      match: institution.nameNormalized === nameNormalized ? "ipeds_exact_name" : "ipeds_whole_alias",
      sourceURL: DATA.provenance.sourceURL,
      sourceVersion: "IPEDS HD2024",
      evidence: "NCES IPEDS Directory information exact normalized institution name or whole official alias",
      nameNormalized,
      unitid: institution.unitid,
      name: institution.name,
      state: institution.state,
      website: institution.website,
      ipedsActivityStatus: institution.ipedsActivityStatus,
    };
  }

  const reviewedCandidates = reviewedByNormalizedName.get(nameNormalized) ?? [];
  // Do not let duplicate reviewed aliases silently select whichever appeared
  // last in a generated file. Ambiguity is unknown until it is reviewed.
  if (reviewedCandidates.length !== 1) return null;
  const [reviewed] = reviewedCandidates;
  return {
    country: "United States",
    match: "reviewed_country_only_alias",
    sourceURL: reviewed.sourceURL,
    sourceVersion: `reviewed country-only alias ${reviewed.reviewedAt}`,
    evidence: reviewed.evidence,
    nameNormalized,
    // No campus or stable third-party identity is implied for a generic system
    // name. Keep these absent instead of selecting an IPEDS candidate.
    unitid: null,
    name: reviewed.name,
    state: null,
    website: null,
  };
}
