// Durable Phase 4 source authority.
//
// The pure source-watermark module can normalize evidence but cannot report
// operational readiness or authorize a write. Those decisions live here and
// are made only from records returned by Redis TIME/Lua transitions.
//
// No activation mutation is exported while the alias snapshot collector and
// its independently held signing authority do not exist. A future collector
// integration must add that boundary deliberately; caller-provided generation
// evidence can never install current authority through this module.
// Readiness and both reservation transitions are also hard-locked until that
// integration owns a Redis-TIME freshness lease advanced by a fresh stable
// capture (including upstream head/delta invalidation).

import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import {
  SOURCE_WATERMARK_AUTHORITY_KEY_ENV,
  SOURCE_WATERMARK_AUTHORITY_RECEIPT_VERSION,
  SOURCE_WATERMARK_POLICY_VERSION,
  SourceWatermarkInvariantError,
  sourceWatermarkPublicStatus,
  validateSourceWatermarkGeneration,
} from "./source-watermark.mjs";

const ACTIVE_GENERATION_KEY =
  "paraai:phase4:source-authority:active:v1";
const JOB_SNAPSHOT_PREFIX =
  "paraai:phase4:source-authority:job:v1:";
const RESERVATION_PREFIX =
  "paraai:phase4:source-authority:reservation:v2:";
const SETTLEMENT_PREFIX =
  "paraai:phase4:source-authority:settlement:v1:";
const AUTHORITY_RECORD_VERSION = 1;
const JOB_SNAPSHOT_VERSION = 1;
const RESERVATION_VERSION = 2;
const SETTLEMENT_VERSION = 1;
const GENERATION_RECEIPT_TTL_MS = 60_000;
const RESERVATION_TTL_MS = 15_000;
const RESERVATION_RECORD_TTL_SECONDS = 730 * 24 * 60 * 60;
const CLOCK_SKEW_MS = 5_000;
const SOURCE_CAPTURE_COORDINATOR_AVAILABLE = false;
const DIGEST = /^[a-f0-9]{64}$/u;
const SHA1 = /^[a-f0-9]{40}$/u;
const AUTHORITY_KEY = /^[A-Za-z0-9_-]{43,}$/u;

export class SourceAuthorityStoreError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "SourceAuthorityStoreError";
    this.code = code;
  }
}

function fail(code, message = code) {
  throw new SourceAuthorityStoreError(code, message);
}

function invariant(condition, code, message = code) {
  if (!condition) fail(code, message);
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function digest(value, field) {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw new TypeError(`${field} must be a lowercase sha256 digest`);
  }
  return value;
}

function sha1(value, field) {
  if (typeof value !== "string" || !SHA1.test(value)) {
    throw new TypeError(`${field} must be a lowercase sha1 digest`);
  }
  return value;
}

function nonNegativeSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonical values must be finite");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  throw new TypeError("canonical values must be JSON-safe");
}

function semanticDigest(namespace, value) {
  return createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(canonicalJson(value))
    .digest("hex");
}

function exactKeys(value, expected, code, field) {
  const actual = Object.keys(object(value, field)).sort();
  const required = [...expected].sort();
  invariant(
    canonicalJson(actual) === canonicalJson(required),
    code,
    `${field} has an unexpected shape`,
  );
}

