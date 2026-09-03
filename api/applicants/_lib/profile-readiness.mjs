const rows = (value) => Array.isArray(value) ? value : [];

export const PROFILE_HISTORY_STATES = new Set(["data", "verified_empty"]);

const text = (value) => {
  const result = String(value ?? "").trim();
  return result || null;
};

export function profileHistoryState(receipt) {
  const state = text(receipt?.historyState ?? receipt?.profileHistoryState ?? receipt?.history_state)?.toLowerCase();
  return PROFILE_HISTORY_STATES.has(state) ? state : null;
}

export function sourceObservationIdFor(value) {
  return text(value?.sourceObservationId
    ?? value?.source_observation_id
    ?? value?.sourceObservation?.id);
}

/**
 * Core removes rows whose source observation is not durably readable before
 * publishing a generation.  Keep the count on the immutable snapshot so the
 * tab can explain the preparing population without putting those rows into a
 * dynamically filtered feed.
 */
export function profilePreparingCount(snapshot) {
  const value = snapshot?.profilePreparing;
  if (Array.isArray(value)) return value.length;
  if (Number.isFinite(Number(value))) return Math.max(0, Math.floor(Number(value)));
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (Number.isFinite(Number(value.count))) return Math.max(0, Math.floor(Number(value.count)));
    if (Number.isFinite(Number(value.total))) return Math.max(0, Math.floor(Number(value.total)));
  }
  return 0;
}

/**
 * A Hub receipt is durable, but only for the exact source observation that
 * the current queue row names.  Rich-provider receipts retain their existing
 * TTL behavior; they are optional enrichment, not source authority.
 */
export function profileReceiptReady(receipt, now = Date.now(), expectedSourceObservationId = null) {
  const historyState = profileHistoryState(receipt);
  if (historyState) {
    const receiptObservationId = sourceObservationIdFor(receipt);
    return receipt?.source === "applicant_hub"
      && receipt?.durable === true
      && Boolean(expectedSourceObservationId)
      && Boolean(receiptObservationId)
      && receiptObservationId === expectedSourceObservationId;
  }
  const expiresAt = Date.parse(receipt?.expiresAt || "");
  return Number.isFinite(expiresAt) && expiresAt > Number(now);
}

/**
 * Every row in an active generation must carry an exact durable Hub receipt.
 * This is intentionally separate from profileCacheGate: filtering a broken
 * generation into a smaller, apparently healthy feed would change the work
 * the reviewer sees. Readers fail closed instead.
 */
export function activeSourceProfileReceiptMismatches(snapshot, receipts, { now = Date.now() } = {}) {
  const available = receipts && typeof receipts === "object" && !Array.isArray(receipts) ? receipts : {};
  const active = [...rows(snapshot?.stream), ...rows(snapshot?.queue)];
  const mismatches = [];
  for (const row of active) {
    const key = row?.profileKey || row?.cuId || null;
    const expectedSourceObservationId = sourceObservationIdFor(row);
    if (!key || !expectedSourceObservationId
      || !profileReceiptReady(available[key], now, expectedSourceObservationId)) {
      mismatches.push({ key: key || null });
    }
  }
  return mismatches;
}

/**
 * Summary for a generation that has already passed the strict receipt fence.
 * It does not filter or recount active rows; `profilePreparing` is Core's
 * immutable partition count and is the only withheld population reported.
 */
export function profileCacheSummary(snapshot) {
  const rawStream = rows(snapshot?.stream);
  const rawQueue = rows(snapshot?.queue);
  const all = [...rawQueue, ...rawStream];
  const profileKey = (row) => row?.profileKey || row?.cuId || null;
  const candidateIds = new Set(all.map(profileKey).filter(Boolean));
  const preparing = profilePreparingCount(snapshot);
  const activeRows = all.length;
  const activeCandidates = candidateIds.size;
  const generatedDay = String(snapshot?.generatedAt || "").slice(0, 10);
  const stream = rawStream;
  const queue = rawQueue;
  return {
    required: true,
    totalRows: activeRows + preparing,
    readyRows: activeRows,
    withheldRows: preparing,
    totalCandidates: activeCandidates + preparing,
    unidentifiedRows: all.filter((row) => !profileKey(row)).length,
    readyCandidates: activeCandidates,
    withheldCandidates: preparing,
    profilePreparing: preparing,
    // These are intentionally empty: no reader is allowed to turn an active
    // generation into a different queue by warming or suppressing rows.
    missingProfileKeys: [],
    missingCuIds: [],
    upgradeCuIds: [],
    warmCuIds: [],
    queue: {
      total: rawQueue.length,
      ready: rawQueue.length,
      withheld: 0,
      unidentified: rawQueue.filter((row) => !profileKey(row)).length,
    },
    stream: {
      total: rawStream.length,
      ready: rawStream.length,
      withheld: 0,
      unidentified: rawStream.filter((row) => !profileKey(row)).length,
    },
    counts: {
      stream: stream.length,
      queue: queue.length,
      unrated: queue.filter((row) => row?.tier === "unrated").length,
      emailedToday: stream.filter((row) =>
        row?.status === "emailed" && String(row?.addedAt || "").slice(0, 10) === generatedDay).length,
      newToday: stream.filter((row) => String(row?.addedAt || "").slice(0, 10) === generatedDay).length,
    },
  };
}

