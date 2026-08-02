import { createHash, randomBytes } from "node:crypto";
import {
  BOOKING_MEMBERSHIP_ATTEMPT_SCHEMA,
  BOOKING_MEMBERSHIP_BUILD_BUDGET_MS,
  BOOKING_MEMBERSHIP_CHECKPOINT_SCHEMA,
  BOOKING_MEMBERSHIP_CURRENT_SCHEMA,
  BOOKING_MEMBERSHIP_MAX_AGE_MS,
  BOOKING_MEMBERSHIP_SHARD_SCHEMA,
  BOOKING_MEMBERSHIP_SNAPSHOT_SCHEMA,
  BOOKING_STOP_LEAD_INDEX_SCHEMA,
  BOOKING_STOP_SCOPE_SCHEMA,
} from "./booking-stop-contract.mjs";

const DIGEST = /^[a-f0-9]{64}$/u;
const GENERATION = /^[a-f0-9]{32}$/u;
const IMMUTABLE_TTL_SECONDS = 24 * 60 * 60;
const CHECKPOINT_TTL_SECONDS = 3 * 60 * 60;
const CURRENT_TTL_SECONDS = 6 * 60 * 60;
const LOCK_TTL_SECONDS = 5 * 60;
export const BOOKING_MEMBERSHIP_MAX_SHARDS = 512;
const BOOKING_MEMBERSHIP_LEAD_FIELDS = Object.freeze([
  "ccu_id",
  "created_at",
  "cu_id",
  "is_archived",
  "is_paused",
  "to_use_email",
  "user_emails",
]);

export const BOOKING_MEMBERSHIP_KEYS = Object.freeze({
  current: "seqguard:membership:current:v1",
  checkpoint: "seqguard:membership:checkpoint:v1",
  lock: "seqguard:membership:refresh-lock:v1",
  attempt: "seqguard:membership:lastattempt:v1",
  leadIndex: "seqguard:leadindex",
  manifest: (generation) =>
    `seqguard:membership:g:${generation}:manifest`,
  shard: (generation, token) =>
    `seqguard:membership:g:${generation}:shard:${token}`,
});

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
}

export function bookingMembershipCanonicalJson(value) {
  return JSON.stringify(stableValue(value));
}

export function bookingMembershipHash(value) {
  return createHash("sha256")
    .update(bookingMembershipCanonicalJson(value))
    .digest("hex");
}

function exactValue(left, right) {
  return bookingMembershipCanonicalJson(left)
    === bookingMembershipCanonicalJson(right);
}

