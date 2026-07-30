// Immutable retention for one proven Paraform Human identity universe.
//
// Each finalized identity observation run can retain exactly one digest-only
// exhaustiveness proof. Redis TIME owns retention time and one Lua transition
// performs first-wins creation plus exact readback. There is no index,
// enumeration, mutable head, collector pin, source authority, activation, or
// write-authority surface.

import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import {
  assertParaformHumanIdentityExhaustivenessProofResult,
  validateParaformHumanIdentityExhaustivenessProof,
} from "./source-paraform-human-identity-exhaustiveness.mjs";

export const
  SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_STORE_POLICY_VERSION =
    "phase4-paraform-human-identity-proof-store-v1";

const RECORD_VERSION = 1;
const RECORD_KIND =
  "paraform_human_identity_exhaustiveness_proof_dark";
const KEY_PREFIX =
  "paraai:phase4:paraform-human-identity-proof:v1:";
const DIGEST = /^[a-f0-9]{64}$/u;
const SHA1 = /^[a-f0-9]{40}$/u;
const INPUT_KEYS = Object.freeze([
  "runKeyDigest",
  "proof",
]);
const RECORD_KEYS = Object.freeze([
  "version",
  "policyVersion",
  "kind",
  "runKeyDigest",
  "proof",
  "retainedAtMs",
]);
const DEPENDENCY_KEYS = Object.freeze([
  "configured",
  "kvImpl",
]);

export class SourceParaformHumanIdentityProofStoreError
  extends Error {
  constructor(code) {
    super(code);
    this.name = "SourceParaformHumanIdentityProofStoreError";
    this.code = code;
  }
}

function fail(code) {
  throw new SourceParaformHumanIdentityProofStoreError(code);
}

function sameKeys(actual, expected) {
  const left = [...actual].sort();
  const right = [...expected].sort();
  return left.length === right.length
    && left.every((key, index) => key === right[index]);
}

function plainRecord(value, expectedKeys, code) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || nodeTypes.isProxy(value)
  ) {
    fail(code);
  }
  const prototype = Object.getPrototypeOf(value);
  if (
    prototype !== Object.prototype
    && prototype !== null
  ) {
    fail(code);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    fail(code);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (!sameKeys(Object.keys(descriptors), expectedKeys)) {
    fail(code);
  }
  const result = Object.create(null);
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (
      !descriptor
      || !Object.prototype.hasOwnProperty.call(
        descriptor,
        "value",
      )
      || descriptor.enumerable !== true
    ) {
      fail(code);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail(
        "SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_STORE_RECORD_INVALID",
      );
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
  fail(
    "SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_STORE_RECORD_INVALID",
  );
}

function digest(value, code) {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    fail(code);
  }
  return value;
}

function configuration() {
  const url = String(
    process.env.PARAAI_SOURCE_IDENTITY_KV_REST_API_URL
    || "",
  ).replace(/\/+$/u, "");
  const token =
    process.env.PARAAI_SOURCE_IDENTITY_KV_REST_API_TOKEN
    || "";
  return Object.freeze({
    url,
    token,
    partial: Boolean(url) !== Boolean(token),
  });
}

export function sourceParaformHumanIdentityProofStoreConfigured() {
  const { url, token, partial } = configuration();
  return Boolean(!partial && url && token);
}

async function kv(command) {
  const { url, token, partial } = configuration();
  if (partial) {
    fail(
      "SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_STORE_CONFIGURATION_INVALID",
    );
  }
  if (!url || !token) {
    fail(
      "SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_STORE_UNAVAILABLE",
    );
  }
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    fail(
      "SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_STORE_UNAVAILABLE",
    );
  }
  let body;
  try {
    body = JSON.parse(await response.text());
  } catch {
    body = null;
  }
  if (!response.ok || !body || body.error) {
    fail(
      "SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_STORE_UNAVAILABLE",
    );
  }
  return body.result ?? null;
}

function normalizeIssuedInput(value) {
  const code =
    "SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_STORE_INPUT_INVALID";
  const input = plainRecord(value, INPUT_KEYS, code);
  let proof;
  try {
    assertParaformHumanIdentityExhaustivenessProofResult(
      input.proof,
      input.runKeyDigest,
    );
    proof = validateParaformHumanIdentityExhaustivenessProof(
      input.proof,
    );
  } catch {
    fail(code);
  }
  return Object.freeze({
    version: RECORD_VERSION,
    policyVersion:
      SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_STORE_POLICY_VERSION,
    kind: RECORD_KIND,
    runKeyDigest: digest(input.runKeyDigest, code),
    proof,
  });
}

function normalizeStoredRecord(raw) {
  const code =
    "SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_STORE_RECORD_INVALID";
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(code);
  }
  const record = plainRecord(parsed, RECORD_KEYS, code);
  let proof;
  try {
    proof = validateParaformHumanIdentityExhaustivenessProof(
      record.proof,
    );
  } catch {
    fail(code);
  }
  if (
    record.version !== RECORD_VERSION
    || record.policyVersion
      !== SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_STORE_POLICY_VERSION
    || record.kind !== RECORD_KIND
    || !Number.isSafeInteger(record.retainedAtMs)
    || record.retainedAtMs < Date.parse(proof.boundaryAt)
  ) {
    fail(code);
  }
  return Object.freeze({
    version: RECORD_VERSION,
    policyVersion:
      SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_STORE_POLICY_VERSION,
    kind: RECORD_KIND,
    runKeyDigest: digest(record.runKeyDigest, code),
    proof,
    retainedAtMs: record.retainedAtMs,
  });
}

