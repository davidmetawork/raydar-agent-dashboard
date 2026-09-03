// Immutable Applicants publication generations.
//
// A browser read must never join the old snapshot with a newer queue (or let a
// decision write against a page that has already been replaced).  Publishers
// write a complete, generation-scoped set of artifacts first and move this one
// pointer last.  Readers load the pointer before any artifact and fail closed
// when the pointer, artifacts, or digest disagree.

import { createHash, randomUUID } from "node:crypto";
import {
  compareAndSetJson,
  getJson,
  K,
  setJsonIfAbsent,
} from "./kv.mjs";

export const GENERATION_SCHEMA_VERSION = 1;
export const GENERATION_ID_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;
export const DIGEST_RE = /^[a-f0-9]{64}$/i;

const GENERATION_FIELDS = new Set([
  "generationId",
  "generationDigest",
  "artifactDigest",
  "artifactIntegrityDigest",
]);

function canonical(value) {
  return JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
  });
}

export function stableDigest(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function stripGeneration(value) {
  if (Array.isArray(value)) return value.map(stripGeneration);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !GENERATION_FIELDS.has(key))
    .map(([key, item]) => [key, stripGeneration(item)]));
}

export function artifactDigest(value) {
  return stableDigest(stripGeneration(value));
}

/**
 * The logical generation digest is Core's contract, not Monitor's storage
 * checksum.  It deliberately covers only the source-supplied generation
 * identity/high-water marks and the unstamped payloads.  Monitor must be able
 * to recompute this before publication without adding K-derived counts,
 * artifact stamps, or another display-only field to Core's digest.
 */
export function coreGenerationDigest({
  generationId,
  sourceCutoff = null,
  sourceWatermark = null,
  snapshot,
  queue,
} = {}) {
  return stableDigest({
    generationId,
    sourceCutoff,
    sourceWatermark,
    snapshot: stripGeneration(snapshot),
    queue: stripGeneration(queue),
  });
}

export function validGenerationId(value) {
  return typeof value === "string" && GENERATION_ID_RE.test(value);
}

export function validDigest(value) {
  return typeof value === "string" && DIGEST_RE.test(value);
}

export function validPublication(pointer) {
  return Boolean(pointer
    && pointer.schemaVersion === GENERATION_SCHEMA_VERSION
    && validGenerationId(pointer.generationId)
    && validDigest(pointer.digest)
    && validDigest(pointer.artifactIntegrityDigest)
    && validDigest(pointer.snapshotDigest)
    && validDigest(pointer.queueDigest)
    && validDigest(pointer.countsDigest)
    && Object.prototype.hasOwnProperty.call(pointer, "sourceCutoff")
    && Object.prototype.hasOwnProperty.call(pointer, "sourceWatermark"));
}

function rowForGeneration(row, generationId, digest, sourceCutoff, sourceWatermark) {
  return row && typeof row === "object"
    ? { ...row, generationId, generationDigest: digest, sourceCutoff, sourceWatermark }
    : row;
}

function rowsForGeneration(rows, generationId, digest, sourceCutoff, sourceWatermark) {
  return Array.isArray(rows)
    ? rows.map((row) => rowForGeneration(row, generationId, digest, sourceCutoff, sourceWatermark))
    : [];
}

function profilePreparingCount(snapshot) {
  const value = snapshot?.profilePreparing;
  if (Array.isArray(value)) return value.length;
  if (Number.isSafeInteger(value) && value >= 0) return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const count = value.count ?? value.total;
    if (Number.isSafeInteger(count) && count >= 0) return count;
  }
  return 0;
}

/**
 * Build the four immutable artifacts and their pointer metadata.  The caller
 * may supply a source cutoff/watermark from Core; absent values stay explicit
 * nulls rather than being invented from wall-clock time.
 */