export function profileCacheGate(snapshot, cards, receipts, { now = Date.now() } = {}) {
  const available = cards && typeof cards === "object" && !Array.isArray(cards) ? cards : {};
  const current = receipts && typeof receipts === "object" && !Array.isArray(receipts) ? receipts : {};
  const rawStream = rows(snapshot?.stream);
  const rawQueue = rows(snapshot?.queue);
  // A card proves the list projection exists. A Hub receipt may be durable;
  // a rich-provider receipt still proves the full profile has not reached its
  // 24-hour TTL.
  const profileKey = (row) => row?.profileKey || row?.cuId || null;
  const cardHasHistory = (card) => Boolean(card && (
    PROFILE_HISTORY_STATES.has(text(card.historyState))
    || (
    (!("expCount" in card) && !("eduCount" in card))
    || Number(card.expCount) > 0
    || Number(card.eduCount) > 0
    )
  ));
  const cacheReady = (key, row) => {
    if (!key || !available[key]) return false;
    const expectedObservationId = sourceObservationIdFor(row);
    const receipt = current[key];
    // A source-backed receipt may be expired or omit an expiry entirely. Its
    // observation binding is the freshness check. Rich-provider receipts keep
    // the old card-plus-TTL requirement.
    if (profileReceiptReady(receipt, now, expectedObservationId)) return true;
    return cardHasHistory(available[key]) && profileReceiptReady(receipt, now);
  };
  const ready = (row) => {
    const key = profileKey(row);
    return cacheReady(key, row);
  };
  const stream = rawStream.filter(ready);
  const queue = rawQueue.filter(ready);
  // Missing ids are returned in this order to the cache warmer: review work
  // first, then the stream, while preserving each publisher's newest-first order.
  const all = [...rawQueue, ...rawStream];
  const candidateIds = new Set(all.map(profileKey).filter(Boolean));
  const readyCandidateIds = new Set(all.filter(ready).map(profileKey));
  const missingProfileKeys = [...candidateIds].filter((key) =>
    !all.some((row) => profileKey(row) === key && cacheReady(key, row)));
  const missingCuIds = [...new Set(all.map((row) => row?.cuId).filter(Boolean))]
    .filter((cuId) => !all.some((row) => row?.cuId === cuId && cacheReady(cuId, row)));
  // Hub source history is durable and must not be sent through the rich
  // provider warmer merely because its optional cache TTL elapsed.
  const upgradeCuIds = [];
  const warmCuIds = [...new Set([...missingCuIds, ...upgradeCuIds])];
  const generatedDay = String(snapshot?.generatedAt || "").slice(0, 10);
  const next = snapshot ? {
    ...snapshot,
    counts: {
      ...(snapshot.counts || {}),
      stream: stream.length,
      queue: queue.length,
      unrated: queue.filter((row) => row?.tier === "unrated").length,
      emailedToday: stream.filter((row) =>
        row?.status === "emailed" && String(row?.addedAt || "").slice(0, 10) === generatedDay).length,
      newToday: stream.filter((row) =>
        String(row?.addedAt || "").slice(0, 10) === generatedDay).length,
    },
    stream,
    queue,
  } : null;
  return {
    snapshot: next,
    profileCache: {
      required: true,
      totalRows: all.length,
      readyRows: stream.length + queue.length,
      withheldRows: all.length - stream.length - queue.length,
      totalCandidates: candidateIds.size,
      unidentifiedRows: all.filter((row) => !profileKey(row)).length,
      readyCandidates: readyCandidateIds.size,
      withheldCandidates: missingProfileKeys.length,
      missingProfileKeys,
      missingCuIds,
      upgradeCuIds,
      warmCuIds,
      queue: {
        total: rawQueue.length,
        ready: queue.length,
        withheld: rawQueue.length - queue.length,
        unidentified: rawQueue.filter((row) => !profileKey(row)).length,
      },
      stream: {
        total: rawStream.length,
        ready: stream.length,
        withheld: rawStream.length - stream.length,
        unidentified: rawStream.filter((row) => !profileKey(row)).length,
      },
    },
  };
}