function parseTransition(result, expected) {
  const code =
    "SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_STORE_READBACK_INVALID";
  if (
    !Array.isArray(result)
    || result.length !== 3
    || ![1, 2].includes(Number(result[0]))
    || typeof result[1] !== "string"
    || typeof result[2] !== "string"
    || !SHA1.test(result[2])
    || createHash("sha1").update(result[1]).digest("hex")
      !== result[2]
  ) {
    fail(code);
  }
  const record = normalizeStoredRecord(result[1]);
  if (
    record.runKeyDigest !== expected.runKeyDigest
    || canonicalJson(record.proof)
      !== canonicalJson(expected.proof)
  ) {
    fail(
      "SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_STORE_CONFLICT",
    );
  }
  return Object.freeze({
    created: Number(result[0]) === 1,
    duplicate: Number(result[0]) === 2,
    runKeyDigest: record.runKeyDigest,
    proofDigest: record.proof.proofDigest,
    retainedAtMs: record.retainedAtMs,
    recordRevisionSha1: result[2],
    proof: record.proof,
    operational: false,
    pinnable: false,
    sourceAuthorityAvailable: false,
    activationAvailable: false,
    writeAuthorityAvailable: false,
  });
}

const RETAIN_LUA = `
  local existing = redis.call('GET', KEYS[1])
  if existing then
    return {2, existing, redis.sha1hex(existing)}
  end
  local redisTime = redis.call('TIME')
  local retainedAtMs =
    (tonumber(redisTime[1]) * 1000)
    + math.floor(tonumber(redisTime[2]) / 1000)
  local proposedOk, proposed = pcall(cjson.decode, ARGV[1])
  if not proposedOk or type(proposed) ~= 'table' then
    return {-9, '', ''}
  end
  proposed.retainedAtMs = retainedAtMs
  local encoded = cjson.encode(proposed)
  local created = redis.call('SET', KEYS[1], encoded, 'NX')
  local stored = redis.call('GET', KEYS[1])
  if created then
    return {1, stored, redis.sha1hex(stored)}
  end
  return {2, stored, redis.sha1hex(stored)}
`;

export function createSourceParaformHumanIdentityProofStore(
  dependencies,
) {
  let selected;
  if (dependencies === undefined) {
    selected = {
      configured:
        sourceParaformHumanIdentityProofStoreConfigured,
      kvImpl: kv,
    };
  } else {
    const code =
      "SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_STORE_DEPENDENCIES_INVALID";
    selected = plainRecord(
      dependencies,
      DEPENDENCY_KEYS,
      code,
    );
    if (
      typeof selected.configured !== "function"
      || typeof selected.kvImpl !== "function"
    ) {
      fail(code);
    }
  }
  const { configured, kvImpl } = selected;
  return Object.freeze({
    configured,
    async retain(input) {
      if (!configured()) {
        fail(
          "SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_STORE_UNAVAILABLE",
        );
      }
      const normalized = normalizeIssuedInput(input);
      let result;
      try {
        result = await kvImpl([
          "EVAL",
          RETAIN_LUA,
          "1",
          `${KEY_PREFIX}${normalized.runKeyDigest}`,
          canonicalJson(normalized),
        ]);
      } catch (error) {
        if (
          error
            instanceof SourceParaformHumanIdentityProofStoreError
        ) {
          throw error;
        }
        fail(
          "SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_STORE_UNAVAILABLE",
        );
      }
      return parseTransition(result, normalized);
    },
    async read({ runKeyDigest } = {}) {
      if (!configured()) {
        fail(
          "SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_STORE_UNAVAILABLE",
        );
      }
      const keyDigest = digest(
        runKeyDigest,
        "SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_STORE_INPUT_INVALID",
      );
      let raw;
      try {
        raw = await kvImpl([
          "GET",
          `${KEY_PREFIX}${keyDigest}`,
        ]);
      } catch {
        fail(
          "SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_STORE_UNAVAILABLE",
        );
      }
      if (raw === null) return null;
      if (typeof raw !== "string") {
        fail(
          "SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_STORE_RECORD_INVALID",
        );
      }
      const record = normalizeStoredRecord(raw);
      if (record.runKeyDigest !== keyDigest) {
        fail(
          "SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_STORE_RECORD_INVALID",
        );
      }
      return Object.freeze({
        ...record,
        proofDigest: record.proof.proofDigest,
        recordRevisionSha1: createHash("sha1")
          .update(raw)
          .digest("hex"),
        operational: false,
        pinnable: false,
        sourceAuthorityAvailable: false,
        activationAvailable: false,
        writeAuthorityAvailable: false,
      });
    },
  });
}

const DEFAULT_STORE =
  createSourceParaformHumanIdentityProofStore();

export const retainParaformHumanIdentityExhaustivenessProof =
  DEFAULT_STORE.retain;
export const readParaformHumanIdentityExhaustivenessProof =
  DEFAULT_STORE.read;