export function buildGeneration({
  snapshot,
  queue,
  counts,
  sourceCutoff = null,
  sourceWatermark = null,
  displayDigest = null,
  generationDigest = null,
  generationId = randomUUID(),
  publishedAt = new Date().toISOString(),
} = {}) {
  if (!validGenerationId(generationId)) throw new Error("generation_id_invalid");
  const suppliedDigest = generationDigest == null ? null : generationDigest;
  if (suppliedDigest != null && !validDigest(suppliedDigest)) {
    throw new Error("generation_digest_invalid");
  }
  const sourceRows = (rows) => rowsForGeneration(rows, "", "", sourceCutoff, sourceWatermark)
    .map((row) => {
      if (!row || typeof row !== "object") return row;
      const {
        generationId: _generationId,
        generationDigest: _generationDigest,
        artifactDigest: _artifactDigest,
        ...withoutGeneration
      } = row;
      return withoutGeneration;
    });
  const baseSnapshot = {
    ...(snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) ? snapshot : {}),
    sourceCutoff,
    sourceWatermark,
    ...(Array.isArray(snapshot?.stream) ? { stream: sourceRows(snapshot.stream) } : {}),
    ...(Array.isArray(snapshot?.queue) ? { queue: sourceRows(snapshot.queue) } : {}),
  };
  const baseQueue = {
    generatedAt: String(baseSnapshot.generatedAt || publishedAt),
    rows: sourceRows(Array.isArray(queue) ? queue : []),
    sourceCutoff,
    sourceWatermark,
  };
  const baseCounts = {
    ...(counts && typeof counts === "object" && !Array.isArray(counts) ? counts : {}),
    sourceCutoff,
    sourceWatermark,
  };

  // Do not include generation fields in the digest input.  This allows every
  // reader to recompute the same digest after stripping the publication stamp.
  const snapshotDigest = artifactDigest(baseSnapshot);
  const queueDigest = artifactDigest(baseQueue);
  const countsDigest = artifactDigest(baseCounts);
  const logicalDigest = coreGenerationDigest({
    generationId,
    sourceCutoff,
    sourceWatermark,
    snapshot,
    queue,
  });
  if (suppliedDigest != null && suppliedDigest.toLowerCase() !== logicalDigest) {
    throw new Error("generation_digest_mismatch");
  }
  const artifactIntegrityDigest = stableDigest({
    schemaVersion: GENERATION_SCHEMA_VERSION,
    generationId,
    snapshotDigest,
    queueDigest,
    countsDigest,
    sourceCutoff,
    sourceWatermark,
    displayDigest: displayDigest || null,
  });
  // digest is the exact Core-supplied value when a publisher provides one;
  // artifactIntegrityDigest is Monitor's independent readback commitment.
  const digest = suppliedDigest || logicalDigest;

  const snapshotArtifact = {
    ...baseSnapshot,
    generationId,
    generationDigest: digest,
    artifactDigest: snapshotDigest,
    sourceCutoff,
    sourceWatermark,
    ...(Array.isArray(baseSnapshot.stream)
      ? { stream: rowsForGeneration(baseSnapshot.stream, generationId, digest, sourceCutoff, sourceWatermark) }
      : {}),
    ...(Array.isArray(baseSnapshot.queue)
      ? { queue: rowsForGeneration(baseSnapshot.queue, generationId, digest, sourceCutoff, sourceWatermark) }
      : {}),
  };
  const queueArtifact = {
    ...baseQueue,
    generationId,
    generationDigest: digest,
    artifactDigest: queueDigest,
    sourceCutoff,
    sourceWatermark,
    rows: rowsForGeneration(baseQueue.rows, generationId, digest, sourceCutoff, sourceWatermark),
  };
  const countsArtifact = {
    ...baseCounts,
    generationId,
    generationDigest: digest,
    artifactDigest: countsDigest,
    sourceCutoff,
    sourceWatermark,
  };
  const pointer = {
    schemaVersion: GENERATION_SCHEMA_VERSION,
    generationId,
    digest,
    artifactIntegrityDigest,
    snapshotDigest,
    queueDigest,
    countsDigest,
    displayDigest: displayDigest || null,
    sourceCutoff,
    sourceWatermark,
    publishedAt,
  };
  return {
    pointer,
    snapshot: snapshotArtifact,
    queue: queueArtifact,
    counts: countsArtifact,
  };
}