function deepFreeze(value) {
  if (
    value
    && typeof value === "object"
    && !Object.isFrozen(value)
  ) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function parseJson(value, code, field) {
  try {
    return object(JSON.parse(value), field);
  } catch {
    fail(code, `${field} is malformed`);
  }
}

function randomDigest() {
  return randomBytes(32).toString("hex");
}

function authorityKey() {
  const encoded = process.env[
    SOURCE_WATERMARK_AUTHORITY_KEY_ENV
  ];
  let key = null;
  if (typeof encoded === "string" && AUTHORITY_KEY.test(encoded)) {
    try {
      const decoded = Buffer.from(encoded, "base64url");
      if (
        decoded.length >= 32
        && decoded.toString("base64url") === encoded
      ) {
        key = decoded;
      }
    } catch {
      key = null;
    }
  }
  invariant(
    key,
    "SOURCE_AUTHORITY_UNAVAILABLE",
    "source authority key is unavailable or malformed",
  );
  return key;
}

function authorityKeyIdDigest(key) {
  return createHash("sha256")
    .update("phase4-source-authority-key-id-v1")
    .update("\0")
    .update(key)
    .digest("hex");
}

function receiptMac(key, material) {
  return createHmac("sha256", key)
    .update("phase4-source-authority-receipt-v1")
    .update("\0")
    .update(canonicalJson(material))
    .digest("hex");
}

function signReceipt(material) {
  const key = authorityKey();
  return {
    ...material,
    authorityKeyIdDigest: authorityKeyIdDigest(key),
    receiptMac: receiptMac(key, {
      ...material,
      authorityKeyIdDigest: authorityKeyIdDigest(key),
    }),
  };
}

function verifyReceiptMac(raw, material) {
  const key = authorityKey();
  invariant(
    material.authorityKeyIdDigest === authorityKeyIdDigest(key),
    "SOURCE_AUTHORITY_KEY_MISMATCH",
    "authority receipt was issued by another key",
  );
  const supplied = digest(
    raw.receiptMac,
    "authority receipt receiptMac",
  );
  const expected = receiptMac(key, material);
  invariant(
    timingSafeEqual(
      Buffer.from(supplied, "hex"),
      Buffer.from(expected, "hex"),
    ),
    "SOURCE_AUTHORITY_RECEIPT_INVALID",
    "authority receipt MAC is invalid",
  );
  return supplied;
}

function sourceEpochs(generation) {
  return {
    recall:
      generation.sources.recall.certificate.sourceEpochDigest,
    paraformHuman:
      generation.sources.paraformHuman
        .certificate.sourceEpochDigest,
    aliases: generation.aliasMap.aliasEpochDigest,
  };
}

function exactSourceEpochs(value, field) {
  exactKeys(
    value,
    ["recall", "paraformHuman", "aliases"],
    "SOURCE_AUTHORITY_EPOCH_SHAPE_INVALID",
    field,
  );
  return {
    recall: digest(value.recall, `${field}.recall`),
    paraformHuman: digest(
      value.paraformHuman,
      `${field}.paraformHuman`,
    ),
    aliases: digest(value.aliases, `${field}.aliases`),
  };
}

function sameEpochs(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function evidenceCeilingAtMs(generation) {
  const timestamps = [
    generation.decisionBoundaryAt,
    generation.committedAt,
    ...generation.sources.recall.certificate.passes.flatMap(
      (pass) => [pass.startedAt, pass.completedAt],
    ),
    ...generation.sources.paraformHuman.certificate.passes.flatMap(
      (pass) => [pass.startedAt, pass.completedAt],
    ),
    ...generation.aliasMap.passes.flatMap(
      (pass) => [pass.startedAt, pass.completedAt],
    ),
    ...generation.aliasMap.entries.flatMap(
      (entry) => entry.bindings.map(
        (binding) => binding.observedAt,
      ),
    ),
  ].filter(Boolean);
  return Math.max(...timestamps.map((value) => Date.parse(value)));
}

function committedReadyGeneration(value) {
  let generation;
  try {
    generation = validateSourceWatermarkGeneration(value);
  } catch (error) {
    if (error instanceof SourceWatermarkInvariantError) throw error;
    fail(
      "SOURCE_AUTHORITY_GENERATION_INVALID",
      "source generation is malformed",
    );
  }
  invariant(
    generation.status === "committed"
      && generation.intrinsicSourceComplete === true
      && generation.intrinsicQ37Ready === true,
    "SOURCE_AUTHORITY_GENERATION_NOT_READY",
    "a committed intrinsically ready generation is required",
  );
  return generation;
}

function activeBindingMaterial({
  generation,
  durableGenerationRevisionDigest,
}) {
  return {
    version: AUTHORITY_RECORD_VERSION,
    policyVersion: SOURCE_WATERMARK_POLICY_VERSION,
    generationRecordDigest: generation.recordDigest,
    generationArtifactDigest: semanticDigest(
      "phase4-source-generation-artifact-v1",
      generation,
    ),
    manifestDigest: generation.manifestDigest,
    commitRevisionDigest: generation.commitRevisionDigest,
    durableGenerationRevisionDigest,
    sourceEpochs: sourceEpochs(generation),
    evidenceCeilingAtMs: evidenceCeilingAtMs(generation),
  };
}

function canonicalActiveRecord(value) {
  const raw = object(value, "active source authority record");
  exactKeys(
    raw,
    [
      "version",
      "policyVersion",
      "status",
      "generationRecordDigest",
      "generationArtifactDigest",
      "manifestDigest",
      "commitRevisionDigest",
      "durableGenerationRevisionDigest",
      "durableRecordReceiptDigest",
      "sourceEpochs",
      "evidenceCeilingAtMs",
      "activatedAtMs",
      "generation",
    ],
    "SOURCE_AUTHORITY_DURABLE_STATE_MALFORMED",
    "active source authority record",
  );
  invariant(
    raw.version === AUTHORITY_RECORD_VERSION
      && raw.policyVersion === SOURCE_WATERMARK_POLICY_VERSION
      && raw.status === "active",
    "SOURCE_AUTHORITY_DURABLE_STATE_MALFORMED",
    "active source authority record version is invalid",
  );
  const generation = committedReadyGeneration(raw.generation);
  const durableGenerationRevisionDigest = digest(
    raw.durableGenerationRevisionDigest,
    "active durableGenerationRevisionDigest",
  );
  const expected = activeBindingMaterial({
    generation,
    durableGenerationRevisionDigest,
  });
  const actual = {
    version: raw.version,
    policyVersion: raw.policyVersion,
    generationRecordDigest: digest(
      raw.generationRecordDigest,
      "active generationRecordDigest",
    ),
    generationArtifactDigest: digest(
      raw.generationArtifactDigest,
      "active generationArtifactDigest",
    ),
    manifestDigest: digest(
      raw.manifestDigest,
      "active manifestDigest",
    ),
    commitRevisionDigest: digest(
      raw.commitRevisionDigest,
      "active commitRevisionDigest",
    ),
    durableGenerationRevisionDigest,
    sourceEpochs: exactSourceEpochs(
      raw.sourceEpochs,
      "active sourceEpochs",
    ),
    evidenceCeilingAtMs: nonNegativeSafeInteger(
      raw.evidenceCeilingAtMs,
      "active evidenceCeilingAtMs",
    ),
  };
  invariant(
    canonicalJson(actual) === canonicalJson(expected),
    "SOURCE_AUTHORITY_DURABLE_STATE_MALFORMED",
    "active source authority record does not match its generation",
  );
  const durableRecordReceiptDigest = digest(
    raw.durableRecordReceiptDigest,
    "active durableRecordReceiptDigest",
  );
  invariant(
    durableRecordReceiptDigest === semanticDigest(
      "phase4-source-durable-active-record-v1",
      expected,
    ),
    "SOURCE_AUTHORITY_DURABLE_STATE_MALFORMED",
    "active source authority receipt binding is invalid",
  );
  const activatedAtMs = nonNegativeSafeInteger(
    raw.activatedAtMs,
    "active activatedAtMs",
  );
  invariant(
    activatedAtMs >= expected.evidenceCeilingAtMs,
    "SOURCE_AUTHORITY_DURABLE_STATE_MALFORMED",
    "active source authority record predates its evidence",
  );
  return deepFreeze({
    ...actual,
    status: "active",
    durableRecordReceiptDigest,
    activatedAtMs,
    generation,
  });
}

function redisTime(result, offset, field) {
  const seconds = Number(result?.[offset]);
  const micros = Number(result?.[offset + 1]);
  invariant(
    Number.isSafeInteger(seconds)
      && seconds >= 0
      && Number.isSafeInteger(micros)
      && micros >= 0
      && micros < 1_000_000,
    "SOURCE_AUTHORITY_REDIS_TIME_INVALID",
    `${field} did not return Redis TIME`,
  );
  const observedMs =
    seconds * 1_000 + Math.floor(micros / 1_000);
  invariant(
    Math.abs(observedMs - Date.now()) <= CLOCK_SKEW_MS,
    "SOURCE_AUTHORITY_REDIS_TIME_SKEWED",
    `${field} returned a stale or future Redis clock`,
  );
  return observedMs;
}

function generationReceipt(active, activeRecordSha1, nowMs) {
  const material = {
    version: SOURCE_WATERMARK_AUTHORITY_RECEIPT_VERSION,
    policyVersion: SOURCE_WATERMARK_POLICY_VERSION,
    kind: "source_generation_current",
    generationRecordDigest: active.generationRecordDigest,
    generationArtifactDigest: active.generationArtifactDigest,
    manifestDigest: active.manifestDigest,
    commitRevisionDigest: active.commitRevisionDigest,
    durableGenerationRevisionDigest:
      active.durableGenerationRevisionDigest,
    durableRecordReceiptDigest:
      active.durableRecordReceiptDigest,
    activeRecordSha1: sha1(
      activeRecordSha1,
      "active record sha1",
    ),
    sourceEpochs: active.sourceEpochs,
    decisionBoundaryAt: active.generation.decisionBoundaryAt,
    issuedAtMs: nowMs,
    expiresAtMs: nowMs + GENERATION_RECEIPT_TTL_MS,
    receiptNonceDigest: randomDigest(),
  };
  const receipt = signReceipt(material);
  return deepFreeze({
    ...receipt,
    receiptDigest: semanticDigest(
      "phase4-source-store-generation-receipt-v1",
      receipt,
    ),
  });
}

function canonicalGenerationReceipt(value, {
  allowExpired = false,
} = {}) {
  const raw = object(value, "generation authority receipt");
  exactKeys(
    raw,
    [
      "version",
      "policyVersion",
      "kind",
      "generationRecordDigest",
      "generationArtifactDigest",
      "manifestDigest",
      "commitRevisionDigest",
      "durableGenerationRevisionDigest",
      "durableRecordReceiptDigest",
      "activeRecordSha1",
      "sourceEpochs",
      "decisionBoundaryAt",
      "issuedAtMs",
      "expiresAtMs",
      "receiptNonceDigest",
      "authorityKeyIdDigest",
      "receiptMac",
      "receiptDigest",
    ],
    "SOURCE_AUTHORITY_RECEIPT_SHAPE_INVALID",
    "generation authority receipt",
  );
  invariant(
    raw.version === SOURCE_WATERMARK_AUTHORITY_RECEIPT_VERSION
      && raw.policyVersion === SOURCE_WATERMARK_POLICY_VERSION
      && raw.kind === "source_generation_current",
    "SOURCE_AUTHORITY_RECEIPT_VERSION_INVALID",
    "generation authority receipt version is invalid",
  );
  const material = {
    version: raw.version,
    policyVersion: raw.policyVersion,
    kind: raw.kind,
    generationRecordDigest: digest(
      raw.generationRecordDigest,
      "generation receipt generationRecordDigest",
    ),
    generationArtifactDigest: digest(
      raw.generationArtifactDigest,
      "generation receipt generationArtifactDigest",
    ),
    manifestDigest: digest(
      raw.manifestDigest,
      "generation receipt manifestDigest",
    ),
    commitRevisionDigest: digest(
      raw.commitRevisionDigest,
      "generation receipt commitRevisionDigest",
    ),
    durableGenerationRevisionDigest: digest(
      raw.durableGenerationRevisionDigest,
      "generation receipt durableGenerationRevisionDigest",
    ),
    durableRecordReceiptDigest: digest(
      raw.durableRecordReceiptDigest,
      "generation receipt durableRecordReceiptDigest",
    ),
    activeRecordSha1: sha1(
      raw.activeRecordSha1,
      "generation receipt activeRecordSha1",
    ),
    sourceEpochs: exactSourceEpochs(
      raw.sourceEpochs,
      "generation receipt sourceEpochs",
    ),
    decisionBoundaryAt: String(raw.decisionBoundaryAt),
    issuedAtMs: nonNegativeSafeInteger(
      raw.issuedAtMs,
      "generation receipt issuedAtMs",
    ),
    expiresAtMs: nonNegativeSafeInteger(
      raw.expiresAtMs,
      "generation receipt expiresAtMs",
    ),
    receiptNonceDigest: digest(
      raw.receiptNonceDigest,
      "generation receipt receiptNonceDigest",
    ),
    authorityKeyIdDigest: digest(
      raw.authorityKeyIdDigest,
      "generation receipt authorityKeyIdDigest",
    ),
  };
  invariant(
    material.expiresAtMs >= material.issuedAtMs
      && material.expiresAtMs - material.issuedAtMs
        === GENERATION_RECEIPT_TTL_MS,
    "SOURCE_AUTHORITY_RECEIPT_LIFETIME_INVALID",
    "generation authority receipt lifetime is invalid",
  );
  const nowMs = Date.now();
  invariant(
    material.issuedAtMs <= nowMs + CLOCK_SKEW_MS,
    "SOURCE_AUTHORITY_RECEIPT_FROM_FUTURE",
    "generation authority receipt is from the future",
  );
  if (!allowExpired) {
    invariant(
      material.expiresAtMs >= nowMs,
      "SOURCE_AUTHORITY_RECEIPT_STALE",
      "generation authority receipt is stale",
    );
  }
  const receiptMacValue = verifyReceiptMac(raw, material);
  const receipt = { ...material, receiptMac: receiptMacValue };
  invariant(
    digest(raw.receiptDigest, "generation receipt receiptDigest")
      === semanticDigest(
        "phase4-source-store-generation-receipt-v1",
        receipt,
      ),
    "SOURCE_AUTHORITY_RECEIPT_INVALID",
    "generation authority receipt digest is invalid",
  );
  return deepFreeze({
    ...receipt,
    receiptDigest: raw.receiptDigest,
  });
}

function generationReceiptMatchesActive(receipt, active) {
  return (
    receipt.generationRecordDigest
      === active.generationRecordDigest
    && receipt.generationArtifactDigest
      === active.generationArtifactDigest
    && receipt.manifestDigest === active.manifestDigest
    && receipt.commitRevisionDigest
      === active.commitRevisionDigest
    && receipt.durableGenerationRevisionDigest
      === active.durableGenerationRevisionDigest
    && receipt.durableRecordReceiptDigest
      === active.durableRecordReceiptDigest
    && sameEpochs(receipt.sourceEpochs, active.sourceEpochs)
    && receipt.decisionBoundaryAt
      === active.generation.decisionBoundaryAt
  );
}

function kvConfiguration() {
  return {
    url: String(
      process.env.PARAAI_SOURCE_AUTHORITY_KV_REST_API_URL
      || process.env.KV_REST_API_URL
      || "",
    ).replace(/\/+$/u, ""),
    token:
      process.env.PARAAI_SOURCE_AUTHORITY_KV_REST_API_TOKEN
      || process.env.KV_REST_API_TOKEN
      || "",
  };
}

export function sourceAuthorityStoreConfigured() {
  const { url, token } = kvConfiguration();
  if (!url || !token) return false;
  try {
    authorityKey();
    return true;
  } catch {
    return false;
  }
}

async function kv(command) {
  const { url, token } = kvConfiguration();
  invariant(
    url && token,
    "SOURCE_AUTHORITY_STORE_UNAVAILABLE",
    "source authority KV is unavailable",
  );
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(8_000),
  });
  let body = null;
  try {
    body = JSON.parse(await response.text());
  } catch {
    body = null;
  }
  invariant(
    response.ok && !body?.error,
    "SOURCE_AUTHORITY_STORE_REQUEST_FAILED",
    "source authority KV request failed",
  );
  return body?.result ?? null;
}

