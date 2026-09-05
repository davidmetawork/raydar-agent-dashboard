#!/usr/bin/env node

/**
 * Rebuild the current Applicants generation's derived facts from durable
 * Applicant Hub source profiles.
 *
 * Dry-run is the default and performs no writes:
 *   node --env-file=/absolute/path/.env.local scripts/rebuild-applicant-facts.mjs
 *
 * Apply is explicit:
 *   node --env-file=/absolute/path/.env.local scripts/rebuild-applicant-facts.mjs --apply
 *
 * The environment must be loaded before this module dynamically imports the
 * KV client, because that client captures its URL and token at module load.
 * This tool never reads Paraform and never writes profiles, receipts, cards,
 * directories, publication artifacts, or the active-generation pointer.
 */
import { createHash } from "node:crypto";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PROFILE_KEY_RE = /^(?:[a-z0-9]{10,40}|core:[a-z0-9]{10,64})$/i;
const DIGEST_RE = /^[a-f0-9]{64}$/i;
const HISTORY_STATES = new Set(["data", "verified_empty"]);
const READ_BATCH = 25;

export const FACTS_CAS_LUA = `
local currentProfile=redis.call('GET',KEYS[1])
local currentReceipt=redis.call('HGET',KEYS[2],ARGV[1])
if currentProfile~=ARGV[2] or currentReceipt~=ARGV[3] then return 0 end
if redis.call('GET',KEYS[4])~=ARGV[5] then return -1 end
redis.call('HSET',KEYS[3],ARGV[1],ARGV[4])
return 1`;

const digest = (value) => createHash("sha256").update(String(value)).digest("hex");
const parseJson = (raw) => {
  try { return typeof raw === "string" ? JSON.parse(raw) : null; }
  catch { return null; }
};
const text = (value) => {
  const out = String(value ?? "").trim();
  return out || null;
};

export function parseArgs(argv) {
  const args = new Set(argv);
  const unknown = [...args].filter((arg) => !["--apply", "--dry-run", "--help"].includes(arg));
  if (unknown.length) throw new Error("unsupported_argument");
  if (args.has("--apply") && args.has("--dry-run")) throw new Error("mode_conflict");
  return { apply: args.has("--apply"), help: args.has("--help") };
}

export function activeSourceTargets(artifacts, { sourceObservationIdFor }) {
  const rows = [
    ...(Array.isArray(artifacts?.snapshot?.stream) ? artifacts.snapshot.stream : []),
    ...(Array.isArray(artifacts?.queue?.rows) ? artifacts.queue.rows : []),
  ];
  const observations = new Map();
  let invalidRows = 0;
  for (const row of rows) {
    const key = text(row?.profileKey || row?.cuId);
    const observationId = sourceObservationIdFor(row);
    if (!key || !PROFILE_KEY_RE.test(key) || !observationId) {
      invalidRows += 1;
      continue;
    }
    if (!observations.has(key)) observations.set(key, new Set());
    observations.get(key).add(observationId);
  }
  const targets = [];
  let conflictingObservationTargets = 0;
  for (const [key, ids] of observations) {
    if (ids.size !== 1) {
      conflictingObservationTargets += 1;
      continue;
    }
    targets.push({ key, observationId: [...ids][0] });
  }
  targets.sort((a, b) => a.key.localeCompare(b.key));
  return { rows: rows.length, invalidRows, conflictingObservationTargets, targets };
}

export function stageSourceFact({
  target,
  rawProfile,
  rawReceipt,
  factsFromProfile,
  sourceProfileDigest,
  sourceObservationIdFor,
}) {
  if (typeof rawProfile !== "string") return { ok: false, reason: "profile_missing" };
  if (typeof rawReceipt !== "string") return { ok: false, reason: "receipt_missing" };
  const profile = parseJson(rawProfile);
  const receipt = parseJson(rawReceipt);
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    return { ok: false, reason: "profile_invalid" };
  }
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return { ok: false, reason: "receipt_invalid" };
  }
  const profileState = text(profile.historyState)?.toLowerCase();
  const receiptState = text(receipt.historyState)?.toLowerCase();
  const profileObservation = sourceObservationIdFor(profile);
  const receiptObservation = sourceObservationIdFor(receipt);
  if (profile.profileSource !== "applicant_hub"
    || receipt.source !== "applicant_hub"
    || receipt.durable !== true) {
    return { ok: false, reason: "source_not_durable" };
  }
  if (!HISTORY_STATES.has(profileState) || profileState !== receiptState) {
    return { ok: false, reason: "history_state_mismatch" };
  }
  if (profileObservation !== target.observationId || receiptObservation !== target.observationId) {
    return { ok: false, reason: "observation_mismatch" };
  }
  const receiptDigest = text(receipt.payloadDigest)?.toLowerCase();
  if (!receiptDigest || !DIGEST_RE.test(receiptDigest)) {
    return { ok: false, reason: "receipt_digest_missing" };
  }
  if (sourceProfileDigest(profile) !== receiptDigest) {
    return { ok: false, reason: "profile_digest_mismatch" };
  }
  if (profileState === "verified_empty"
    && ((Array.isArray(profile.experiences) && profile.experiences.length)
      || (Array.isArray(profile.education) && profile.education.length))) {
    return { ok: false, reason: "verified_empty_has_history" };
  }
  try {
    const facts = factsFromProfile(profile);
    if (!facts || !Array.isArray(facts.allCompanies)) {
      return { ok: false, reason: "facts_invalid" };
    }
    return {
      ok: true,
      key: target.key,
      rawProfile,
      rawReceipt,
      factsRaw: JSON.stringify(facts),
    };
  } catch {
    return { ok: false, reason: "facts_derivation_failed" };
  }
}