export function verifyGeneration({ pointer, snapshot, queue, counts } = {}) {
  if (!validPublication(pointer)) return { ok: false, error: "generation_pointer_invalid" };
  if (!snapshot || !queue || !counts) return { ok: false, error: "generation_artifact_missing" };
  const artifacts = [snapshot, queue, counts];
  if (artifacts.some((artifact) => artifact.generationId !== pointer.generationId
    || artifact.generationDigest !== pointer.digest)) {
    return { ok: false, error: "generation_stamp_mismatch" };
  }
  if (artifacts.some((artifact) => stableDigest(artifact.sourceCutoff ?? null)
    !== stableDigest(pointer.sourceCutoff ?? null)
    || stableDigest(artifact.sourceWatermark ?? null)
      !== stableDigest(pointer.sourceWatermark ?? null))) {
    return { ok: false, error: "generation_source_stamp_mismatch" };
  }
  if (artifactDigest(snapshot) !== pointer.snapshotDigest
    || artifactDigest(queue) !== pointer.queueDigest
    || artifactDigest(counts) !== pointer.countsDigest) {
    return { ok: false, error: "generation_artifact_digest_mismatch" };
  }
  const expectedCounts = {
    total: (Array.isArray(snapshot.stream) ? snapshot.stream.length : 0)
      + (Array.isArray(queue.rows) ? queue.rows.length : 0)
      + profilePreparingCount(snapshot),
    stream: Array.isArray(snapshot.stream) ? snapshot.stream.length : 0,
    queue: Array.isArray(queue.rows) ? queue.rows.length : 0,
    profilePreparing: profilePreparingCount(snapshot),
  };
  if (["total", "stream", "queue", "profilePreparing"].some((key) =>
    !Number.isSafeInteger(counts[key]) || counts[key] < 0 || counts[key] !== expectedCounts[key])) {
    return { ok: false, error: "generation_counts_mismatch" };
  }
  const rows = [
    ...(Array.isArray(snapshot.stream) ? snapshot.stream : []),
    ...(Array.isArray(snapshot.queue) ? snapshot.queue : []),
    ...(Array.isArray(queue.rows) ? queue.rows : []),
  ];
  if (rows.some((row) => row && (row.generationId !== pointer.generationId
    || row.generationDigest !== pointer.digest
    || stableDigest(row.sourceCutoff ?? null) !== stableDigest(pointer.sourceCutoff ?? null)
    || stableDigest(row.sourceWatermark ?? null) !== stableDigest(pointer.sourceWatermark ?? null)))) {
    return { ok: false, error: "generation_row_stamp_mismatch" };
  }
  const expectedArtifactIntegrityDigest = stableDigest({
    schemaVersion: pointer.schemaVersion,
    generationId: pointer.generationId,
    snapshotDigest: pointer.snapshotDigest,
    queueDigest: pointer.queueDigest,
    countsDigest: pointer.countsDigest,
    sourceCutoff: pointer.sourceCutoff ?? null,
    sourceWatermark: pointer.sourceWatermark ?? null,
    displayDigest: pointer.displayDigest || null,
  });
  if (expectedArtifactIntegrityDigest !== pointer.artifactIntegrityDigest) {
    return { ok: false, error: "generation_content_digest_mismatch" };
  }
  return { ok: true };
}

export async function readActivePublication({ readJson = getJson } = {}) {
  const pointer = await readJson(K.activeGeneration).catch(() => null);
  return validPublication(pointer) ? pointer : null;
}

export async function readPublishedArtifacts(pointer, { readJson = getJson } = {}) {
  if (!validPublication(pointer)) return null;
  const prefix = K.generation(pointer.generationId);
  const [snapshot, queue, counts] = await Promise.all([
    readJson(`${prefix}:snapshot`),
    readJson(`${prefix}:queue`),
    readJson(`${prefix}:counts`),
  ]);
  const checked = verifyGeneration({ pointer, snapshot, queue, counts });
  return checked.ok ? { pointer, snapshot, queue, counts } : null;
}

/**
 * Publish artifacts immutably, reread them, then CAS the active pointer.  A
 * failed write leaves the previous pointer untouched.  The optional seams keep
 * the handler unit-testable without weakening the production CAS path.
 */