const REDIS_TIME_MS_LUA = `
  local redisTime = redis.call('TIME')
  local nowMs = tonumber(redisTime[1]) * 1000
    + math.floor(tonumber(redisTime[2]) / 1000)
`;

const READ_GENERATION_LUA = `
  local redisTime = redis.call('TIME')
  return {
    redis.call('GET', KEYS[1]) or '',
    redisTime[1],
    redisTime[2]
  }
`;

export async function readCurrentSourceAuthority() {
  authorityKey();
  const result = await kv([
    "EVAL",
    READ_GENERATION_LUA,
    1,
    ACTIVE_GENERATION_KEY,
  ]);
  invariant(
    Array.isArray(result),
    "SOURCE_AUTHORITY_DURABLE_STATE_MALFORMED",
    "source authority read returned an invalid result",
  );
  const nowMs = redisTime(result, 1, "generation read");
  if (!result[0]) {
    return deepFreeze({
      active: null,
      generationAuthorityReceipt: null,
    });
  }
  const active = canonicalActiveRecord(
    parseJson(
      result[0],
      "SOURCE_AUTHORITY_DURABLE_STATE_MALFORMED",
      "current source authority record",
    ),
  );
  invariant(
    active.activatedAtMs <= nowMs + CLOCK_SKEW_MS
      && active.evidenceCeilingAtMs <= nowMs + CLOCK_SKEW_MS,
    "SOURCE_AUTHORITY_DURABLE_STATE_MALFORMED",
    "current source authority record is from the future",
  );
  const activeRecordSha1 = createHash("sha1")
    .update(result[0])
    .digest("hex");
  return deepFreeze({
    active,
    activeRecordSha1,
    generationAuthorityReceipt: generationReceipt(
      active,
      activeRecordSha1,
      nowMs,
    ),
  });
}

function storeDarkStatus(status = "store_unavailable") {
  return deepFreeze({
    ...sourceWatermarkPublicStatus(),
    status,
    authorityStoreConfigured: sourceAuthorityStoreConfigured(),
  });
}

export async function getSourceAuthorityOperationalStatus() {
  if (!sourceAuthorityStoreConfigured()) {
    return storeDarkStatus();
  }
  if (!SOURCE_CAPTURE_COORDINATOR_AVAILABLE) {
    return storeDarkStatus("capture_coordinator_unavailable");
  }
  let current;
  try {
    current = await readCurrentSourceAuthority();
  } catch {
    return storeDarkStatus("invalid");
  }
  if (!current.active) return storeDarkStatus("not_committed");
  const base = sourceWatermarkPublicStatus({
    generation: current.active.generation,
  });
  return deepFreeze({
    ...base,
    status: "ready",
    authorityStoreConfigured: true,
    committed: true,
    current: true,
    sourceWatermarkComplete: true,
    phase4Q37Ready: true,
  });
}

function jobSnapshotKey(jobBindingDigest) {
  return `${JOB_SNAPSHOT_PREFIX}${jobBindingDigest}`;
}

function reservationKey({
  jobBindingDigest,
  jobRevisionDigest,
  writeScopeDigest,
}) {
  return `${RESERVATION_PREFIX}${semanticDigest(
    "phase4-source-write-reservation-key-v1",
    {
      jobBindingDigest,
      jobRevisionDigest,
      writeScopeDigest,
    },
  )}`;
}

function settlementKey(binding) {
  return `${SETTLEMENT_PREFIX}${semanticDigest(
    "phase4-source-write-settlement-key-v1",
    {
      jobBindingDigest: binding.jobBindingDigest,
      jobRevisionDigest: binding.jobRevisionDigest,
      writeScopeDigest: binding.writeScopeDigest,
    },
  )}`;
}

function canonicalJobSnapshot(value, expected) {
  const raw = object(value, "source authority job snapshot");
  exactKeys(
    raw,
    [
      "version",
      "policyVersion",
      "status",
      "jobBindingDigest",
      "canonicalCandidateDigest",
      "candidateUserAliasDigest",
      "jobRevisionDigest",
      "writeScopeDigest",
    ],
    "SOURCE_AUTHORITY_JOB_STATE_MALFORMED",
    "source authority job snapshot",
  );
  const normalized = {
    version: raw.version,
    policyVersion: raw.policyVersion,
    status: raw.status,
    jobBindingDigest: digest(
      raw.jobBindingDigest,
      "job snapshot jobBindingDigest",
    ),
    canonicalCandidateDigest: digest(
      raw.canonicalCandidateDigest,
      "job snapshot canonicalCandidateDigest",
    ),
    candidateUserAliasDigest: digest(
      raw.candidateUserAliasDigest,
      "job snapshot candidateUserAliasDigest",
    ),
    jobRevisionDigest: digest(
      raw.jobRevisionDigest,
      "job snapshot jobRevisionDigest",
    ),
    writeScopeDigest: digest(
      raw.writeScopeDigest,
      "job snapshot writeScopeDigest",
    ),
  };
  invariant(
    normalized.version === JOB_SNAPSHOT_VERSION
      && normalized.policyVersion
        === SOURCE_WATERMARK_POLICY_VERSION
      && normalized.status === "ready"
      && canonicalJson(normalized) === canonicalJson(expected),
    "SOURCE_AUTHORITY_JOB_STATE_MISMATCH",
    "durable job snapshot does not match the exact write",
  );
  return deepFreeze(normalized);
}

function selectedDecision(generation, {
  canonicalCandidateDigest,
  candidateUserAliasDigest,
}) {
  invariant(
    generation.aliasMap.entries.some((entry) => (
      entry.identityBindingProven === true
      && entry.canonicalCandidateDigest
        === canonicalCandidateDigest
      && entry.candidateUserAliasDigest
        === candidateUserAliasDigest
    )),
    "SOURCE_AUTHORITY_ALIAS_MISMATCH",
    "write identity is not in the authenticated alias map",
  );
  const decision = generation.q37.decisions.find(
    (candidate) => (
      candidate.canonicalCandidateDigest
        === canonicalCandidateDigest
    ),
  );
  invariant(
    decision?.decision === "selected"
      && ["agent", "human"].includes(decision.callType),
    "SOURCE_AUTHORITY_Q37_NOT_SELECTED",
    "write requires an unambiguous successful-call decision",
  );
  return decision;
}

