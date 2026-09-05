import { createHash } from "node:crypto";

import { paraformRoleLink } from "./email-source-policy.mjs";

export const EXPLICIT_ROLE_RESOLUTION_VERSION = "candidate-explicit-role-v1";
export const EXPLICIT_ROLE_CATALOG_MAX_AGE_MS = 24 * 60 * 60_000;

const text = (value, limit = 100_000) => String(value ?? "").trim().slice(0, limit);
const sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");
const TRAILING_ROLE_BOUNDARIES = new Set([
  "and", "but", "because", "caught", "that", "i", "im", "please", "so", "sounds", "looks", "seems",
  "is", "are", "was", "were", "would", "could", "can", "will", "lets", "thanks",
]);

export function normalizedRolePhrase(value) {
  const prepared = text(value, 2_000)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[’']s\b/gu, " ")
    .replace(/&/gu, " and ");
  return (prepared.match(/\.[\p{L}\p{N}]+|[\p{L}\p{N}]+(?:\+\+|#)|[\p{L}\p{N}]+(?:[./][\p{L}\p{N}]+)+|[\p{L}\p{N}]+/gu) || []).join(" ");
}

function tokens(value) {
  const normalized = normalizedRolePhrase(value);
  return normalized ? normalized.split(" ") : [];
}

function starts(haystack, needle) {
  const found = [];
  if (!needle.length || needle.length > haystack.length) return found;
  for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    if (needle.every((token, offset) => haystack[index + offset] === token)) found.push(index);
  }
  return found;
}

function pairedOccurrences(segmentTokens, companyTokens, titleTokens) {
  const companies = starts(segmentTokens, companyTokens);
  const titles = starts(segmentTokens, titleTokens);
  const pairs = [];
  for (const companyStart of companies) {
    const companyEnd = companyStart + companyTokens.length;
    for (const titleStart of titles) {
      const titleEnd = titleStart + titleTokens.length;
      const companyToTitle = segmentTokens.slice(companyEnd, titleStart);
      const titleToCompany = segmentTokens.slice(titleEnd, companyStart);
      const connector = (between) => between.length === 0
        || (between.length === 1 && ["at", "with", "for"].includes(between[0]));
      const titleToCompanyConnector = connector(titleToCompany)
        || (titleToCompany.length === 2
          && ["role", "position"].includes(titleToCompany[0])
          && titleToCompany[1] === "at");
      const pairEnd = Math.max(companyEnd, titleEnd);
      const hasTrailingBoundary = pairEnd === segmentTokens.length
        || TRAILING_ROLE_BOUNDARIES.has(segmentTokens[pairEnd]);
      if (companyEnd <= titleStart && connector(companyToTitle) && hasTrailingBoundary) {
        pairs.push({ companyStart, companyEnd, titleStart, titleEnd });
      } else if (titleEnd <= companyStart && titleToCompanyConnector && hasTrailingBoundary) {
        pairs.push({ companyStart, companyEnd, titleStart, titleEnd });
      }
    }
  }
  return pairs;
}

function authoredSegments(value) {
  return text(value).split(/\r?\n|[•●▪◦]|;/gu)
    .map((raw) => ({ raw: raw.trim(), tokens: tokens(raw) }))
    .filter((segment) => segment.tokens.length);
}

function containsQuotedHistory(value) {
  return /(?:^|\n)\s*(?:On [\s\S]{0,500}?wrote:|[-_]{2,}\s*(?:Original|Forwarded) Message|Begin forwarded message:|From:\s)/iu.test(value)
    || /(?:^|\n)\s*>/u.test(value)
    || /<(?:blockquote\b|div\b[^>]*\bclass=["'][^"']*\b(?:gmail_quote|yahoo_quoted)\b)/iu.test(value);
}

function paraformUrlEvidence(value) {
  const links = [];
  const candidates = text(value).match(/(?:https?:\/\/|www\.|\bparaform\.com\/)[^\s<>"']+/giu) || [];
  for (const raw of candidates) {
    if (!/paraform\.com/iu.test(raw)) continue;
    const linked = paraformRoleLink(raw);
    if (!linked) return { status: "invalid", links: [] };
    links.push({ ...linked, raw });
  }
  return { status: "ready", links };
}

function listEntryKey(value, linkedUrls) {
  let candidate = String(value || "");
  for (const linked of linkedUrls) candidate = candidate.replace(linked.raw, " ");
  candidate = candidate.replace(/^\s*(?:[-*]|\d+[.)])\s+/u, "").trim();
  // A dash is a list separator only when at least one side has whitespace;
  // ordinary hyphenated prose must not create a second synthetic list item.
  const strongParts = candidate.split(/(?:\s+[-–—|]\s*|\s*[-–—|]\s+)|\s*:\s+/u);
  if (strongParts.length >= 2 && strongParts.filter((part) => normalizedRolePhrase(part)).length >= 2) {
    return normalizedRolePhrase(candidate);
  }
  const compactCapitalized = candidate.match(/^([^-]+)-([^-]+)$/u);
  if (compactCapitalized && tokens(candidate).length <= 8
    && /^\s*\p{Lu}/u.test(compactCapitalized[1])
    && /^\s*\p{Lu}/u.test(compactCapitalized[2])) {
    return normalizedRolePhrase(candidate);
  }
  // Word connectors are accepted by the exact matcher, so a short standalone
  // list row using one must also participate in the all-or-nothing guard.
  if (!/[,;.!?]/u.test(candidate) && tokens(candidate).length <= 8) {
    const connector = candidate.match(/^(.+?)\s+(?:at|with|for)\s+(.+)$/iu);
    if (connector && /^\s*\p{Lu}/u.test(connector[1]) && /^\s*\p{Lu}/u.test(connector[2])) {
      return normalizedRolePhrase(candidate);
    }
  }
  return null;
}

function roleRow(raw) {
  const roleId = text(raw?.role_id, 200);
  const company = text(raw?.company_name ?? raw?.company, 300);
  const title = text(raw?.role_title ?? raw?.title, 500);
  const confirmedAt = Date.parse(raw?.last_confirmed_at || "");
  return {
    role_id: roleId,
    company,
    title,
    url: text(raw?.destination_url ?? raw?.url, 1_000)
      || `https://www.paraform.com/browse?role=${encodeURIComponent(roleId)}`,
    active: raw?.active === true,
    confirmed_at: Number.isFinite(confirmedAt) ? confirmedAt : null,
    company_key: normalizedRolePhrase(company),
    title_key: normalizedRolePhrase(title),
  };
}

function freshActive(role, now) {
  return role.active && role.confirmed_at !== null
    && role.confirmed_at <= now
    && now - role.confirmed_at <= EXPLICIT_ROLE_CATALOG_MAX_AGE_MS;
}

function resolutionEvidence({ candidateText, catalogDigest, matches }) {
  const matchKinds = [...new Set(matches.map((match) => match.kind))].sort();
  const roleEvidenceDigest = sha256(JSON.stringify({
    candidate_text_digest: sha256(candidateText),
    roles: matches.map(({ role, kind }) => ({ role_id: role.role_id, kind })),
  }));
  return {
    resolution_version: EXPLICIT_ROLE_RESOLUTION_VERSION,
    exact_role_source: "candidate_authored_explicit",
    role_evidence_digest: roleEvidenceDigest,
    role_catalog_digest: catalogDigest,
    match_kinds: matchKinds,
    resolved_role_count: matches.length,
  };
}

/**
 * Bind only exact role URLs or a normalized full company + full title pair in
 * the candidate-authored reply. This scopes classification; it never decides
 * candidate intent.
 */
export function resolveExplicitCandidateRoles(candidateText, catalog, { now = Date.now() } = {}) {
  const reply = String(candidateText ?? "").trim();
  if (reply.length > 6_000) {
    return { status: "unresolved", reason: "candidate_text_too_large", roles: [] };
  }
  if (containsQuotedHistory(reply)) {
    return { status: "unresolved", reason: "candidate_text_contains_quoted_history", roles: [] };
  }
  if (!reply || catalog?.status !== "ready" || catalog?.complete !== true
    || !Array.isArray(catalog.roles) || !/^[a-f0-9]{64}$/u.test(String(catalog.digest || ""))) {
    return { status: "unresolved", reason: "catalog_unavailable", roles: [] };
  }
  if (catalog.roles.length < 1 || catalog.roles.length > 5_000) {
    return { status: "unresolved", reason: "catalog_incomplete", roles: [] };
  }

  const rows = catalog.roles.map(roleRow);
  if (rows.some((role) => !role.role_id || !role.company_key || !role.title_key)) {
    return { status: "unresolved", reason: "catalog_invalid", roles: [] };
  }
  const byId = new Map();
  for (const role of rows) {
    if (byId.has(role.role_id)) return { status: "unresolved", reason: "catalog_role_duplicate", roles: [] };
    byId.set(role.role_id, role);
  }

  const matched = new Map();
  const urlEvidence = paraformUrlEvidence(reply);
  if (urlEvidence.status !== "ready") {
    return { status: "unresolved", reason: "role_url_invalid", roles: [] };
  }
  for (const linked of urlEvidence.links) {
    const role = byId.get(linked.role_id);
    if (!role || !freshActive(role, now)) {
      return { status: "unresolved", reason: "role_url_unavailable", roles: [] };
    }
    matched.set(role.role_id, { role, kind: "paraform_role_url" });
  }

  const pairGroups = new Map();
  for (const role of rows) {
    const key = `${role.company_key}\0${role.title_key}`;
    const group = pairGroups.get(key) || [];
    group.push(role);
    pairGroups.set(key, group);
  }
  const segments = authoredSegments(reply);
  const namedCandidates = [];
  for (const group of pairGroups.values()) {
    const sample = group[0];
    const companyTokens = sample.company_key.split(" ");
    const titleTokens = sample.title_key.split(" ");
    const occurrences = segments.flatMap((segment, segmentIndex) => (
      pairedOccurrences(segment.tokens, companyTokens, titleTokens).map((span) => ({ ...span, segmentIndex }))
    ));
    if (!occurrences.length) continue;
    if (group.length !== 1) {
      // An exact URL may pick one immutable id from a duplicate-label group;
      // the ambiguous text itself must never add another id.
      if (!group.some((role) => matched.has(role.role_id))) {
        return { status: "unresolved", reason: "role_label_ambiguous", roles: [] };
      }
      continue;
    }
    const role = group[0];
    if (!freshActive(role, now)) return { status: "unresolved", reason: "role_label_unavailable", roles: [] };
    namedCandidates.push({ role, occurrences, titleTokenCount: titleTokens.length });
  }
  for (const candidate of namedCandidates) {
    const hasIndependentOccurrence = candidate.occurrences.some((occurrence) => !namedCandidates.some((other) => (
      other !== candidate
      && other.role.company_key === candidate.role.company_key
      && other.titleTokenCount > candidate.titleTokenCount
      && other.occurrences.some((otherOccurrence) => (
        otherOccurrence.segmentIndex === occurrence.segmentIndex
        && otherOccurrence.companyStart === occurrence.companyStart
        && otherOccurrence.companyEnd === occurrence.companyEnd
        && otherOccurrence.titleStart <= occurrence.titleStart
        && otherOccurrence.titleEnd >= occurrence.titleEnd
      ))
    )));
    if (hasIndependentOccurrence && !matched.has(candidate.role.role_id)) {
      matched.set(candidate.role.role_id, { role: candidate.role, kind: "company_full_title" });
    }
  }

  if (matched.size) {
    const fullRoleKeys = new Set(rows.flatMap((role) => {
      const keys = [
        `${role.company_key} ${role.title_key}`,
        `${role.title_key} ${role.company_key}`,
      ];
      for (const connector of ["at", "with", "for"]) {
        keys.push(`${role.company_key} ${connector} ${role.title_key}`);
        keys.push(`${role.title_key} ${connector} ${role.company_key}`);
      }
      return keys;
    }));
    const knownSegmentIndexes = new Set();
    for (const { role } of matched.values()) {
      const companyTokens = role.company_key.split(" ");
      const titleTokens = role.title_key.split(" ");
      segments.forEach((segment, index) => {
        if (pairedOccurrences(segment.tokens, companyTokens, titleTokens).length) knownSegmentIndexes.add(index);
      });
    }
    urlEvidence.links.forEach((linked) => {
      segments.forEach((segment, index) => {
        if (segment.raw.includes(linked.raw)) knownSegmentIndexes.add(index);
      });
    });

    let clusterKnown = false;
    let clusterUnknown = false;
    const closeCluster = () => {
      const partial = clusterKnown && clusterUnknown;
      clusterKnown = false;
      clusterUnknown = false;
      return partial;
    };
    for (const [index, segment] of segments.entries()) {
      const entryKey = listEntryKey(segment.raw, urlEvidence.links);
      const known = knownSegmentIndexes.has(index) || (entryKey && fullRoleKeys.has(entryKey));
      const unknown = Boolean(entryKey && !fullRoleKeys.has(entryKey));
      const marker = /^\d+$/u.test(normalizedRolePhrase(segment.raw));
      if (!known && !unknown && !marker) {
        if (closeCluster()) {
          return { status: "unresolved", reason: "partial_explicit_role_list", roles: [] };
        }
        continue;
      }
      clusterKnown ||= Boolean(known);
      clusterUnknown ||= unknown;
    }
    if (closeCluster()) {
        return { status: "unresolved", reason: "partial_explicit_role_list", roles: [] };
    }
  }

  if (!matched.size || matched.size > 20) {
    return { status: "unresolved", reason: matched.size ? "too_many_roles" : "explicit_role_not_found", roles: [] };
  }
  const matches = [...matched.values()].sort((left, right) => left.role.role_id.localeCompare(right.role.role_id));
  return {
    status: "resolved",
    roles: matches.map(({ role }) => ({
      role_id: role.role_id,
      company: role.company,
      title: role.title,
      url: role.url,
    })),
    source_evidence: resolutionEvidence({ candidateText: reply, catalogDigest: catalog.digest, matches }),
  };
}
