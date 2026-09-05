import { createHash } from "node:crypto";

// ONE canonical digest for a published source profile.
//
// This file is deliberately self-contained and is MIRRORED BYTE-FOR-BYTE in the
// Raydar repo at applicant-core/lib/source-profile-digest.mjs. Both sides
// must produce the identical hex for the identical profile, because Core uses
// the digest to decide whether a card the Monitor already holds still matches
// the payload Core would publish. If the two canonicalizations ever diverge, no
// receipt matches and every cycle republishes every profile forever.
//
// The trap this exists to close: the Monitor does NOT store what Core sends. It
// stores a REWRITTEN object (normalizeSourceProfiles in api/applicants/sync.mjs
// spreads the profile and then overwrites profileSource, a trimmed/lowercased
// historyState and a trimmed sourceObservationId). So the digest is defined over
// that normalized shape, computed the same way on both sides, never over the raw
// object either side happens to be holding.
//
// Canonicalization rules, all three load-bearing:
//   1. object keys are sorted at every depth, so key order cannot matter;
//   2. a key whose value is null or undefined is DROPPED, so "absent" and
//      "explicitly null" hash the same (Core always emits every key; a future
//      Monitor rewrite that omits an empty one must not invalidate the receipt);
//   3. array order is preserved and array elements are never dropped, because
//      position is meaning in experiences/education.
//
// The shared test vector (SOURCE_PROFILE_DIGEST_TEST_VECTOR below) is asserted
// against its exact hex in BOTH repos' test suites. Changing any rule above
// changes that hex and forces a one-time republish of every card; that is a
// deliberate act, not a refactor.
export const SOURCE_PROFILE_DIGEST_VERSION = "applicant-source-profile-digest-v1";

const text = (value) => String(value ?? "").trim();

/**
 * The exact object shape the Monitor persists for a source profile. Kept in
 * lockstep with normalizeSourceProfiles (dashboard api/applicants/sync.mjs).
 */
export function normalizedSourceProfile(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return profile;
  return {
    ...profile,
    profileSource: "applicant_hub",
    historyState: text(
      profile.historyState ?? profile.profileHistoryState ?? profile.history_state,
    ).toLowerCase(),
    sourceObservationId: text(
      profile.sourceObservationId
      ?? profile.source_observation_id
      ?? profile.sourceObservation?.id,
    ),
  };
}

function canonical(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    const child = value[key];
    if (child === null || child === undefined) continue;
    out[key] = canonical(child);
  }
  return out;
}

export function canonicalSourceProfileJson(profile) {
  return JSON.stringify(canonical(normalizedSourceProfile(profile)));
}

export function sourceProfileDigest(profile) {
  return createHash("sha256").update(canonicalSourceProfileJson(profile)).digest("hex");
}

// Shared fixture. Exported so both repos assert the same bytes rather than each
// asserting its own implementation against itself.
export const SOURCE_PROFILE_DIGEST_TEST_VECTOR = Object.freeze({
  name: "Test Applicant",
  title: "Staff Engineer",
  location: "Remote",
  about: null,
  imageSrc: "https://storage.googleapis.com/paraform-images/example.jpg",
  linkedin: null,
  updatedAt: "2026-09-05T00:00:00.000Z",
  densityScore: null,
  possibleFake: null,
  resumeUrl: null,
  experiences: [
    {
      companyId: null,
      roleTitle: "Staff Engineer",
      companyName: "Example",
      start: "2024-01-01",
      end: null,
      current: true,
      description: null,
      location: null,
      industry: null,
      aiTags: [],
      logo: null,
      talentRank: null,
    },
  ],
  education: [],
  historyState: "DATA",
  sourceObservationId: " obs-1 ",
  profileSource: "applicant_hub",
});