const RESERVE_WRITE_LUA = `
  ${REDIS_TIME_MS_LUA}
  local function exactTableSize(value, expected)
    local count = 0
    for _ in pairs(value) do count = count + 1 end
    return count == expected
  end
  local activeRaw = redis.call('GET', KEYS[1])
  local jobRaw = redis.call('GET', KEYS[2])
  local settlementRaw = redis.call('GET', KEYS[4])
  if not activeRaw or not jobRaw then
    return {-4, activeRaw or '', jobRaw or '', '', redisTime[1], redisTime[2]}
  end
  local activeOk, active = pcall(cjson.decode, activeRaw)
  local jobOk, job = pcall(cjson.decode, jobRaw)
  if not activeOk or not jobOk
    or type(active) ~= 'table' or type(job) ~= 'table'
    or type(active.sourceEpochs) ~= 'table' then
    return {-8, activeRaw, jobRaw, '', redisTime[1], redisTime[2]}
  end
  if active.generationRecordDigest ~= ARGV[1]
    or active.durableGenerationRevisionDigest ~= ARGV[2]
    or active.durableRecordReceiptDigest ~= ARGV[3]
    or active.sourceEpochs.recall ~= ARGV[4]
    or active.sourceEpochs.paraformHuman ~= ARGV[5]
    or active.sourceEpochs.aliases ~= ARGV[6]
    or redis.sha1hex(activeRaw) ~= ARGV[21] then
    return {-3, activeRaw, jobRaw, '', redisTime[1], redisTime[2]}
  end
  if job.version ~= 1
    or job.policyVersion ~= ARGV[7]
    or job.status ~= 'ready'
    or job.jobBindingDigest ~= ARGV[8]
    or job.canonicalCandidateDigest ~= ARGV[9]
    or job.candidateUserAliasDigest ~= ARGV[10]
    or job.jobRevisionDigest ~= ARGV[11]
    or job.writeScopeDigest ~= ARGV[12]
    or not exactTableSize(job, 8) then
    return {-5, activeRaw, jobRaw, '', redisTime[1], redisTime[2]}
  end
  local jobSnapshotSha1 = redis.sha1hex(jobRaw)
  local existingRaw = redis.call('GET', KEYS[3])
  if existingRaw then
    local existingOk, existing = pcall(cjson.decode, existingRaw)
    if not existingOk or type(existing) ~= 'table'
      or type(existing.sourceEpochs) ~= 'table'
      or not exactTableSize(existing, 21)
      or not exactTableSize(existing.sourceEpochs, 3) then
      return {-8, activeRaw, jobRaw, existingRaw, redisTime[1], redisTime[2]}
    end
    if existing.version ~= 2
      or existing.policyVersion ~= ARGV[7]
      or existing.status ~= 'reserved'
      or existing.generationRecordDigest ~= ARGV[1]
      or existing.durableGenerationRevisionDigest ~= ARGV[2]
      or existing.durableRecordReceiptDigest ~= ARGV[3]
      or existing.activeRecordSha1 ~= ARGV[21]
      or existing.sourceEpochs.recall ~= ARGV[4]
      or existing.sourceEpochs.paraformHuman ~= ARGV[5]
      or existing.sourceEpochs.aliases ~= ARGV[6]
      or existing.jobBindingDigest ~= ARGV[8]
      or existing.canonicalCandidateDigest ~= ARGV[9]
      or existing.candidateUserAliasDigest ~= ARGV[10]
      or existing.jobRevisionDigest ~= ARGV[11]
      or existing.writeScopeDigest ~= ARGV[12]
      or existing.jobSnapshotSha1 ~= jobSnapshotSha1
      or existing.q37DecisionDigest ~= ARGV[15]
      or existing.callType ~= ARGV[16]
      or existing.callEndedAt ~= ARGV[17]
      or type(existing.reservedJobRevisionDigest) ~= 'string'
      or string.len(existing.reservedJobRevisionDigest) ~= 64
      or not string.match(existing.reservedJobRevisionDigest, '^[0-9a-f]+$')
      or type(existing.reservationNonceDigest) ~= 'string'
      or string.len(existing.reservationNonceDigest) ~= 64
      or not string.match(existing.reservationNonceDigest, '^[0-9a-f]+$')
      or type(existing.issuedAtMs) ~= 'number'
      or type(existing.expiresAtMs) ~= 'number'
      or existing.expiresAtMs < existing.issuedAtMs
      or existing.expiresAtMs - existing.issuedAtMs > tonumber(ARGV[13]) then
      return {-6, activeRaw, jobRaw, existingRaw, redisTime[1], redisTime[2]}
    end
    if existing.expiresAtMs >= nowMs or settlementRaw then
      return {2, activeRaw, jobRaw, existingRaw, redisTime[1], redisTime[2]}
    end
    redis.call('DEL', KEYS[3])
  elseif settlementRaw then
    return {-8, activeRaw, jobRaw, '', redisTime[1], redisTime[2]}
  end
  local expiresAtMs = nowMs + tonumber(ARGV[13])
  local receiptExpiresAtMs = tonumber(ARGV[14])
  if receiptExpiresAtMs < expiresAtMs then expiresAtMs = receiptExpiresAtMs end
  if expiresAtMs <= nowMs then
    return {-7, activeRaw, jobRaw, '', redisTime[1], redisTime[2]}
  end
  local reservation = {
    version = 2,
    policyVersion = ARGV[7],
    status = 'reserved',
    generationRecordDigest = ARGV[1],
    durableGenerationRevisionDigest = ARGV[2],
    durableRecordReceiptDigest = ARGV[3],
    activeRecordSha1 = ARGV[21],
    sourceEpochs = {
      recall = ARGV[4],
      paraformHuman = ARGV[5],
      aliases = ARGV[6]
    },
    jobBindingDigest = ARGV[8],
    canonicalCandidateDigest = ARGV[9],
    candidateUserAliasDigest = ARGV[10],
    jobRevisionDigest = ARGV[11],
    writeScopeDigest = ARGV[12],
    jobSnapshotSha1 = jobSnapshotSha1,
    q37DecisionDigest = ARGV[15],
    callType = ARGV[16],
    callEndedAt = ARGV[17],
    reservedJobRevisionDigest = ARGV[18],
    reservationNonceDigest = ARGV[19],
    issuedAtMs = nowMs,
    expiresAtMs = expiresAtMs
  }
  local encoded = cjson.encode(reservation)
  redis.call('SET', KEYS[3], encoded, 'EX', ARGV[20])
  return {1, activeRaw, jobRaw, encoded, redisTime[1], redisTime[2]}
`;

function canonicalReservationRecord(value, {
  active = null,
  job = null,
  jobSnapshotSha1 = null,
  receipt = null,
}) {
  const raw = object(value, "source write reservation");
  exactKeys(
    raw,
    [
      "version",
      "policyVersion",
      "status",
      "generationRecordDigest",
      "durableGenerationRevisionDigest",
      "durableRecordReceiptDigest",
      "activeRecordSha1",
      "sourceEpochs",
      "jobBindingDigest",
      "canonicalCandidateDigest",
      "candidateUserAliasDigest",
      "jobRevisionDigest",
      "writeScopeDigest",
      "jobSnapshotSha1",
      "q37DecisionDigest",
      "callType",
      "callEndedAt",
      "reservedJobRevisionDigest",
      "reservationNonceDigest",
      "issuedAtMs",
      "expiresAtMs",
    ],
    "SOURCE_AUTHORITY_RESERVATION_MALFORMED",
    "source write reservation",
  );
  const sourceEpochValues = exactSourceEpochs(
    raw.sourceEpochs,
    "reservation sourceEpochs",
  );
  const normalized = {
    version: raw.version,
    policyVersion: raw.policyVersion,
    status: raw.status,
    generationRecordDigest: digest(
      raw.generationRecordDigest,
      "reservation generationRecordDigest",
    ),
    durableGenerationRevisionDigest: digest(
      raw.durableGenerationRevisionDigest,
      "reservation durableGenerationRevisionDigest",
    ),
    durableRecordReceiptDigest: digest(
      raw.durableRecordReceiptDigest,
      "reservation durableRecordReceiptDigest",
    ),
    activeRecordSha1: sha1(
      raw.activeRecordSha1,
      "reservation activeRecordSha1",
    ),
    sourceEpochs: sourceEpochValues,
    jobBindingDigest: digest(
      raw.jobBindingDigest,
      "reservation jobBindingDigest",
    ),
    canonicalCandidateDigest: digest(
      raw.canonicalCandidateDigest,
      "reservation canonicalCandidateDigest",
    ),
    candidateUserAliasDigest: digest(
      raw.candidateUserAliasDigest,
      "reservation candidateUserAliasDigest",
    ),
    jobRevisionDigest: digest(
      raw.jobRevisionDigest,
      "reservation jobRevisionDigest",
    ),
    writeScopeDigest: digest(
      raw.writeScopeDigest,
      "reservation writeScopeDigest",
    ),
    jobSnapshotSha1: sha1(
      raw.jobSnapshotSha1,
      "reservation jobSnapshotSha1",
    ),
    q37DecisionDigest: digest(
      raw.q37DecisionDigest,
      "reservation q37DecisionDigest",
    ),
    callType: raw.callType,
    callEndedAt: String(raw.callEndedAt),
    reservedJobRevisionDigest: digest(
      raw.reservedJobRevisionDigest,
      "reservation reservedJobRevisionDigest",
    ),
    reservationNonceDigest: digest(
      raw.reservationNonceDigest,
      "reservation reservationNonceDigest",
    ),
    issuedAtMs: nonNegativeSafeInteger(
      raw.issuedAtMs,
      "reservation issuedAtMs",
    ),
    expiresAtMs: nonNegativeSafeInteger(
      raw.expiresAtMs,
      "reservation expiresAtMs",
    ),
  };
  if (receipt) {
    invariant(
      reservationRecordMatchesReceipt(normalized, receipt),
      "SOURCE_AUTHORITY_RESERVATION_MALFORMED",
      "source write reservation does not match its receipt",
    );
    return deepFreeze(normalized);
  }
  invariant(
    active && job && jobSnapshotSha1
      &&
    normalized.version === RESERVATION_VERSION
      && normalized.policyVersion
        === SOURCE_WATERMARK_POLICY_VERSION
      && normalized.status === "reserved"
      && normalized.generationRecordDigest
        === active.generationRecordDigest
      && normalized.durableGenerationRevisionDigest
        === active.durableGenerationRevisionDigest
      && normalized.durableRecordReceiptDigest
        === active.durableRecordReceiptDigest
      && normalized.activeRecordSha1
        === active.activeRecordSha1
      && sameEpochs(normalized.sourceEpochs, active.sourceEpochs)
      && normalized.jobBindingDigest === job.jobBindingDigest
      && normalized.canonicalCandidateDigest
        === job.canonicalCandidateDigest
      && normalized.candidateUserAliasDigest
        === job.candidateUserAliasDigest
      && normalized.jobRevisionDigest === job.jobRevisionDigest
      && normalized.writeScopeDigest === job.writeScopeDigest
      && normalized.jobSnapshotSha1 === jobSnapshotSha1
      && normalized.expiresAtMs >= normalized.issuedAtMs
      && normalized.expiresAtMs - normalized.issuedAtMs
        <= RESERVATION_TTL_MS,
    "SOURCE_AUTHORITY_RESERVATION_MALFORMED",
    "source write reservation is inconsistent",
  );
  const decision = selectedDecision(active.generation, normalized);
  invariant(
    normalized.q37DecisionDigest === decision.decisionDigest
      && normalized.callType === decision.callType
      && normalized.callEndedAt === decision.endedAt,
    "SOURCE_AUTHORITY_RESERVATION_MALFORMED",
    "source write reservation has invalid Q37 evidence",
  );
  return deepFreeze(normalized);
}

