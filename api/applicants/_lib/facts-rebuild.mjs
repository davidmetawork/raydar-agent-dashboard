// Guarded, bounded rebuilding of Applicant Rules facts from durable source profiles.
// This module is dependency-injected so the CLI can load its environment before
// importing the KV client and the authenticated API can use the same logic.
import { createHash } from "node:crypto";

const PROFILE_KEY_RE = /^(?:[a-z0-9]{10,40}|core:[a-z0-9]{10,64})$/i;
const DIGEST_RE = /^[a-f0-9]{64}$/i;
const HISTORY_STATES = new Set(["data", "verified_empty"]);
const READ_BATCH = 25;
const WRITE_BATCH = 10;

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

export function activeSourceTargets(artifacts, { sourceObservationIdFor, includeStream = true }) {
  const rows = [
    ...(includeStream && Array.isArray(artifacts?.snapshot?.stream) ? artifacts.snapshot.stream : []),
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

export async function loadActiveSourceFactPage({
  offset = 0,
  limit = null,
  includeStream = true,
  expectedGenerationId = null,
  kvImpl,
  K,
  validPublication,
  readPublishedArtifacts,
  factsFromProfile,
  sourceProfileDigest,
  sourceObservationIdFor,
}) {
  if (!Number.isSafeInteger(offset) || offset < 0
    || (limit != null && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100))) {
    throw new Error("facts_rebuild_page_invalid");
  }
  const activeRaw = await kvImpl(["GET", K.activeGeneration]);
  const pointer = parseJson(activeRaw);
  if (typeof activeRaw !== "string" || !validPublication(pointer)) {
    throw new Error("active_generation_unavailable");
  }
  if (expectedGenerationId != null && expectedGenerationId !== pointer.generationId) {
    throw new Error("expected_generation_mismatch");
  }
  const readJson = async (key) => parseJson(await kvImpl(["GET", key]));
  const artifacts = await readPublishedArtifacts(pointer, { readJson });
  if (!artifacts) throw new Error("active_generation_invalid");

  const selected = activeSourceTargets(artifacts, { sourceObservationIdFor, includeStream });
  const end = limit == null ? selected.targets.length : offset + limit;
  const targets = selected.targets.slice(offset, end);
  const { staged, skipped } = await readRawBatches(targets, {
    kvImpl,
    K,
    dependencies: { factsFromProfile, sourceProfileDigest, sourceObservationIdFor },
  });
  if (await kvImpl(["GET", K.activeGeneration]) !== activeRaw) {
    throw new Error("active_generation_changed_during_staging");
  }
  return {
    pointer,
    activeRaw,
    selected,
    offset,
    targets,
    staged,
    skipped,
    nextOffset: offset + targets.length < selected.targets.length ? offset + targets.length : null,
  };
}

export function companyCatalogFromFactPage(page) {
  const companies = new Map();
  let companyRowsWithoutId = 0;
  let companyNameConflictCount = 0;
  for (const item of page.staged) {
    const facts = parseJson(item.factsRaw);
    for (const company of Array.isArray(facts?.allCompanies) ? facts.allCompanies : []) {
      const companyId = text(company?.id);
      const name = text(company?.name);
      if (!companyId) {
        companyRowsWithoutId += 1;
        continue;
      }
      if (!companies.has(companyId)) {
        companies.set(companyId, { companyId, name });
      } else if (name && companies.get(companyId).name && companies.get(companyId).name !== name) {
        companyNameConflictCount += 1;
        if (name.localeCompare(companies.get(companyId).name) < 0) companies.get(companyId).name = name;
      } else if (name && !companies.get(companyId).name) {
        companies.get(companyId).name = name;
      }
    }
  }
  const list = [...companies.values()].sort((a, b) => a.companyId.localeCompare(b.companyId));
  return {
    generationId: page.pointer.generationId,
    activeRowCount: page.selected.rows,
    totalProfiles: page.selected.targets.length,
    invalidActiveRowCount: page.selected.invalidRows,
    conflictingObservationTargetCount: page.selected.conflictingObservationTargets,
    offset: page.offset,
    nextOffset: page.nextOffset,
    profilesRead: page.targets.length,
    eligibleProfiles: page.staged.length,
    skipped: page.skipped,
    companies: list,
    companyCount: list.length,
    companyRowsWithoutId,
    companyNameConflictCount,
    pageDigest: digest(list.map(({ companyId, name }) => `${companyId}\0${name ?? ""}`).join("\n")),
  };
}

export async function rebuildActiveFacts({
  apply = false,
  offset = 0,
  limit = null,
  includeStream = true,
  expectedGenerationId = null,
  kvImpl,
  K,
  validPublication,
  readPublishedArtifacts,
  factsFromProfile,
  sourceProfileDigest,
  sourceObservationIdFor,
}) {
  const page = await loadActiveSourceFactPage({
    offset,
    limit,
    includeStream,
    expectedGenerationId,
    kvImpl,
    K,
    validPublication,
    readPublishedArtifacts,
    factsFromProfile,
    sourceProfileDigest,
    sourceObservationIdFor,
  });
  const { pointer, activeRaw, selected, targets, staged, skipped } = page;
  const report = {
    mode: apply ? "apply" : "dry-run",
    generationId: pointer.generationId,
    activeGenerationDigest: pointer.digest,
    activeRowCount: selected.rows,
    totalProfiles: selected.targets.length,
    offset: page.offset,
    nextOffset: page.nextOffset,
    targetCount: targets.length,
    invalidActiveRowCount: selected.invalidRows,
    conflictingObservationTargetCount: selected.conflictingObservationTargets,
    eligibleCount: staged.length,
    skipped,
    targetSetDigest: digest(targets.map(({ key, observationId }) => `${key}\0${observationId}`).join("\n")),
    stagedFactsDigest: digest(staged.map(({ key, factsRaw }) => `${key}\0${digest(factsRaw)}`).join("\n")),
    attemptedCount: 0,
    writtenCount: 0,
    sourceRaceCount: 0,
    generationRaceCount: 0,
    readbackVerifiedCount: 0,
    readbackMismatchCount: 0,
  };
  if (!apply) return report;

  for (let offset = 0; offset < staged.length; offset += WRITE_BATCH) {
    const batch = staged.slice(offset, offset + WRITE_BATCH);
    const results = await Promise.all(batch.map(async (item) => {
      const status = await writeFactIfSourcesUnchanged(item, { kvImpl, K, activeRaw });
      if (status !== "written") return { status, readback: null };
      const stored = await kvImpl(["HGET", K.facts, item.key]);
      return { status, readback: stored === item.factsRaw };
    }));
    report.attemptedCount += results.length;
    for (const result of results) {
      if (result.status === "source_changed") report.sourceRaceCount += 1;
      else if (result.status === "generation_changed") report.generationRaceCount += 1;
      else {
        report.writtenCount += 1;
        if (result.readback) report.readbackVerifiedCount += 1;
        else report.readbackMismatchCount += 1;
      }
    }
  }
  return report;
}