export async function writeFactIfSourcesUnchanged(staged, {
  kvImpl,
  K,
  activeRaw,
}) {
  const result = Number(await kvImpl([
    "EVAL",
    FACTS_CAS_LUA,
    4,
    K.sourceProfile(staged.key),
    K.sourceProfileReady,
    K.facts,
    K.activeGeneration,
    staged.key,
    staged.rawProfile,
    staged.rawReceipt,
    staged.factsRaw,
    activeRaw,
  ]));
  if (result === 1) return "written";
  if (result === -1) return "generation_changed";
  return "source_changed";
}

async function readRawBatches(targets, { kvImpl, K, dependencies }) {
  const staged = [];
  const skipped = {};
  for (let offset = 0; offset < targets.length; offset += READ_BATCH) {
    const batch = targets.slice(offset, offset + READ_BATCH);
    const [profiles, receipts] = await Promise.all([
      kvImpl(["MGET", ...batch.map(({ key }) => K.sourceProfile(key))]),
      kvImpl(["HMGET", K.sourceProfileReady, ...batch.map(({ key }) => key)]),
    ]);
    for (let index = 0; index < batch.length; index += 1) {
      const result = stageSourceFact({
        target: batch[index],
        rawProfile: Array.isArray(profiles) ? profiles[index] : null,
        rawReceipt: Array.isArray(receipts) ? receipts[index] : null,
        ...dependencies,
      });
      if (result.ok) staged.push(result);
      else skipped[result.reason] = (skipped[result.reason] || 0) + 1;
    }
  }
  return { staged, skipped };
}

export async function rebuildActiveFacts({
  apply = false,
  kvImpl,
  K,
  validPublication,
  readPublishedArtifacts,
  factsFromProfile,
  sourceProfileDigest,
  sourceObservationIdFor,
}) {
  const activeRaw = await kvImpl(["GET", K.activeGeneration]);
  const pointer = parseJson(activeRaw);
  if (typeof activeRaw !== "string" || !validPublication(pointer)) {
    throw new Error("active_generation_unavailable");
  }
  const readJson = async (key) => parseJson(await kvImpl(["GET", key]));
  const artifacts = await readPublishedArtifacts(pointer, { readJson });
  if (!artifacts) throw new Error("active_generation_invalid");

  const selected = activeSourceTargets(artifacts, { sourceObservationIdFor });
  const { staged, skipped } = await readRawBatches(selected.targets, {
    kvImpl,
    K,
    dependencies: { factsFromProfile, sourceProfileDigest, sourceObservationIdFor },
  });
  if (await kvImpl(["GET", K.activeGeneration]) !== activeRaw) {
    throw new Error("active_generation_changed_during_staging");
  }
  const report = {
    mode: apply ? "apply" : "dry-run",
    activeGenerationDigest: pointer.digest,
    activeRowCount: selected.rows,
    targetCount: selected.targets.length,
    invalidActiveRowCount: selected.invalidRows,
    conflictingObservationTargetCount: selected.conflictingObservationTargets,
    eligibleCount: staged.length,
    skipped,
    targetSetDigest: digest(selected.targets.map(({ key, observationId }) => `${key}\0${observationId}`).join("\n")),
    stagedFactsDigest: digest(staged.map(({ key, factsRaw }) => `${key}\0${digest(factsRaw)}`).join("\n")),
    attemptedCount: 0,
    writtenCount: 0,
    sourceRaceCount: 0,
    generationRaceCount: 0,
    readbackVerifiedCount: 0,
    readbackMismatchCount: 0,
  };
  if (!apply) return report;

  for (const item of staged) {
    report.attemptedCount += 1;
    const status = await writeFactIfSourcesUnchanged(item, { kvImpl, K, activeRaw });
    if (status === "source_changed") {
      report.sourceRaceCount += 1;
      continue;
    }
    if (status === "generation_changed") {
      report.generationRaceCount += 1;
      continue;
    }
    report.writtenCount += 1;
    const stored = await kvImpl(["HGET", K.facts, item.key]);
    if (stored === item.factsRaw) report.readbackVerifiedCount += 1;
    else report.readbackMismatchCount += 1;
  }
  return report;
}

async function runtime() {
  const [kvModule, generationModule, factsModule, digestModule, readinessModule] = await Promise.all([
    import("../api/applicants/_lib/kv.mjs"),
    import("../api/applicants/_lib/generation.mjs"),
    import("../api/applicants/_lib/facts.mjs"),
    import("../api/applicants/_lib/source-profile-digest.mjs"),
    import("../api/applicants/_lib/profile-readiness.mjs"),
  ]);
  return {
    kvImpl: kvModule.kv,
    K: kvModule.K,
    kvConfigured: kvModule.kvConfigured,
    validPublication: generationModule.validPublication,
    readPublishedArtifacts: generationModule.readPublishedArtifacts,
    factsFromProfile: factsModule.factsFromProfile,
    sourceProfileDigest: digestModule.sourceProfileDigest,
    sourceObservationIdFor: readinessModule.sourceObservationIdFor,
  };
}

function usage() {
  return [
    "Rebuild current Applicant facts from durable source profiles.",
    "Default: read-only dry run.",
    "Usage: node --env-file=/absolute/.env.local scripts/rebuild-applicant-facts.mjs [--dry-run|--apply]",
  ].join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const deps = await runtime();
  if (!deps.kvConfigured()) throw new Error("applicants_state_store_not_configured");
  const report = await rebuildActiveFacts({ apply: options.apply, ...deps });
  console.log(JSON.stringify(report, null, 2));
  if (options.apply && (report.sourceRaceCount || report.generationRaceCount || report.readbackMismatchCount)) {
    process.exitCode = 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: String(error?.message || error).slice(0, 120) }));
    process.exitCode = 1;
  });
}