function reservationReceipt(reservation) {
  const material = {
    version: SOURCE_WATERMARK_AUTHORITY_RECEIPT_VERSION,
    policyVersion: SOURCE_WATERMARK_POLICY_VERSION,
    kind: "phase4_write_reserved",
    generationRecordDigest:
      reservation.generationRecordDigest,
    durableGenerationRevisionDigest:
      reservation.durableGenerationRevisionDigest,
    durableRecordReceiptDigest:
      reservation.durableRecordReceiptDigest,
    activeRecordSha1: reservation.activeRecordSha1,
    sourceEpochs: reservation.sourceEpochs,
    jobBindingDigest: reservation.jobBindingDigest,
    canonicalCandidateDigest:
      reservation.canonicalCandidateDigest,
    candidateUserAliasDigest:
      reservation.candidateUserAliasDigest,
    jobRevisionDigest: reservation.jobRevisionDigest,
    writeScopeDigest: reservation.writeScopeDigest,
    jobSnapshotSha1: reservation.jobSnapshotSha1,
    q37DecisionDigest: reservation.q37DecisionDigest,
    callType: reservation.callType,
    callEndedAt: reservation.callEndedAt,
    reservedJobRevisionDigest:
      reservation.reservedJobRevisionDigest,
    reservationNonceDigest:
      reservation.reservationNonceDigest,
    reservationRecordSha1:
      reservation.reservationRecordSha1,
    issuedAtMs: reservation.issuedAtMs,
    expiresAtMs: reservation.expiresAtMs,
  };
  const receipt = signReceipt(material);
  return deepFreeze({
    ...receipt,
    receiptDigest: semanticDigest(
      "phase4-source-store-reservation-receipt-v1",
      receipt,
    ),
  });
}

function canonicalReservationReceipt(value, {
  allowExpired = false,
} = {}) {
  const raw = object(value, "source write reservation receipt");
  exactKeys(
    raw,
    [
      "version",
      "policyVersion",
      "kind",
      "generationRecordDigest",
      "durableGenerationRevisionDigest",
      "durableRecordReceiptDigest",
      "activeRecordSha1",
      "sourceEpochs",
      "jobBindingDigest",
      "canonicalCandidateDigest",
      "candidateUserAliasDigest",
      "jobRevisionDigest",
      "writeScopeDigest",
      "jobSnapshotSha1",
      "q37DecisionDigest",
      "callType",
      "callEndedAt",
      "reservedJobRevisionDigest",
      "reservationNonceDigest",
      "reservationRecordSha1",
      "issuedAtMs",
      "expiresAtMs",
      "authorityKeyIdDigest",
      "receiptMac",
      "receiptDigest",
    ],
    "SOURCE_AUTHORITY_RESERVATION_RECEIPT_SHAPE_INVALID",
    "source write reservation receipt",
  );
  invariant(
    raw.version === SOURCE_WATERMARK_AUTHORITY_RECEIPT_VERSION
      && raw.policyVersion === SOURCE_WATERMARK_POLICY_VERSION
      && raw.kind === "phase4_write_reserved",
    "SOURCE_AUTHORITY_RESERVATION_RECEIPT_VERSION_INVALID",
    "source write reservation receipt version is invalid",
  );
  const material = {
    version: raw.version,
    policyVersion: raw.policyVersion,
    kind: raw.kind,
    generationRecordDigest: digest(
      raw.generationRecordDigest,
      "reservation receipt generationRecordDigest",
    ),
    durableGenerationRevisionDigest: digest(
      raw.durableGenerationRevisionDigest,
      "reservation receipt durableGenerationRevisionDigest",
    ),
    durableRecordReceiptDigest: digest(
      raw.durableRecordReceiptDigest,
      "reservation receipt durableRecordReceiptDigest",
    ),
    activeRecordSha1: sha1(
      raw.activeRecordSha1,
      "reservation receipt activeRecordSha1",
    ),
    sourceEpochs: exactSourceEpochs(
      raw.sourceEpochs,
      "reservation receipt sourceEpochs",
    ),
    jobBindingDigest: digest(
      raw.jobBindingDigest,
      "reservation receipt jobBindingDigest",
    ),
    canonicalCandidateDigest: digest(
      raw.canonicalCandidateDigest,
      "reservation receipt canonicalCandidateDigest",
    ),
    candidateUserAliasDigest: digest(
      raw.candidateUserAliasDigest,
      "reservation receipt candidateUserAliasDigest",
    ),
    jobRevisionDigest: digest(
      raw.jobRevisionDigest,
      "reservation receipt jobRevisionDigest",
    ),
    writeScopeDigest: digest(
      raw.writeScopeDigest,
      "reservation receipt writeScopeDigest",
    ),
    jobSnapshotSha1: sha1(
      raw.jobSnapshotSha1,
      "reservation receipt jobSnapshotSha1",
    ),
    q37DecisionDigest: digest(
      raw.q37DecisionDigest,
      "reservation receipt q37DecisionDigest",
    ),
    callType: raw.callType,
    callEndedAt: String(raw.callEndedAt),
    reservedJobRevisionDigest: digest(
      raw.reservedJobRevisionDigest,
      "reservation receipt reservedJobRevisionDigest",
    ),
    reservationNonceDigest: digest(
      raw.reservationNonceDigest,
      "reservation receipt reservationNonceDigest",
    ),
    reservationRecordSha1: sha1(
      raw.reservationRecordSha1,
      "reservation receipt reservationRecordSha1",
    ),
    issuedAtMs: nonNegativeSafeInteger(
      raw.issuedAtMs,
      "reservation receipt issuedAtMs",
    ),
    expiresAtMs: nonNegativeSafeInteger(
      raw.expiresAtMs,
      "reservation receipt expiresAtMs",
    ),
    authorityKeyIdDigest: digest(
      raw.authorityKeyIdDigest,
      "reservation receipt authorityKeyIdDigest",
    ),
  };
  invariant(
    material.expiresAtMs >= material.issuedAtMs
      && material.expiresAtMs - material.issuedAtMs
        <= RESERVATION_TTL_MS
      && material.issuedAtMs <= Date.now() + CLOCK_SKEW_MS,
    "SOURCE_AUTHORITY_RESERVATION_RECEIPT_TIME_INVALID",
    "source write reservation receipt time is invalid",
  );
  if (!allowExpired) {
    invariant(
      material.expiresAtMs >= Date.now(),
      "SOURCE_AUTHORITY_RESERVATION_EXPIRED",
      "source write reservation is expired",
    );
  }
  const receiptMacValue = verifyReceiptMac(raw, material);
  const receipt = { ...material, receiptMac: receiptMacValue };
  invariant(
    digest(raw.receiptDigest, "reservation receipt receiptDigest")
      === semanticDigest(
        "phase4-source-store-reservation-receipt-v1",
        receipt,
      ),
    "SOURCE_AUTHORITY_RESERVATION_RECEIPT_INVALID",
    "source write reservation receipt digest is invalid",
  );
  return deepFreeze({
    ...receipt,
    receiptDigest: raw.receiptDigest,
  });
}