function timestamp(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function fail(code, detail = null) {
  const error = new Error(code);
  error.code = code;
  if (detail != null) error.detail = detail;
  return error;
}

function selectedSequenceIds(scope) {
  return Array.isArray(scope?.sequences)
    ? scope.sequences.map((sequence) => String(sequence?.id || ""))
    : [];
}

function canonicalSequences(scope) {
  return [...(scope?.sequences || [])].sort((left, right) => {
    const leftId = String(left?.id || "");
    const rightId = String(right?.id || "");
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
}

export function assertBookingMembershipScope(scope) {
  const ids = selectedSequenceIds(scope);
  if (
    !scope
    || typeof scope !== "object"
    || Array.isArray(scope)
    || scope.schema !== BOOKING_STOP_SCOPE_SCHEMA
    || !DIGEST.test(String(scope.scopeDigest || ""))
    || !Number.isInteger(scope.catalogFloor)
    || scope.catalogFloor < 1
    || scope.complete !== true
    || !Array.isArray(scope.sequences)
    || scope.sequences.length > BOOKING_MEMBERSHIP_MAX_SHARDS
    || !Number.isInteger(scope.catalogSequences)
    || scope.catalogSequences < scope.catalogFloor
    || scope.scannedSequences !== scope.catalogSequences
    || !Number.isInteger(scope.linkSequences)
    || scope.linkSequences < 0
    || !Number.isInteger(scope.enabledLinkSequences)
    || scope.enabledLinkSequences < 0
    || scope.coveredEnabledLinkSequences !== scope.enabledLinkSequences
    || ids.some((id) => !id)
    || new Set(ids).size !== ids.length
  ) {
    throw fail("BOOKING_MEMBERSHIP_SCOPE_INVALID");
  }
  return scope;
}

function scopeBinding(scope) {
  assertBookingMembershipScope(scope);
  return {
    schema: scope.schema,
    digest: scope.scopeDigest,
    catalogFloor: scope.catalogFloor,
    catalogSequenceCount: scope.catalogSequences,
    selectedSequenceIds: selectedSequenceIds(scope).sort(),
    selectedSequenceCount: scope.sequences.length,
    linkSequenceCount: scope.linkSequences,
    enabledLinkSequenceCount: scope.enabledLinkSequences,
    coveredEnabledLinkSequenceCount: scope.coveredEnabledLinkSequences,
  };
}

function sameScope(left, right) {
  return exactValue(scopeBinding(left), scopeBinding(right));
}

function validGeneration(value) {
  return GENERATION.test(String(value || ""));
}

function validLeadProjection(lead, notAfterMs) {
  const createdAtMs = timestamp(lead?.created_at);
  return Boolean(
    lead
    && typeof lead === "object"
    && !Array.isArray(lead)
    && exactValue(
      Object.keys(lead).sort(),
      BOOKING_MEMBERSHIP_LEAD_FIELDS,
    )
    && typeof lead.ccu_id === "string"
    && lead.ccu_id
    && typeof lead.cu_id === "string"
    && lead.cu_id
    && (lead.to_use_email === null
      || typeof lead.to_use_email === "string")
    && Array.isArray(lead.user_emails)
    && lead.user_emails.every((email) => typeof email === "string")
    && typeof lead.created_at === "string"
    && createdAtMs != null
    && Number.isFinite(notAfterMs)
    && createdAtMs <= notAfterMs
    && typeof lead.is_paused === "boolean"
    && typeof lead.is_archived === "boolean"
  );
}

function normalizeLead(lead, notAfterMs) {
  if (
    !lead
    || typeof lead !== "object"
    || Array.isArray(lead)
    || typeof lead.ccu_id !== "string"
    || !lead.ccu_id
    || typeof lead.cu_id !== "string"
    || !lead.cu_id
    || !(
      lead.to_use_email === null
      || typeof lead.to_use_email === "string"
    )
    || !Array.isArray(lead.user_emails)
    || lead.user_emails.some((email) => typeof email !== "string")
    || typeof lead.created_at !== "string"
    || timestamp(lead.created_at) == null
    || !Number.isFinite(notAfterMs)
    || timestamp(lead.created_at) > notAfterMs
    || typeof lead.is_paused !== "boolean"
    || typeof lead.is_archived !== "boolean"
  ) {
    throw fail("BOOKING_MEMBERSHIP_READ_INCOMPLETE");
  }
  // Persist only the fields the sweep and webhook index actually consume.
  // Paraform lead rows also carry recruiting-profile data such as LinkedIn and
  // recent-experience fields; copying the whole upstream object would turn this
  // 24-hour correctness cache into an unnecessary secondary profile store.
  const normalized = {
    ccu_id: lead.ccu_id,
    cu_id: lead.cu_id,
    to_use_email: lead.to_use_email,
    user_emails: [...lead.user_emails],
    created_at: lead.created_at,
    is_paused: lead.is_paused,
    is_archived: lead.is_archived,
  };
  if (!validLeadProjection(normalized, notAfterMs)) {
    throw fail("BOOKING_MEMBERSHIP_READ_INCOMPLETE");
  }
  return normalized;
}

function assertCompleteMembershipRead(read, notAfterMs) {
  if (
    !read
    || typeof read !== "object"
    || Array.isArray(read)
    || read.complete !== true
    || !Array.isArray(read.leads)
    || !Number.isInteger(read.totalCount)
    || read.totalCount < 0
    || !Number.isInteger(read.unique)
    || read.unique !== read.totalCount
    || read.shortfall !== 0
    || read.leads.length !== read.totalCount
  ) {
    throw fail("BOOKING_MEMBERSHIP_READ_INCOMPLETE");
  }
  const leads = read.leads.map((lead) =>
    normalizeLead(lead, notAfterMs));
  if (new Set(leads.map((lead) => lead.ccu_id)).size !== leads.length) {
    throw fail("BOOKING_MEMBERSHIP_READ_INCOMPLETE");
  }
  return leads;
}

function leadAddresses(lead) {
  const values = [
    lead?.to_use_email,
    ...(Array.isArray(lead?.user_emails) ? lead.user_emails : []),
  ];
  return new Set(values
    .map((value) => String(value || "").trim().toLowerCase())
    .filter((value) => value.includes("@")));
}

export function bookingMembershipLeadIndex({
  generation,
  manifestHash,
  scope,
  builtAt,
  perSequence,
  includePausedLead = () => false,
}) {
  const byEmail = {};
  for (const { sequence, leads } of perSequence) {
    for (const lead of leads) {
      if (
        lead.is_archived
        || !lead.ccu_id
        || (lead.is_paused && includePausedLead(lead) !== true)
      ) continue;
      for (const email of leadAddresses(lead)) {
        (byEmail[email] ||= []).push({
          s: sequence.id,
          sn: sequence.name,
          ccu: lead.ccu_id,
          cu: lead.cu_id,
          n: lead.name || null,
          t: lead.created_at,
        });
      }
    }
  }
  for (const entries of Object.values(byEmail)) {
    entries.sort((left, right) =>
      `${left.s}\0${left.ccu}`.localeCompare(`${right.s}\0${right.ccu}`));
  }
  return {
    schema: BOOKING_STOP_LEAD_INDEX_SCHEMA,
    snapshotSchema: BOOKING_MEMBERSHIP_SNAPSHOT_SCHEMA,
    generation,
    manifestHash,
    scopeSchema: scope.schema,
    scopeDigest: scope.scopeDigest,
    scopeCatalogFloor: scope.catalogFloor,
    builtAt,
    byEmail,
  };
}

async function immutableWrite(store, key, value, ttlSeconds) {
  const result = await store.setNx(key, value, ttlSeconds);
  const won = result === true || result === "OK";
  const readback = await store.get(key);
  if (!exactValue(readback, value)) {
    throw fail(
      won
        ? "BOOKING_MEMBERSHIP_READBACK_MISMATCH"
        : "BOOKING_MEMBERSHIP_IMMUTABLE_CONFLICT",
    );
  }
  return readback;
}

async function durableWrite(store, key, value, ttlSeconds) {
  const result = await store.set(key, value, ttlSeconds);
  if (result !== true && result !== "OK") {
    throw fail("BOOKING_MEMBERSHIP_CHECKPOINT_WRITE_FAILED");
  }
  const readback = await store.get(key);
  if (!exactValue(readback, value)) {
    throw fail("BOOKING_MEMBERSHIP_READBACK_MISMATCH");
  }
}

function checkpointMatches(checkpoint, scope, nowMs) {
  const oldest = timestamp(checkpoint?.oldestFetchedAt);
  return Boolean(
    checkpoint?.schema === BOOKING_MEMBERSHIP_CHECKPOINT_SCHEMA
    && checkpoint.status === "building"
    && validGeneration(checkpoint.generation)
    && Object.hasOwn(checkpoint, "baseCurrent")
    && exactValue(checkpoint.scope, scopeBinding(scope))
    && Array.isArray(checkpoint.shards)
    && checkpoint.shards.length <= scope.sequences.length
    && (
      oldest == null
      || (oldest <= nowMs && nowMs - oldest <= BOOKING_MEMBERSHIP_MAX_AGE_MS)
    )
  );
}

function newCheckpoint(
  scope,
  nowMs,
  generationFactory,
  baseCurrent,
) {
  const generation = String(generationFactory());
  if (!validGeneration(generation)) {
    throw fail("BOOKING_MEMBERSHIP_GENERATION_INVALID");
  }
  return {
    schema: BOOKING_MEMBERSHIP_CHECKPOINT_SCHEMA,
    status: "building",
    generation,
    startedAt: new Date(nowMs).toISOString(),
    updatedAt: new Date(nowMs).toISOString(),
    oldestFetchedAt: null,
    baseCurrent: baseCurrent == null ? null : cloneJson(baseCurrent),
    scope: scopeBinding(scope),
    shards: [],
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function descriptorShape(descriptor, generation) {
  const shardKeyPrefix =
    `seqguard:membership:g:${generation}:shard:`;
  return Boolean(
    descriptor
    && typeof descriptor === "object"
    && !Array.isArray(descriptor)
    && descriptor.schema === BOOKING_MEMBERSHIP_SHARD_SCHEMA
    && descriptor.generation === generation
    && typeof descriptor.key === "string"
    && descriptor.key.startsWith(shardKeyPrefix)
    && descriptor.key.length > shardKeyPrefix.length
    && typeof descriptor.sequenceId === "string"
    && descriptor.sequenceId
    && Number.isInteger(descriptor.count)
    && descriptor.count >= 0
    && DIGEST.test(String(descriptor.hash || ""))
    && timestamp(descriptor.fetchedAt) != null
  );
}

export async function runBookingMembershipRefresh({
  scopeLoader,
  membershipLoader,
  store,
  clock = Date.now,
  generationFactory = () => randomBytes(16).toString("hex"),
  shardTokenFactory = () => randomBytes(12).toString("hex"),
  budgetMs = BOOKING_MEMBERSHIP_BUILD_BUDGET_MS,
  concurrency = 2,
  includePausedLead = () => false,
} = {}) {
  if (
    typeof scopeLoader !== "function"
    || typeof membershipLoader !== "function"
    || !store
    || typeof store.get !== "function"
    || typeof store.set !== "function"
    || typeof store.setNx !== "function"
    || typeof store.atomicPublish !== "function"
    || typeof clock !== "function"
    || typeof shardTokenFactory !== "function"
    || !Number.isFinite(budgetMs)
    || budgetMs <= 0
    || budgetMs > BOOKING_MEMBERSHIP_BUILD_BUDGET_MS
    || !Number.isInteger(concurrency)
    || concurrency < 1
    || concurrency > 4
    || typeof includePausedLead !== "function"
  ) {
    throw fail("BOOKING_MEMBERSHIP_REFRESH_CONFIG_INVALID");
  }

  const startedAtMs = Number(clock());
  // Leave enough of the 240s contract for the second live scope read, manifest
  // proof, and atomic publication. A completed membership batch near the edge
  // checkpoints and finalizes on the next invocation instead of gambling on the
  // platform's 300s hard timeout.
  const finalizationReserveMs = Math.min(
    20 * 1000,
    Math.floor(budgetMs / 4),
  );
  const membershipWorkBudgetMs = budgetMs - finalizationReserveMs;
  const lockToken = randomBytes(16).toString("hex");
  const lock = await store.setNx(
    BOOKING_MEMBERSHIP_KEYS.lock,
    {
      schema: "raydar-booking-membership-lock-v1",
      token: lockToken,
      at: new Date(startedAtMs).toISOString(),
    },
    LOCK_TTL_SECONDS,
  );
  if (lock !== true && lock !== "OK") {
    return {
      ok: false,
      complete: false,
      error: "membership_refresh_locked",
      durationMs: Number(clock()) - startedAtMs,
    };
  }
  const lockReadback = await store.get(BOOKING_MEMBERSHIP_KEYS.lock);
  if (
    lockReadback?.schema !== "raydar-booking-membership-lock-v1"
    || lockReadback.token !== lockToken
  ) {
    throw fail("BOOKING_MEMBERSHIP_LOCK_UNVERIFIED");
  }

  const scopeBefore = assertBookingMembershipScope(await scopeLoader());
  const orderedSequences = canonicalSequences(scopeBefore);
  const priorCurrent = await store.get(BOOKING_MEMBERSHIP_KEYS.current);
  const saved = await store.get(BOOKING_MEMBERSHIP_KEYS.checkpoint);
  const savedMatches = checkpointMatches(
    saved, scopeBefore, Number(clock()),
  );
  const resumeSaved = Boolean(
    savedMatches
    && (
      exactValue(saved.baseCurrent, priorCurrent)
      || (
        priorCurrent?.schema === BOOKING_MEMBERSHIP_CURRENT_SCHEMA
        && priorCurrent.generation === saved.generation
      )
    ),
  );
  let checkpoint = resumeSaved
    ? saved
    : newCheckpoint(
        scopeBefore,
        Number(clock()),
        generationFactory,
        priorCurrent,
      );
  if (!resumeSaved) {
    await durableWrite(
      store,
      BOOKING_MEMBERSHIP_KEYS.checkpoint,
      checkpoint,
      CHECKPOINT_TTL_SECONDS,
    );
  }

  // Verify every resumed descriptor before trusting it as completed work.
  const expectedIds = orderedSequences.map(({ id }) => id);
  const completedById = new Map();
  for (const descriptor of checkpoint.shards) {
    if (
      !descriptorShape(descriptor, checkpoint.generation)
      || !expectedIds.includes(descriptor.sequenceId)
      || completedById.has(descriptor.sequenceId)
    ) {
      throw fail("BOOKING_MEMBERSHIP_CHECKPOINT_INVALID");
    }
    const shard = await store.get(descriptor.key);
    const shardFetchedAtMs = timestamp(shard?.fetchedAt);
    if (
      !shard
      || shard.schema !== BOOKING_MEMBERSHIP_SHARD_SCHEMA
      || shard.generation !== checkpoint.generation
      || shard.sequenceId !== descriptor.sequenceId
      || shard.fetchedAt !== descriptor.fetchedAt
      || shardFetchedAtMs == null
      || !Array.isArray(shard.leads)
      || shard.leads.length !== descriptor.count
      || shard.leads.some((lead) =>
        !validLeadProjection(lead, shardFetchedAtMs))
      || bookingMembershipHash(shard) !== descriptor.hash
    ) {
      throw fail("BOOKING_MEMBERSHIP_CHECKPOINT_INVALID");
    }
    completedById.set(descriptor.sequenceId, { descriptor, shard });
  }

  const checkpointed = () => ({
    ok: false,
    complete: false,
    resumable: true,
    error: "membership_refresh_checkpointed",
    schema: BOOKING_MEMBERSHIP_SNAPSHOT_SCHEMA,
    generation: checkpoint.generation,
    completedSequenceCount: completedById.size,
    selectedSequenceCount: scopeBefore.sequences.length,
    durationMs: Number(clock()) - startedAtMs,
  });

  while (completedById.size < orderedSequences.length) {
    if (Number(clock()) - startedAtMs >= membershipWorkBudgetMs) {
      return checkpointed();
    }

    const batch = orderedSequences
      .map((sequence, index) => ({ sequence, index }))
      .filter(({ sequence }) => !completedById.has(sequence.id))
      .slice(0, concurrency);
    const completedBatch = await Promise.all(batch.map(
      async ({ sequence, index }) => {
        const read = await membershipLoader(sequence.id);
        const fetchedAtMs = Number(clock());
        const leads = assertCompleteMembershipRead(read, fetchedAtMs);
        const fetchedAt = new Date(fetchedAtMs).toISOString();
        const shard = {
          schema: BOOKING_MEMBERSHIP_SHARD_SCHEMA,
          snapshotSchema: BOOKING_MEMBERSHIP_SNAPSHOT_SCHEMA,
          generation: checkpoint.generation,
          sequenceId: sequence.id,
          fetchedAt,
          count: leads.length,
          leads,
        };
        const shardToken = String(shardTokenFactory({
          generation: checkpoint.generation,
          sequenceId: sequence.id,
          index,
        }) || "");
        if (!/^[a-f0-9]{24,64}$/u.test(shardToken)) {
          throw fail("BOOKING_MEMBERSHIP_SHARD_TOKEN_INVALID");
        }
        // The token is retry-unique. If a process dies after SET NX but before
        // checkpoint persistence, the orphan remains immutable and harmless;
        // the retry writes a fresh key instead of conflicting with different
        // fetchedAt bytes at a deterministic generation+index key.
        const key = BOOKING_MEMBERSHIP_KEYS.shard(
          checkpoint.generation,
          shardToken,
        );
        const hash = bookingMembershipHash(shard);
        const descriptor = {
          schema: BOOKING_MEMBERSHIP_SHARD_SCHEMA,
          generation: checkpoint.generation,
          key,
          sequenceId: sequence.id,
          fetchedAt,
          count: leads.length,
          hash,
        };
        return { sequence, fetchedAtMs, descriptor, shard };
      },
    ));
    await Promise.all(completedBatch.map(({ descriptor, shard }) =>
      immutableWrite(
        store,
        descriptor.key,
        shard,
        IMMUTABLE_TTL_SECONDS,
      )));
    for (const { sequence, descriptor, shard } of completedBatch) {
      completedById.set(sequence.id, { descriptor, shard });
    }
    const oldestMs = timestamp(checkpoint.oldestFetchedAt);
    const batchOldestMs = Math.min(
      ...completedBatch.map(({ fetchedAtMs }) => fetchedAtMs),
    );
    const batchNewestMs = Math.max(
      ...completedBatch.map(({ fetchedAtMs }) => fetchedAtMs),
    );
    checkpoint = {
      ...checkpoint,
      updatedAt: new Date(batchNewestMs).toISOString(),
      oldestFetchedAt: new Date(
        oldestMs == null
          ? batchOldestMs
          : Math.min(oldestMs, batchOldestMs),
      ).toISOString(),
      shards: orderedSequences
        .map(({ id }) => completedById.get(id)?.descriptor)
        .filter(Boolean),
    };
    await durableWrite(
      store,
      BOOKING_MEMBERSHIP_KEYS.checkpoint,
      checkpoint,
      CHECKPOINT_TTL_SECONDS,
    );
    if (Number(clock()) - startedAtMs >= membershipWorkBudgetMs) {
      return checkpointed();
    }
  }
  if (Number(clock()) - startedAtMs >= membershipWorkBudgetMs) {
    return checkpointed();
  }

  const scopeAfter = assertBookingMembershipScope(await scopeLoader());
  if (!sameScope(scopeBefore, scopeAfter)) {
    throw fail("BOOKING_MEMBERSHIP_SCOPE_DRIFT");
  }

  const nowMs = Number(clock());
  const oldestFetchedAtMs = timestamp(checkpoint.oldestFetchedAt);
  if (
    !Number.isFinite(nowMs)
    || oldestFetchedAtMs == null
    || oldestFetchedAtMs > nowMs
    || nowMs - oldestFetchedAtMs > BOOKING_MEMBERSHIP_MAX_AGE_MS
  ) {
    throw fail("BOOKING_MEMBERSHIP_SNAPSHOT_STALE");
  }

  const shards = [];
  let leadCount = 0;
  let verifiedOldestFetchedAtMs = null;
  let verifiedNewestFetchedAtMs = null;
  for (const sequence of orderedSequences) {
    const completed = completedById.get(sequence.id);
    if (!completed) throw fail("BOOKING_MEMBERSHIP_COVERAGE_INCOMPLETE");
    const readback = await store.get(completed.descriptor.key);
    const descriptorFetchedAtMs =
      timestamp(completed.descriptor.fetchedAt);
    const shardFetchedAtMs = timestamp(readback?.fetchedAt);
    if (
      !exactValue(readback, completed.shard)
      || bookingMembershipHash(readback) !== completed.descriptor.hash
      || readback.count !== completed.descriptor.count
      || readback.leads.length !== completed.descriptor.count
      || readback.leads.some((lead) =>
        !validLeadProjection(lead, shardFetchedAtMs))
    ) {
      throw fail("BOOKING_MEMBERSHIP_READBACK_MISMATCH");
    }
    if (
      descriptorFetchedAtMs == null
      || shardFetchedAtMs == null
      || descriptorFetchedAtMs !== shardFetchedAtMs
      || completed.descriptor.fetchedAt !== readback.fetchedAt
      || shardFetchedAtMs > nowMs
    ) {
      throw fail("BOOKING_MEMBERSHIP_SNAPSHOT_TIME_INVALID");
    }
    verifiedOldestFetchedAtMs = verifiedOldestFetchedAtMs == null
      ? shardFetchedAtMs
      : Math.min(verifiedOldestFetchedAtMs, shardFetchedAtMs);
    verifiedNewestFetchedAtMs = verifiedNewestFetchedAtMs == null
      ? shardFetchedAtMs
      : Math.max(verifiedNewestFetchedAtMs, shardFetchedAtMs);
    leadCount += completed.descriptor.count;
    shards.push(completed.descriptor);
  }
  const checkpointUpdatedAtMs = timestamp(checkpoint.updatedAt);
  if (
    verifiedOldestFetchedAtMs == null
    || verifiedNewestFetchedAtMs == null
    || checkpointUpdatedAtMs == null
    || verifiedOldestFetchedAtMs > verifiedNewestFetchedAtMs
    || verifiedOldestFetchedAtMs !== oldestFetchedAtMs
    || verifiedNewestFetchedAtMs !== checkpointUpdatedAtMs
    || checkpointUpdatedAtMs > nowMs
  ) {
    throw fail("BOOKING_MEMBERSHIP_SNAPSHOT_TIME_INVALID");
  }

  // Deterministic from the completed shard set. If the process crashes after
  // writing the immutable manifest, a resume must reconstruct identical bytes
  // instead of conflicting with its own first attempt.
  const publishedAt = checkpoint.updatedAt;
  const manifest = {
    schema: BOOKING_MEMBERSHIP_SNAPSHOT_SCHEMA,
    generation: checkpoint.generation,
    complete: true,
    builtAt: publishedAt,
    oldestFetchedAt: checkpoint.oldestFetchedAt,
    scope: scopeBinding(scopeAfter),
    shardCount: shards.length,
    leadCount,
    shards,
  };
  const manifestKey =
    BOOKING_MEMBERSHIP_KEYS.manifest(checkpoint.generation);
  // Manifest is intentionally written only after every immutable shard passed
  // exact readback, hash and count verification.
  await immutableWrite(
    store,
    manifestKey,
    manifest,
    IMMUTABLE_TTL_SECONDS,
  );
  const manifestReadback = await store.get(manifestKey);
  const manifestHash = bookingMembershipHash(manifest);
  if (
    !exactValue(manifestReadback, manifest)
    || bookingMembershipHash(manifestReadback) !== manifestHash
  ) {
    throw fail("BOOKING_MEMBERSHIP_MANIFEST_READBACK_MISMATCH");
  }

  const perSequence = orderedSequences.map((sequence) => ({
    sequence,
    leads: completedById.get(sequence.id).shard.leads,
  }));
  const leadIndex = bookingMembershipLeadIndex({
    generation: checkpoint.generation,
    manifestHash,
    scope: scopeAfter,
    builtAt: publishedAt,
    perSequence,
    includePausedLead,
  });
  const leadIndexHash = bookingMembershipHash(leadIndex);
  const current = {
    schema: BOOKING_MEMBERSHIP_CURRENT_SCHEMA,
    snapshotSchema: BOOKING_MEMBERSHIP_SNAPSHOT_SCHEMA,
    generation: checkpoint.generation,
    complete: true,
    manifestKey,
    manifestHash,
    leadIndexHash,
    publishedAt,
    oldestFetchedAt: checkpoint.oldestFetchedAt,
    scope: scopeBinding(scopeAfter),
  };
  let published = null;
  if (
    priorCurrent?.schema === BOOKING_MEMBERSHIP_CURRENT_SCHEMA
    && priorCurrent.generation === checkpoint.generation
  ) {
    if (!exactValue(priorCurrent, current)) {
      throw fail("BOOKING_MEMBERSHIP_PUBLICATION_CONFLICT");
    }
    published = 1;
  } else {
    published = await store.atomicPublish({
      expectedCurrent: checkpoint.baseCurrent,
      current,
      leadIndex,
      ttlSeconds: CURRENT_TTL_SECONDS,
    });
  }
  if (published !== true && published !== 1 && published !== "1") {
    throw fail("BOOKING_MEMBERSHIP_PUBLICATION_CONFLICT");
  }
  const [currentReadback, leadIndexReadback] = await Promise.all([
    store.get(BOOKING_MEMBERSHIP_KEYS.current),
    store.get(BOOKING_MEMBERSHIP_KEYS.leadIndex),
  ]);
  if (
    !exactValue(currentReadback, current)
    || !exactValue(leadIndexReadback, leadIndex)
    || leadIndexReadback.generation !== currentReadback.generation
    || leadIndexReadback.manifestHash !== currentReadback.manifestHash
    || bookingMembershipHash(leadIndexReadback)
      !== currentReadback.leadIndexHash
  ) {
    throw fail("BOOKING_MEMBERSHIP_PUBLICATION_READBACK_MISMATCH");
  }

  await durableWrite(
    store,
    BOOKING_MEMBERSHIP_KEYS.checkpoint,
    {
      ...checkpoint,
      status: "published",
      updatedAt: publishedAt,
      manifestKey,
      manifestHash,
    },
    CHECKPOINT_TTL_SECONDS,
  );

  return {
    ok: true,
    complete: true,
    schema: manifest.schema,
    generation: manifest.generation,
    manifestHash,
    oldestFetchedAt: manifest.oldestFetchedAt,
    scopeSchema: manifest.scope.schema,
    scopeDigest: manifest.scope.digest,
    catalogSequenceCount: manifest.scope.catalogSequenceCount,
    selectedSequenceCount: manifest.scope.selectedSequenceCount,
    shardCount: manifest.shardCount,
    leadCount: manifest.leadCount,
    indexedEmails: Object.keys(leadIndex.byEmail).length,
    durationMs: Number(clock()) - startedAtMs,
  };
}

function snapshotUnavailable(detail) {
  return {
    ok: false,
    complete: false,
    error: "membership_snapshot_unavailable",
    detail,
  };
}

async function readShardBatch(descriptors, readMany) {
  if (
    !Array.isArray(descriptors)
    || descriptors.length > BOOKING_MEMBERSHIP_MAX_SHARDS
    || typeof readMany !== "function"
  ) {
    return {
      ok: false,
      detail: typeof readMany === "function"
        ? "shard_batch_invalid"
        : "shard_batch_reader_missing",
    };
  }
  const keys = descriptors.map(({ key }) => key);
  if (
    keys.some((key) => typeof key !== "string" || !key)
    || new Set(keys).size !== keys.length
  ) {
    return { ok: false, detail: "shard_batch_invalid" };
  }
  try {
    const values = await readMany(keys);
    if (!Array.isArray(values) || values.length !== keys.length) {
      return { ok: false, detail: "shard_batch_invalid" };
    }
    return { ok: true, values };
  } catch {
    return { ok: false, detail: "shard_batch_unavailable" };
  }
}

export async function loadPublishedBookingMembershipSnapshot({
  scope,
  read,
  readMany,
  now = Date.now(),
} = {}) {
  try {
    assertBookingMembershipScope(scope);
    if (typeof read !== "function") {
      return snapshotUnavailable("reader_missing");
    }
    const current = await read(BOOKING_MEMBERSHIP_KEYS.current);
    if (
      current?.schema !== BOOKING_MEMBERSHIP_CURRENT_SCHEMA
      || current.snapshotSchema !== BOOKING_MEMBERSHIP_SNAPSHOT_SCHEMA
      || current.complete !== true
      || !validGeneration(current.generation)
      || current.manifestKey
        !== BOOKING_MEMBERSHIP_KEYS.manifest(current.generation)
      || !DIGEST.test(String(current.manifestHash || ""))
      || !DIGEST.test(String(current.leadIndexHash || ""))
      || !exactValue(current.scope, scopeBinding(scope))
    ) {
      return snapshotUnavailable("current_invalid_or_scope_mismatch");
    }
    const manifest = await read(current.manifestKey);
    if (
      manifest?.schema !== BOOKING_MEMBERSHIP_SNAPSHOT_SCHEMA
      || manifest.generation !== current.generation
      || manifest.complete !== true
      || bookingMembershipHash(manifest) !== current.manifestHash
      || !exactValue(manifest.scope, current.scope)
      || manifest.oldestFetchedAt !== current.oldestFetchedAt
      || manifest.builtAt !== current.publishedAt
      || !Array.isArray(manifest.shards)
      || manifest.shards.length > BOOKING_MEMBERSHIP_MAX_SHARDS
      || manifest.shardCount !== manifest.shards.length
      || manifest.shardCount !== manifest.scope.selectedSequenceCount
      || !Number.isInteger(manifest.leadCount)
      || manifest.leadCount < 0
    ) {
      return snapshotUnavailable("manifest_invalid");
    }

    const nowMs = Number(now);
    const builtAtMs = timestamp(manifest.builtAt);
    const oldestFetchedAtMs = timestamp(manifest.oldestFetchedAt);
    const publishedAtMs = timestamp(current.publishedAt);
    if (
      !Number.isFinite(nowMs)
      || builtAtMs == null
      || oldestFetchedAtMs == null
      || publishedAtMs == null
      || builtAtMs > nowMs
      || publishedAtMs > nowMs
      || oldestFetchedAtMs > nowMs
      || nowMs - oldestFetchedAtMs > BOOKING_MEMBERSHIP_MAX_AGE_MS
    ) {
      return snapshotUnavailable("snapshot_stale_or_future");
    }

    const expectedIds = manifest.scope.selectedSequenceIds;
    if (
      !Array.isArray(expectedIds)
      || expectedIds.length !== manifest.scope.selectedSequenceCount
      || new Set(expectedIds).size !== expectedIds.length
      || !exactValue(expectedIds, selectedSequenceIds(scope).sort())
    ) {
      return snapshotUnavailable("selected_sequence_coverage_invalid");
    }

    const sequenceById = new Map(
      scope.sequences.map((sequence) => [sequence.id, sequence]),
    );
    const seen = new Set();
    const perSequence = [];
    let leadCount = 0;
    let oldestShardMs = null;
    let newestShardMs = null;
    for (const descriptor of manifest.shards) {
      if (
        !descriptorShape(descriptor, current.generation)
        || !sequenceById.has(descriptor.sequenceId)
        || seen.has(descriptor.sequenceId)
      ) {
        return snapshotUnavailable("shard_descriptor_invalid");
      }
      seen.add(descriptor.sequenceId);
    }
    const batch = await readShardBatch(manifest.shards, readMany);
    if (!batch.ok) return snapshotUnavailable(batch.detail);
    for (let index = 0; index < manifest.shards.length; index += 1) {
      const descriptor = manifest.shards[index];
      const shard = batch.values[index];
      const shardFetchedAtMs = timestamp(shard?.fetchedAt);
      if (
        shard?.schema !== BOOKING_MEMBERSHIP_SHARD_SCHEMA
        || shard.snapshotSchema !== BOOKING_MEMBERSHIP_SNAPSHOT_SCHEMA
        || shard.generation !== current.generation
        || shard.sequenceId !== descriptor.sequenceId
        || shard.fetchedAt !== descriptor.fetchedAt
        || shardFetchedAtMs == null
        || shardFetchedAtMs > nowMs
        || !Array.isArray(shard.leads)
        || shard.count !== descriptor.count
        || shard.leads.length !== descriptor.count
        || bookingMembershipHash(shard) !== descriptor.hash
        || new Set(shard.leads.map((lead) => lead?.ccu_id)).size
          !== shard.leads.length
        || shard.leads.some((lead) =>
          !validLeadProjection(lead, shardFetchedAtMs))
      ) {
        return snapshotUnavailable("shard_missing_or_invalid");
      }
      leadCount += descriptor.count;
      oldestShardMs = oldestShardMs == null
        ? shardFetchedAtMs
        : Math.min(oldestShardMs, shardFetchedAtMs);
      newestShardMs = newestShardMs == null
        ? shardFetchedAtMs
        : Math.max(newestShardMs, shardFetchedAtMs);
      perSequence.push({
        seq: sequenceById.get(descriptor.sequenceId),
        leads: shard.leads,
      });
    }
    if (
      seen.size !== expectedIds.length
      || expectedIds.some((id) => !seen.has(id))
      || leadCount !== manifest.leadCount
      || oldestShardMs !== oldestFetchedAtMs
      || newestShardMs !== builtAtMs
    ) {
      return snapshotUnavailable("snapshot_count_or_coverage_mismatch");
    }
    return {
      ok: true,
      complete: true,
      schema: manifest.schema,
      generation: manifest.generation,
      manifestHash: current.manifestHash,
      oldestFetchedAt: manifest.oldestFetchedAt,
      ageMs: nowMs - oldestFetchedAtMs,
      current,
      manifest,
      perSequence,
    };
  } catch (error) {
    return snapshotUnavailable(
      String(error?.code || error?.message || "snapshot_invalid").slice(0, 120),
    );
  }
}

export async function bookingMembershipSnapshotHealth({
  read,
  readMany,
  now = Date.now(),
} = {}) {
  const empty = {
    schema: null,
    generation: null,
    manifestHash: null,
    leadIndexHash: null,
    current: false,
    complete: false,
    oldestFetchedAt: null,
    ageMs: null,
    scopeSchema: null,
    scopeDigest: null,
    catalogSequenceCount: null,
    selectedSequenceCount: null,
    latestAttemptAt: null,
    latestAttemptStatus: null,
    latestAttemptError: null,
  };
  if (typeof read !== "function") return empty;
  const [current, attempt] = await Promise.all([
    read(BOOKING_MEMBERSHIP_KEYS.current),
    read(BOOKING_MEMBERSHIP_KEYS.attempt),
  ]);
  const attemptAtMs = timestamp(attempt?.at);
  const attemptFields = {
    latestAttemptAt:
      attempt?.schema === BOOKING_MEMBERSHIP_ATTEMPT_SCHEMA
      && attemptAtMs != null
        ? new Date(attemptAtMs).toISOString()
        : null,
    latestAttemptStatus:
      attempt?.schema === BOOKING_MEMBERSHIP_ATTEMPT_SCHEMA
        ? attempt.status
        : null,
    latestAttemptError:
      attempt?.schema === BOOKING_MEMBERSHIP_ATTEMPT_SCHEMA
        ? attempt.error
        : null,
  };
  if (
    current?.schema !== BOOKING_MEMBERSHIP_CURRENT_SCHEMA
    || current.snapshotSchema !== BOOKING_MEMBERSHIP_SNAPSHOT_SCHEMA
    || current.complete !== true
    || !validGeneration(current.generation)
    || !DIGEST.test(String(current.manifestHash || ""))
    || !DIGEST.test(String(current.leadIndexHash || ""))
    || current.manifestKey
      !== BOOKING_MEMBERSHIP_KEYS.manifest(current.generation)
  ) {
    return { ...empty, ...attemptFields };
  }
  const manifest = await read(current.manifestKey);
  const oldestFetchedAtMs = timestamp(manifest?.oldestFetchedAt);
  const builtAtMs = timestamp(manifest?.builtAt);
  const publishedAtMs = timestamp(current?.publishedAt);
  const nowMs = Number(now);
  const ageMs = oldestFetchedAtMs == null
    ? null
    : nowMs - oldestFetchedAtMs;
  const expectedIds = manifest?.scope?.selectedSequenceIds;
  let complete = Boolean(
    manifest?.schema === BOOKING_MEMBERSHIP_SNAPSHOT_SCHEMA
    && manifest.generation === current.generation
    && manifest.complete === true
    && bookingMembershipHash(manifest) === current.manifestHash
    && exactValue(manifest.scope, current.scope)
    && manifest.oldestFetchedAt === current.oldestFetchedAt
    && manifest.builtAt === current.publishedAt
    && manifest.scope?.schema === BOOKING_STOP_SCOPE_SCHEMA
    && DIGEST.test(String(manifest.scope?.digest || ""))
    && Number.isInteger(manifest.scope?.catalogFloor)
    && manifest.scope.catalogFloor >= 1
    && Number.isInteger(manifest.scope?.catalogSequenceCount)
    && manifest.scope.catalogSequenceCount >= manifest.scope.catalogFloor
    && Array.isArray(expectedIds)
    && expectedIds.length === manifest.scope?.selectedSequenceCount
    && new Set(expectedIds).size === expectedIds.length
    && exactValue(expectedIds, [...expectedIds].sort())
    && Array.isArray(manifest.shards)
    && manifest.shards.length <= BOOKING_MEMBERSHIP_MAX_SHARDS
    && manifest.shardCount === manifest.shards.length
    && manifest.shardCount === manifest.scope?.selectedSequenceCount
    && Number.isInteger(manifest.leadCount)
    && manifest.leadCount >= 0
  );
  let verifiedLeadCount = 0;
  let oldestShardMs = null;
  let newestShardMs = null;
  const seenSequenceIds = new Set();
  if (complete) {
    for (const descriptor of manifest.shards) {
      if (
        !descriptorShape(descriptor, current.generation)
        || !expectedIds.includes(descriptor.sequenceId)
        || seenSequenceIds.has(descriptor.sequenceId)
      ) {
        complete = false;
        break;
      }
      seenSequenceIds.add(descriptor.sequenceId);
    }
  }
  let shardBatch = null;
  if (complete) {
    shardBatch = await readShardBatch(manifest.shards, readMany);
    complete = shardBatch.ok;
  }
  if (complete) {
    for (let index = 0; index < manifest.shards.length; index += 1) {
      const descriptor = manifest.shards[index];
      const shard = shardBatch.values[index];
      const shardFetchedAtMs = timestamp(shard?.fetchedAt);
      if (
        shard?.schema !== BOOKING_MEMBERSHIP_SHARD_SCHEMA
        || shard.snapshotSchema !== BOOKING_MEMBERSHIP_SNAPSHOT_SCHEMA
        || shard.generation !== current.generation
        || shard.sequenceId !== descriptor.sequenceId
        || shard.fetchedAt !== descriptor.fetchedAt
        || shardFetchedAtMs == null
        || !Number.isFinite(nowMs)
        || shardFetchedAtMs > nowMs
        || !Array.isArray(shard.leads)
        || shard.count !== descriptor.count
        || shard.leads.length !== descriptor.count
        || bookingMembershipHash(shard) !== descriptor.hash
        || new Set(shard.leads.map((lead) => lead?.ccu_id)).size
          !== shard.leads.length
        || shard.leads.some((lead) =>
          !validLeadProjection(lead, shardFetchedAtMs))
      ) {
        complete = false;
        break;
      }
      verifiedLeadCount += descriptor.count;
      oldestShardMs = oldestShardMs == null
        ? shardFetchedAtMs
        : Math.min(oldestShardMs, shardFetchedAtMs);
      newestShardMs = newestShardMs == null
        ? shardFetchedAtMs
        : Math.max(newestShardMs, shardFetchedAtMs);
    }
  }
  complete = Boolean(
    complete
    && seenSequenceIds.size === expectedIds.length
    && expectedIds.every((id) => seenSequenceIds.has(id))
    && verifiedLeadCount === manifest.leadCount
    && oldestShardMs === oldestFetchedAtMs
    && newestShardMs === builtAtMs
  );
  const currentAndFresh = Boolean(
    complete
    && ageMs != null
    && ageMs >= 0
    && ageMs <= BOOKING_MEMBERSHIP_MAX_AGE_MS
    && builtAtMs != null
    && builtAtMs <= nowMs
    && publishedAtMs != null
    && publishedAtMs <= nowMs
  );
  return {
    schema: manifest?.schema || current.snapshotSchema,
    generation: current.generation,
    manifestHash: current.manifestHash,
    leadIndexHash: current.leadIndexHash,
    current: currentAndFresh,
    complete,
    oldestFetchedAt:
      oldestFetchedAtMs == null
        ? null
        : new Date(oldestFetchedAtMs).toISOString(),
    ageMs,
    scopeSchema: manifest?.scope?.schema || null,
    scopeDigest: manifest?.scope?.digest || null,
    catalogSequenceCount:
      Number.isInteger(manifest?.scope?.catalogSequenceCount)
        ? manifest.scope.catalogSequenceCount
        : null,
    selectedSequenceCount:
      Number.isInteger(manifest?.scope?.selectedSequenceCount)
        ? manifest.scope.selectedSequenceCount
        : null,
    ...attemptFields,
  };
}

export function bookingMembershipAttempt({
  status,
  result = null,
  error = null,
  now = Date.now(),
}) {
  if (!["running", "failure", "success"].includes(status)) {
    throw fail("BOOKING_MEMBERSHIP_ATTEMPT_INVALID");
  }
  return {
    schema: BOOKING_MEMBERSHIP_ATTEMPT_SCHEMA,
    at: new Date(now).toISOString(),
    status,
    error: status === "failure"
      ? String(error || result?.error || "unknown").slice(0, 120)
      : null,
    generation: validGeneration(result?.generation)
      ? result.generation
      : null,
  };
}
