import { createHash } from "node:crypto";

import {
  BOOKING_STOP_COLD_EXCLUSION_SCHEMA,
  BOOKING_STOP_SCOPE_SCHEMA,
  BOOKING_STOP_SCOPE_SCHEMA_V3,
} from "./booking-stop-contract.mjs";

const ID = /^[A-Za-z0-9_-]{8,128}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_CAMPAIGNS = 128;
const exactKeys = (value, expected) => (
  value
  && typeof value === "object"
  && !Array.isArray(value)
  && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0")
);

function fail() {
  const error = new Error("BOOKING_STOP_COLD_EXCLUSIONS_INVALID");
  error.code = "BOOKING_STOP_COLD_EXCLUSIONS_INVALID";
  throw error;
}

export function bookingStopCatalogNameSha256(name) {
  return createHash("sha256").update(String(name ?? ""), "utf8").digest("hex");
}

export function parseBookingStopColdExclusions(raw = process.env.BOOKING_STOP_COLD_EXCLUSIONS_JSON) {
  if (raw == null || String(raw).trim() === "") {
    return Object.freeze({
      active: false,
      schema: null,
      mode: null,
      policyDigest: null,
      campaigns: Object.freeze([]),
      scopeSchema: BOOKING_STOP_SCOPE_SCHEMA,
    });
  }
  let value;
  try { value = JSON.parse(String(raw)); } catch { fail(); }
  if (!exactKeys(value, ["schema", "campaigns"])
      || value.schema !== BOOKING_STOP_COLD_EXCLUSION_SCHEMA
      || !Array.isArray(value.campaigns)
      || value.campaigns.length < 1
      || value.campaigns.length > MAX_CAMPAIGNS) fail();
  const campaigns = value.campaigns.map((entry) => {
    if (!exactKeys(entry, ["id", "catalogNameSha256", "definitionSha256"])
        || typeof entry.id !== "string" || !ID.test(entry.id)
        || typeof entry.catalogNameSha256 !== "string"
        || !SHA256.test(entry.catalogNameSha256)
        || typeof entry.definitionSha256 !== "string"
        || !SHA256.test(entry.definitionSha256)) fail();
    return Object.freeze({
      id: entry.id,
      catalogNameSha256: entry.catalogNameSha256,
      definitionSha256: entry.definitionSha256,
    });
  });
  const ids = campaigns.map(({ id }) => id);
  if (new Set(ids).size !== ids.length
      || ids.some((id, index) => index > 0 && ids[index - 1] >= id)) fail();
  const canonical = { schema: BOOKING_STOP_COLD_EXCLUSION_SCHEMA, campaigns };
  const policyDigest = createHash("sha256")
    .update(JSON.stringify(canonical), "utf8")
    .digest("hex");
  return Object.freeze({
    active: true,
    schema: BOOKING_STOP_COLD_EXCLUSION_SCHEMA,
    mode: "exclude_cold_outreach",
    policyDigest,
    campaigns: Object.freeze(campaigns),
    scopeSchema: BOOKING_STOP_SCOPE_SCHEMA_V3,
  });
}

export function coldExclusionDisposition(sequence, policy, keys = []) {
  if (!policy?.active) return "not_configured";
  const id = String(sequence?.id || "");
  const entry = policy.campaigns.find((campaign) => campaign.id === id);
  if (!entry) return "not_listed";
  const name = String(sequence?.name || "");
  if (bookingStopCatalogNameSha256(name) !== entry.catalogNameSha256) return "name_drift_protected";
  if (keys.some((key) => key && name.includes(key))) return "named_family_protected";
  return "excluded_cold";
}

export function bookingStopPolicyHealth(policy, {
  excludedSequences = 0,
  excludedEnabledLinkSequences = 0,
  nameDriftProtectedSequences = 0,
  missingCatalogEntries = 0,
} = {}) {
  if (!policy?.active) return null;
  return Object.freeze({
    schema: policy.schema,
    mode: policy.mode,
    policyDigest: policy.policyDigest,
    excludedSequences,
    excludedEnabledLinkSequences,
    nameDriftProtectedSequences,
    missingCatalogEntries,
  });
}

export function bookingStopPolicyHealthValid(binding, policy = null) {
  const expected = [
    "schema", "mode", "policyDigest", "excludedSequences",
    "excludedEnabledLinkSequences", "nameDriftProtectedSequences",
    "missingCatalogEntries",
  ];
  return Boolean(
    exactKeys(binding, expected)
    && binding.schema === (policy?.schema || BOOKING_STOP_COLD_EXCLUSION_SCHEMA)
    && binding.mode === "exclude_cold_outreach"
    && SHA256.test(String(binding.policyDigest || ""))
    && (!policy?.active || binding.policyDigest === policy.policyDigest)
    && [
      binding.excludedSequences,
      binding.excludedEnabledLinkSequences,
      binding.nameDriftProtectedSequences,
      binding.missingCatalogEntries,
    ].every((value) => Number.isInteger(value) && value >= 0)
    && binding.excludedEnabledLinkSequences <= binding.excludedSequences
  );
}

export function scopeMatchesColdExclusionPolicy(scope, policy) {
  if (!policy?.active) {
    return scope?.schema === BOOKING_STOP_SCOPE_SCHEMA
      && scope?.bookingStopPolicy == null;
  }
  const binding = scope?.bookingStopPolicy;
  return scope?.schema === BOOKING_STOP_SCOPE_SCHEMA_V3
    && bookingStopPolicyHealthValid(binding, policy);
}