export async function reserveSourceAuthorityWrite(
  {
    jobBindingDigest: rawJobBindingDigest,
    canonicalCandidateDigest:
      rawCanonicalCandidateDigest,
    candidateUserAliasDigest:
      rawCandidateUserAliasDigest,
    jobRevisionDigest: rawJobRevisionDigest,
    writeScopeDigest: rawWriteScopeDigest,
  } = {},
) {
  invariant(
    SOURCE_CAPTURE_COORDINATOR_AVAILABLE,
    "SOURCE_AUTHORITY_CAPTURE_COORDINATOR_UNAVAILABLE",
    "no reviewed capture-freshness coordinator is installed",
  );
  const expectedJob = {
    version: JOB_SNAPSHOT_VERSION,
    policyVersion: SOURCE_WATERMARK_POLICY_VERSION,
    status: "ready",
    jobBindingDigest: digest(
      rawJobBindingDigest,
      "jobBindingDigest",
    ),
    canonicalCandidateDigest: digest(
      rawCanonicalCandidateDigest,
      "canonicalCandidateDigest",
    ),
    candidateUserAliasDigest: digest(
      rawCandidateUserAliasDigest,
      "candidateUserAliasDigest",
    ),
    jobRevisionDigest: digest(
      rawJobRevisionDigest,
      "jobRevisionDigest",
    ),
    writeScopeDigest: digest(
      rawWriteScopeDigest,
      "writeScopeDigest",
    ),
  };
  // This read is internal. Its exact fields become the compare values in the
  // following Lua transition; callers cannot select an old generation.
  const current = await readCurrentSourceAuthority();
  invariant(
    current.active && current.generationAuthorityReceipt,
    "SOURCE_AUTHORITY_NO_ACTIVE_GENERATION",
    "no current source generation is active",
  );
  const active = current.active;
  const generationAuthority =
    canonicalGenerationReceipt(
      current.generationAuthorityReceipt,
    );
  invariant(
    generationReceiptMatchesActive(generationAuthority, active)
      && generationAuthority.activeRecordSha1
        === current.activeRecordSha1,
    "SOURCE_AUTHORITY_ACTIVE_REVISION_CONFLICT",
    "current generation receipt does not match the durable record",
  );
  const decision = selectedDecision(
    active.generation,
    expectedJob,
  );
  const result = await kv([
    "EVAL",
    RESERVE_WRITE_LUA,
    4,
    ACTIVE_GENERATION_KEY,
    jobSnapshotKey(expectedJob.jobBindingDigest),
    reservationKey(expectedJob),
    settlementKey(expectedJob),
    active.generationRecordDigest,
    active.durableGenerationRevisionDigest,
    active.durableRecordReceiptDigest,
    active.sourceEpochs.recall,
    active.sourceEpochs.paraformHuman,
    active.sourceEpochs.aliases,
    SOURCE_WATERMARK_POLICY_VERSION,
    expectedJob.jobBindingDigest,
    expectedJob.canonicalCandidateDigest,
    expectedJob.candidateUserAliasDigest,
    expectedJob.jobRevisionDigest,
    expectedJob.writeScopeDigest,
    String(RESERVATION_TTL_MS),
    String(generationAuthority.expiresAtMs),
    decision.decisionDigest,
    decision.callType,
    decision.endedAt,
    randomDigest(),
    randomDigest(),
    String(RESERVATION_RECORD_TTL_SECONDS),
    current.activeRecordSha1,
  ]);
  const code = Number(result?.[0]);
  if (code === -3) {
    fail(
      "SOURCE_AUTHORITY_ACTIVE_REVISION_CONFLICT",
      "active source generation changed during reservation",
    );
  }
  if (code === -4) {
    fail(
      "SOURCE_AUTHORITY_STATE_MISSING",
      "active generation or job snapshot is missing",
    );
  }
  if (code === -5) {
    fail(
      "SOURCE_AUTHORITY_JOB_STATE_MISMATCH",
      "durable job snapshot does not match the exact write",
    );
  }
  if (code === -6) {
    fail(
      "SOURCE_AUTHORITY_RESERVATION_CONFLICT",
      "a different reservation already exists",
    );
  }
  if (code === -7) {
    fail(
      "SOURCE_AUTHORITY_RECEIPT_STALE",
      "generation authority expired before reservation",
    );
  }
  invariant(
    code === 1 || code === 2,
    "SOURCE_AUTHORITY_DURABLE_STATE_MALFORMED",
    "source write reservation was rejected",
  );
  const nowMs = redisTime(result, 4, "write reservation");
  const returnedActive = canonicalActiveRecord(
    parseJson(
      result[1],
      "SOURCE_AUTHORITY_DURABLE_STATE_MALFORMED",
      "reservation active record",
    ),
  );
  const returnedActiveRecordSha1 = createHash("sha1")
    .update(result[1])
    .digest("hex");
  invariant(
    returnedActive.durableRecordReceiptDigest
        === active.durableRecordReceiptDigest
      && returnedActiveRecordSha1 === current.activeRecordSha1,
    "SOURCE_AUTHORITY_ACTIVE_REVISION_CONFLICT",
    "active source generation changed during reservation",
  );
  const job = canonicalJobSnapshot(
    parseJson(
      result[2],
      "SOURCE_AUTHORITY_JOB_STATE_MALFORMED",
      "reservation job snapshot",
    ),
    expectedJob,
  );
  const returnedJobSnapshotSha1 = createHash("sha1")
    .update(result[2])
    .digest("hex");
  const reservation = canonicalReservationRecord(
    parseJson(
      result[3],
      "SOURCE_AUTHORITY_RESERVATION_MALFORMED",
      "write reservation",
    ),
    {
      active: {
        ...returnedActive,
        activeRecordSha1: returnedActiveRecordSha1,
      },
      job,
      jobSnapshotSha1: returnedJobSnapshotSha1,
    },
  );
  const reservationRecordSha1 = createHash("sha1")
    .update(result[3])
    .digest("hex");
  invariant(
    reservation.issuedAtMs <= nowMs
      && (
        code === 2
        || reservation.issuedAtMs === nowMs
      ),
    "SOURCE_AUTHORITY_RESERVATION_MALFORMED",
    "write reservation has an invalid Redis timestamp",
  );
  return deepFreeze({
    allowed: false,
    status: reservation.status,
    duplicate: code === 2,
    reservedJobRevisionDigest:
      reservation.reservedJobRevisionDigest,
    reservationReceipt: reservationReceipt({
      ...reservation,
      reservationRecordSha1,
    }),
  });
}