export async function publishGeneration({
  generation,
  expectedCounts = null,
  readJson = getJson,
  writeImmutableJson = setJsonIfAbsent,
  activate = compareAndSetJson,
} = {}) {
  if (!generation?.pointer || !validPublication(generation.pointer)) {
    throw new Error("generation_invalid");
  }
  const { pointer, snapshot, queue, counts } = generation;
  const prefix = K.generation(pointer.generationId);
  const artifacts = [
    [`${prefix}:snapshot`, snapshot],
    [`${prefix}:queue`, queue],
    [`${prefix}:counts`, counts],
    [`${prefix}:meta`, pointer],
  ];
  for (const [key, value] of artifacts) {
    const result = await writeImmutableJson(key, value);
    // SET NX returns null when a generation id was already used.  Re-reading
    // below distinguishes a harmless retry of the same immutable artifact from
    // a collision/corruption.
    if (result === null || result === false || result === 0) {
      const existing = await readJson(key);
      if (stableDigest(existing) !== stableDigest(value)) {
        throw new Error("generation_immutable_collision");
      }
    }
  }
  const [storedSnapshot, storedQueue, storedCounts, storedMeta] = await Promise.all([
    readJson(`${prefix}:snapshot`),
    readJson(`${prefix}:queue`),
    readJson(`${prefix}:counts`),
    readJson(`${prefix}:meta`),
  ]);
  const check = verifyGeneration({ pointer, snapshot: storedSnapshot, queue: storedQueue, counts: storedCounts });
  if (!check.ok) throw new Error(check.error);
  if (!validPublication(storedMeta)
    || storedMeta.generationId !== pointer.generationId
    || storedMeta.digest !== pointer.digest
    || storedMeta.artifactIntegrityDigest !== pointer.artifactIntegrityDigest
    || storedMeta.snapshotDigest !== pointer.snapshotDigest
    || storedMeta.queueDigest !== pointer.queueDigest
    || storedMeta.countsDigest !== pointer.countsDigest
    || stableDigest(storedMeta.sourceCutoff ?? null) !== stableDigest(pointer.sourceCutoff ?? null)
    || stableDigest(storedMeta.sourceWatermark ?? null) !== stableDigest(pointer.sourceWatermark ?? null)) {
    throw new Error("generation_meta_mismatch");
  }

  // Return the values observed from the immutable artifacts, not just the
  // values the publisher attempted to write.  Core uses this readback as the
  // publication receipt: a matching id/digest with a different source tuple or
  // conserved count is not the same generation.
  const readback = {
    generationId: storedMeta.generationId,
    digest: storedMeta.digest,
    sourceCutoff: storedMeta.sourceCutoff ?? null,
    sourceWatermark: storedMeta.sourceWatermark ?? null,
    artifactIntegrityDigest: storedMeta.artifactIntegrityDigest,
    counts: {
      total: storedCounts?.total ?? null,
      stream: storedCounts?.stream ?? null,
      queue: storedCounts?.queue ?? null,
      profilePreparing: storedCounts?.profilePreparing ?? null,
    },
  };
  if (expectedCounts && ["total", "stream", "queue", "profilePreparing"].some((key) =>
    stableDigest(readback.counts[key] ?? null) !== stableDigest(expectedCounts[key] ?? null))) {
    throw new Error("generation_counts_readback_mismatch");
  }

  const previous = await readActivePublication({ readJson });
  const activated = await activate(K.activeGeneration, previous, pointer);
  if (!activated) {
    const current = await readActivePublication({ readJson });
    if (!current || current.generationId !== pointer.generationId || current.digest !== pointer.digest) {
      return { ok: false, activated: false, pointer, current };
    }
  }
  return { ok: true, activated: true, pointer, readback };
}

/**
 * Only genuine safety holds block a new Interview. Legacy `interviewAllowed`
 * and readiness flags are technical delivery hints and intentionally do not
 * participate in this predicate.
 */
const HARD_HOLD_STATES = new Set([
  "identity_review",
  "recipient_review",
  "delivery_review",
  "withdrawn",
  "privacy_hold",
  "do_not_process",
]);
const HARD_HOLD_CODES = new Set([
  "identity_conflict",
  "cross_person_identity_conflict",
  "recipient_conflict",
  "recipient_reserved_other_person",
  "ambiguous_delivery",
  "delivery_reconciliation_required",
  "source_withdrawn",
  "withdrawn",
  "privacy_hold",
  "do_not_process",
  "protected_person",
  "processing_basis_restricted",
]);

function normalizedHold(value) {
  const hold = String(value ?? "").trim().toLowerCase();
  return hold || null;
}

export function interviewDecisionHold(row) {
  if (!row || typeof row !== "object") return "application_missing";
  if (row.withdrawn === true || row.privacyHold === true || row.doNotProcess === true
    || row.protectedPerson === true || row.identityConflict === true || row.recipientConflict === true) {
    return normalizedHold(row.holdReasonCode || row.reasonCode)
      || (row.identityConflict ? "identity_conflict" : row.recipientConflict ? "recipient_conflict" : "policy_hold");
  }
  const candidates = [
    row.hardHoldCode,
    row.hard_hold_code,
    row.holdType,
    row.hold_type,
    row.decisionHoldCode,
    row.decision_hold_code,
    row.identityState === "conflict" ? "identity_conflict" : null,
    row.connectionState === "conflict" ? "identity_conflict" : null,
    row.readinessState,
    row.deliveryState,
    row.status,
  ].map(normalizedHold).filter(Boolean);
  return candidates.find((value) => HARD_HOLD_STATES.has(value) || HARD_HOLD_CODES.has(value)) || null;
}

export function interviewDecisionAllowed(row) {
  return interviewDecisionHold(row) == null;
}

export function actionabilityFor(row) {
  const hold = interviewDecisionHold(row);
  return {
    interviewDecisionAllowed: !hold,
    ...(hold ? { interviewDecisionHold: hold } : { interviewDecisionHold: null }),
  };
}

export function generationManifest(rows) {
  const keys = [...new Set((Array.isArray(rows) ? rows : [])
    .map((row) => row?.key)
    .filter(Boolean))].sort();
  return { keys, digest: stableDigest(keys), count: keys.length };
}

export const generationKey = (generationId, artifact) => K.generation(generationId, artifact);