const CONSUME_WRITE_LUA = `
  ${REDIS_TIME_MS_LUA}
  local function exactTableSize(value, expected)
    local count = 0
    for _ in pairs(value) do count = count + 1 end
    return count == expected
  end
  local activeRaw = redis.call('GET', KEYS[1])
  local jobRaw = redis.call('GET', KEYS[2])
  local reservationRaw = redis.call('GET', KEYS[3])
  local settlementRaw = redis.call('GET', KEYS[4])
  if not reservationRaw then
    return {
      -4,
      activeRaw or '',
      jobRaw or '',
      reservationRaw or '',
      settlementRaw or '',
      redisTime[1],
      redisTime[2]
    }
  end
  local reservationOk, reservation = pcall(cjson.decode, reservationRaw)
  if not reservationOk
    or type(reservation) ~= 'table'
    or type(reservation.sourceEpochs) ~= 'table'
    or not exactTableSize(reservation, 21)
    or not exactTableSize(reservation.sourceEpochs, 3) then
    return {
      -8,
      activeRaw,
      jobRaw,
      reservationRaw,
      settlementRaw or '',
      redisTime[1],
      redisTime[2]
    }
  end
  if reservation.version ~= 2
    or reservation.policyVersion ~= ARGV[7]
    or reservation.status ~= 'reserved'
    or reservation.generationRecordDigest ~= ARGV[1]
    or reservation.durableGenerationRevisionDigest ~= ARGV[2]
    or reservation.durableRecordReceiptDigest ~= ARGV[3]
    or reservation.activeRecordSha1 ~= ARGV[25]
    or reservation.sourceEpochs.recall ~= ARGV[4]
    or reservation.sourceEpochs.paraformHuman ~= ARGV[5]
    or reservation.sourceEpochs.aliases ~= ARGV[6]
    or reservation.jobBindingDigest ~= ARGV[8]
    or reservation.canonicalCandidateDigest ~= ARGV[9]
    or reservation.candidateUserAliasDigest ~= ARGV[10]
    or reservation.jobRevisionDigest ~= ARGV[11]
    or reservation.writeScopeDigest ~= ARGV[12]
    or reservation.jobSnapshotSha1 ~= ARGV[13]
    or reservation.q37DecisionDigest ~= ARGV[14]
    or reservation.callType ~= ARGV[15]
    or reservation.callEndedAt ~= ARGV[16]
    or reservation.reservedJobRevisionDigest ~= ARGV[17]
    or reservation.reservationNonceDigest ~= ARGV[18]
    or tonumber(reservation.issuedAtMs) ~= tonumber(ARGV[19])
    or tonumber(reservation.expiresAtMs) ~= tonumber(ARGV[20])
    or redis.sha1hex(reservationRaw) ~= ARGV[21] then
    return {
      -6,
      activeRaw,
      jobRaw,
      reservationRaw,
      settlementRaw or '',
      redisTime[1],
      redisTime[2]
    }
  end
  if settlementRaw then
    local settlementOk, settlement = pcall(cjson.decode, settlementRaw)
    if not settlementOk or type(settlement) ~= 'table'
      or not exactTableSize(settlement, 14) then
      return {
        -8,
        activeRaw,
        jobRaw,
        reservationRaw,
        settlementRaw,
        redisTime[1],
        redisTime[2]
      }
    end
    if settlement.version ~= 1
      or settlement.policyVersion ~= ARGV[7]
      or settlement.status ~= 'consumed'
      or settlement.reservationReceiptDigest ~= ARGV[22]
      or settlement.reservationRecordSha1 ~= ARGV[21]
      or settlement.activeRecordSha1 ~= ARGV[25]
      or settlement.jobSnapshotSha1 ~= ARGV[13]
      or settlement.jobBindingDigest ~= ARGV[8]
      or settlement.jobRevisionDigest ~= ARGV[11]
      or settlement.writeScopeDigest ~= ARGV[12]
      or settlement.reservedJobRevisionDigest ~= ARGV[17]
      or settlement.reservationNonceDigest ~= ARGV[18] then
      return {
        -6,
        activeRaw,
        jobRaw,
        reservationRaw,
        settlementRaw,
        redisTime[1],
        redisTime[2]
      }
    end
    if settlement.settledResultDigest ~= ARGV[23] then
      return {
        -9,
        activeRaw,
        jobRaw,
        reservationRaw,
        settlementRaw,
        redisTime[1],
        redisTime[2]
      }
    end
    return {
      2,
      activeRaw,
      jobRaw,
      reservationRaw,
      settlementRaw,
      redisTime[1],
      redisTime[2]
    }
  end
  if not activeRaw or not jobRaw then
    return {
      -4,
      activeRaw or '',
      jobRaw or '',
      reservationRaw,
      '',
      redisTime[1],
      redisTime[2]
    }
  end
  local activeOk, active = pcall(cjson.decode, activeRaw)
  local jobOk, job = pcall(cjson.decode, jobRaw)
  if not activeOk or not jobOk
    or type(active) ~= 'table'
    or type(job) ~= 'table'
    or type(active.sourceEpochs) ~= 'table' then
    return {
      -8,
      activeRaw,
      jobRaw,
      reservationRaw,
      '',
      redisTime[1],
      redisTime[2]
    }
  end
  if active.generationRecordDigest ~= ARGV[1]
    or active.durableGenerationRevisionDigest ~= ARGV[2]
    or active.durableRecordReceiptDigest ~= ARGV[3]
    or active.sourceEpochs.recall ~= ARGV[4]
    or active.sourceEpochs.paraformHuman ~= ARGV[5]
    or active.sourceEpochs.aliases ~= ARGV[6]
    or redis.sha1hex(activeRaw) ~= ARGV[25] then
    return {
      -3,
      activeRaw,
      jobRaw,
      reservationRaw,
      '',
      redisTime[1],
      redisTime[2]
    }
  end
  if job.version ~= 1
    or job.policyVersion ~= ARGV[7]
    or job.status ~= 'ready'
    or job.jobBindingDigest ~= ARGV[8]
    or job.canonicalCandidateDigest ~= ARGV[9]
    or job.candidateUserAliasDigest ~= ARGV[10]
    or job.jobRevisionDigest ~= ARGV[11]
    or job.writeScopeDigest ~= ARGV[12]
    or redis.sha1hex(jobRaw) ~= ARGV[13]
    or not exactTableSize(job, 8) then
    return {
      -5,
      activeRaw,
      jobRaw,
      reservationRaw,
      '',
      redisTime[1],
      redisTime[2]
    }
  end
  if tonumber(reservation.expiresAtMs) < nowMs then
    return {
      -7,
      activeRaw,
      jobRaw,
      reservationRaw,
      '',
      redisTime[1],
      redisTime[2]
    }
  end
  local settlement = {
    version = 1,
    policyVersion = ARGV[7],
    status = 'consumed',
    reservationReceiptDigest = ARGV[22],
    reservationRecordSha1 = ARGV[21],
    activeRecordSha1 = ARGV[25],
    jobSnapshotSha1 = ARGV[13],
    jobBindingDigest = ARGV[8],
    jobRevisionDigest = ARGV[11],
    writeScopeDigest = ARGV[12],
    reservedJobRevisionDigest = ARGV[17],
    reservationNonceDigest = ARGV[18],
    settledResultDigest = ARGV[23],
    consumedAtMs = nowMs
  }
  local consumed = cjson.encode(settlement)
  redis.call('SET', KEYS[4], consumed, 'EX', ARGV[24])
  return {
    1,
    activeRaw,
    jobRaw,
    reservationRaw,
    consumed,
    redisTime[1],
    redisTime[2]
  }
`;

function reservationRecordMatchesReceipt(reservation, receipt) {
  return (
    reservation.generationRecordDigest
      === receipt.generationRecordDigest
    && reservation.durableGenerationRevisionDigest
      === receipt.durableGenerationRevisionDigest
    && reservation.durableRecordReceiptDigest
      === receipt.durableRecordReceiptDigest
    && reservation.activeRecordSha1
      === receipt.activeRecordSha1
    && sameEpochs(
      reservation.sourceEpochs,
      receipt.sourceEpochs,
    )
    && reservation.jobBindingDigest
      === receipt.jobBindingDigest
    && reservation.canonicalCandidateDigest
      === receipt.canonicalCandidateDigest
    && reservation.candidateUserAliasDigest
      === receipt.candidateUserAliasDigest
    && reservation.jobRevisionDigest
      === receipt.jobRevisionDigest
    && reservation.writeScopeDigest
      === receipt.writeScopeDigest
    && reservation.jobSnapshotSha1
      === receipt.jobSnapshotSha1
    && reservation.q37DecisionDigest
      === receipt.q37DecisionDigest
    && reservation.callType === receipt.callType
    && reservation.callEndedAt === receipt.callEndedAt
    && reservation.reservedJobRevisionDigest
      === receipt.reservedJobRevisionDigest
    && reservation.reservationNonceDigest
      === receipt.reservationNonceDigest
    && reservation.issuedAtMs === receipt.issuedAtMs
    && reservation.expiresAtMs === receipt.expiresAtMs
  );
}

function canonicalSettlementRecord(value, {
  receipt,
  settledResultDigest,
}) {
  const raw = object(value, "source write settlement");
  exactKeys(
    raw,
    [
      "version",
      "policyVersion",
      "status",
      "reservationReceiptDigest",
      "reservationRecordSha1",
      "activeRecordSha1",
      "jobSnapshotSha1",
      "jobBindingDigest",
      "jobRevisionDigest",
      "writeScopeDigest",
      "reservedJobRevisionDigest",
      "reservationNonceDigest",
      "settledResultDigest",
      "consumedAtMs",
    ],
    "SOURCE_AUTHORITY_SETTLEMENT_MALFORMED",
    "source write settlement",
  );
  const normalized = {
    version: raw.version,
    policyVersion: raw.policyVersion,
    status: raw.status,
    reservationReceiptDigest: digest(
      raw.reservationReceiptDigest,
      "settlement reservationReceiptDigest",
    ),
    reservationRecordSha1: sha1(
      raw.reservationRecordSha1,
      "settlement reservationRecordSha1",
    ),
    activeRecordSha1: sha1(
      raw.activeRecordSha1,
      "settlement activeRecordSha1",
    ),
    jobSnapshotSha1: sha1(
      raw.jobSnapshotSha1,
      "settlement jobSnapshotSha1",
    ),
    jobBindingDigest: digest(
      raw.jobBindingDigest,
      "settlement jobBindingDigest",
    ),
    jobRevisionDigest: digest(
      raw.jobRevisionDigest,
      "settlement jobRevisionDigest",
    ),
    writeScopeDigest: digest(
      raw.writeScopeDigest,
      "settlement writeScopeDigest",
    ),
    reservedJobRevisionDigest: digest(
      raw.reservedJobRevisionDigest,
      "settlement reservedJobRevisionDigest",
    ),
    reservationNonceDigest: digest(
      raw.reservationNonceDigest,
      "settlement reservationNonceDigest",
    ),
    settledResultDigest: digest(
      raw.settledResultDigest,
      "settlement settledResultDigest",
    ),
    consumedAtMs: nonNegativeSafeInteger(
      raw.consumedAtMs,
      "settlement consumedAtMs",
    ),
  };
  invariant(
    normalized.version === SETTLEMENT_VERSION
      && normalized.policyVersion
        === SOURCE_WATERMARK_POLICY_VERSION
      && normalized.status === "consumed"
      && normalized.reservationReceiptDigest
        === receipt.receiptDigest
      && normalized.reservationRecordSha1
        === receipt.reservationRecordSha1
      && normalized.activeRecordSha1
        === receipt.activeRecordSha1
      && normalized.jobSnapshotSha1
        === receipt.jobSnapshotSha1
      && normalized.jobBindingDigest
        === receipt.jobBindingDigest
      && normalized.jobRevisionDigest
        === receipt.jobRevisionDigest
      && normalized.writeScopeDigest
        === receipt.writeScopeDigest
      && normalized.reservedJobRevisionDigest
        === receipt.reservedJobRevisionDigest
      && normalized.reservationNonceDigest
        === receipt.reservationNonceDigest
      && normalized.settledResultDigest
        === settledResultDigest
      && normalized.consumedAtMs >= receipt.issuedAtMs,
    "SOURCE_AUTHORITY_SETTLEMENT_MALFORMED",
    "source write settlement is inconsistent",
  );
  return deepFreeze(normalized);
}

export async function consumeSourceAuthorityWriteReservation(
  {
    reservationReceipt: rawReservationReceipt,
    expectedJobBindingDigest,
    expectedJobRevisionDigest,
    expectedWriteScopeDigest,
    settledResultDigest: rawSettledResultDigest,
  } = {},
) {
  invariant(
    SOURCE_CAPTURE_COORDINATOR_AVAILABLE,
    "SOURCE_AUTHORITY_CAPTURE_COORDINATOR_UNAVAILABLE",
    "no reviewed capture-freshness coordinator is installed",
  );
  const receipt = canonicalReservationReceipt(
    rawReservationReceipt,
    { allowExpired: true },
  );
  const expected = {
    version: JOB_SNAPSHOT_VERSION,
    policyVersion: SOURCE_WATERMARK_POLICY_VERSION,
    status: "ready",
    jobBindingDigest: digest(
      expectedJobBindingDigest,
      "expectedJobBindingDigest",
    ),
    canonicalCandidateDigest:
      receipt.canonicalCandidateDigest,
    candidateUserAliasDigest:
      receipt.candidateUserAliasDigest,
    jobRevisionDigest: digest(
      expectedJobRevisionDigest,
      "expectedJobRevisionDigest",
    ),
    writeScopeDigest: digest(
      expectedWriteScopeDigest,
      "expectedWriteScopeDigest",
    ),
  };
  invariant(
    expected.jobBindingDigest === receipt.jobBindingDigest
      && expected.jobRevisionDigest === receipt.jobRevisionDigest
      && expected.writeScopeDigest === receipt.writeScopeDigest,
    "SOURCE_AUTHORITY_RESERVATION_EXPECTATION_MISMATCH",
    "reservation receipt cannot be replayed across job or scope",
  );
  const settledResultDigest = digest(
    rawSettledResultDigest,
    "settledResultDigest",
  );
  const result = await kv([
    "EVAL",
    CONSUME_WRITE_LUA,
    4,
    ACTIVE_GENERATION_KEY,
    jobSnapshotKey(receipt.jobBindingDigest),
    reservationKey(receipt),
    settlementKey(receipt),
    receipt.generationRecordDigest,
    receipt.durableGenerationRevisionDigest,
    receipt.durableRecordReceiptDigest,
    receipt.sourceEpochs.recall,
    receipt.sourceEpochs.paraformHuman,
    receipt.sourceEpochs.aliases,
    SOURCE_WATERMARK_POLICY_VERSION,
    receipt.jobBindingDigest,
    receipt.canonicalCandidateDigest,
    receipt.candidateUserAliasDigest,
    receipt.jobRevisionDigest,
    receipt.writeScopeDigest,
    receipt.jobSnapshotSha1,
    receipt.q37DecisionDigest,
    receipt.callType,
    receipt.callEndedAt,
    receipt.reservedJobRevisionDigest,
    receipt.reservationNonceDigest,
    String(receipt.issuedAtMs),
    String(receipt.expiresAtMs),
    receipt.reservationRecordSha1,
    receipt.receiptDigest,
    settledResultDigest,
    String(RESERVATION_RECORD_TTL_SECONDS),
    receipt.activeRecordSha1,
  ]);
  const code = Number(result?.[0]);
  if (code === -3) {
    fail(
      "SOURCE_AUTHORITY_ACTIVE_REVISION_CONFLICT",
      "reservation belongs to a replaced source generation",
    );
  }
  if (code === -4) {
    fail(
      "SOURCE_AUTHORITY_STATE_MISSING",
      "reservation durable state is missing",
    );
  }
  if (code === -5) {
    fail(
      "SOURCE_AUTHORITY_JOB_STATE_MISMATCH",
      "durable job snapshot changed before consumption",
    );
  }
  if (code === -6) {
    fail(
      "SOURCE_AUTHORITY_RESERVATION_EXPECTATION_MISMATCH",
      "reservation cannot be replayed across job or scope",
    );
  }
  if (code === -7) {
    fail(
      "SOURCE_AUTHORITY_RESERVATION_EXPIRED",
      "source write reservation expired before consumption",
    );
  }
  if (code === -9) {
    fail(
      "SOURCE_AUTHORITY_SETTLED_RESULT_CONFLICT",
      "consumed reservation has a different settled result",
    );
  }
  invariant(
    code === 1 || code === 2,
    "SOURCE_AUTHORITY_DURABLE_STATE_MALFORMED",
    "source write reservation consumption was rejected",
  );
  const consumedAtRedisMs = redisTime(
    result,
    5,
    "write reservation consumption",
  );
  const reservationRaw = result[3];
  const reservationRecordSha1 = createHash("sha1")
    .update(reservationRaw)
    .digest("hex");
  invariant(
    reservationRecordSha1
      === receipt.reservationRecordSha1,
    "SOURCE_AUTHORITY_RESERVATION_MALFORMED",
    "consumption reservation raw state changed",
  );
  if (code === 2) {
    canonicalReservationRecord(
      parseJson(
        reservationRaw,
        "SOURCE_AUTHORITY_RESERVATION_MALFORMED",
        "duplicate consumption reservation",
      ),
      { receipt },
    );
    const priorSettlement = canonicalSettlementRecord(
      parseJson(
        result[4],
        "SOURCE_AUTHORITY_SETTLEMENT_MALFORMED",
        "duplicate consumption settlement",
      ),
      { receipt, settledResultDigest },
    );
    invariant(
      priorSettlement.consumedAtMs <= consumedAtRedisMs,
      "SOURCE_AUTHORITY_SETTLEMENT_MALFORMED",
      "duplicate settlement is from the future",
    );
    return deepFreeze({
      allowed: false,
      duplicate: true,
      status: "consumed",
      settledResultDigest:
        priorSettlement.settledResultDigest,
      consumedAtMs: priorSettlement.consumedAtMs,
    });
  }
  const active = canonicalActiveRecord(
    parseJson(
      result[1],
      "SOURCE_AUTHORITY_DURABLE_STATE_MALFORMED",
      "consumption active record",
    ),
  );
  const activeRecordSha1 = createHash("sha1")
    .update(result[1])
    .digest("hex");
  invariant(
    activeRecordSha1 === receipt.activeRecordSha1
      && active.generationRecordDigest
        === receipt.generationRecordDigest
      && active.durableGenerationRevisionDigest
        === receipt.durableGenerationRevisionDigest
      && active.durableRecordReceiptDigest
        === receipt.durableRecordReceiptDigest
      && sameEpochs(active.sourceEpochs, receipt.sourceEpochs),
    "SOURCE_AUTHORITY_ACTIVE_REVISION_CONFLICT",
    "consumption active source generation changed",
  );
  const job = canonicalJobSnapshot(
    parseJson(
      result[2],
      "SOURCE_AUTHORITY_JOB_STATE_MALFORMED",
      "consumption job snapshot",
    ),
    expected,
  );
  const jobSnapshotSha1 = createHash("sha1")
    .update(result[2])
    .digest("hex");
  invariant(
    jobSnapshotSha1 === receipt.jobSnapshotSha1,
    "SOURCE_AUTHORITY_JOB_STATE_MISMATCH",
    "consumption job snapshot changed",
  );
  const reservation = canonicalReservationRecord(
    parseJson(
      reservationRaw,
      "SOURCE_AUTHORITY_RESERVATION_MALFORMED",
      "consumption write reservation",
    ),
    {
      active: {
        ...active,
        activeRecordSha1,
      },
      job,
      jobSnapshotSha1,
    },
  );
  invariant(
    reservationRecordSha1
        === receipt.reservationRecordSha1
      && reservationRecordMatchesReceipt(
        reservation,
        receipt,
      ),
    "SOURCE_AUTHORITY_RESERVATION_MALFORMED",
    "consumption reservation does not match its receipt",
  );
  const settlement = canonicalSettlementRecord(
    parseJson(
      result[4],
      "SOURCE_AUTHORITY_SETTLEMENT_MALFORMED",
      "consumption settlement",
    ),
    { receipt, settledResultDigest },
  );
  invariant(
    settlement.consumedAtMs <= consumedAtRedisMs
      && settlement.consumedAtMs === consumedAtRedisMs,
    "SOURCE_AUTHORITY_SETTLEMENT_MALFORMED",
    "consumption settlement has an invalid Redis timestamp",
  );
  return deepFreeze({
    allowed: true,
    duplicate: false,
    status: "consumed",
    settledResultDigest: settlement.settledResultDigest,
    consumedAtMs: settlement.consumedAtMs,
  });
}
