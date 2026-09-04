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
 * This is the PUBLISH-TIME fence: sync refuses to activate a generation whose
 * rows are not all backed, so a bad generation never becomes the active one.
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

/**
 * READ-TIME partition. The publish-time fence above is what keeps a bad
 * generation off the tab; by the time the browser reads, the generation has
 * already been proved. A receipt can still go missing afterwards (a Hub
 * re-observation replaces the observation id under a live generation), and
 * until 2026-09-04 one such row made the whole feed answer 503 — which the tab
 * treats as "discard everything", so a single stale row blanked a 4,345-row
 * queue and wiped the reviewer's local state with it.
 *
 * Losing one row is not a reason to lose the other four thousand. A row whose
 * receipt no longer matches moves into the SAME profile-preparing partition
 * Core already publishes, and is counted there. It is not rendered, so it
 * cannot be actioned; it is counted, so it is never silently gone.
 */
export function partitionByProfileReceipt(snapshot, receipts, { now = Date.now() } = {}) {
  if (!snapshot) return { snapshot: null, withheld: 0, preparing: 0, withheldKeys: [] };
  const available = receipts && typeof receipts === "object" && !Array.isArray(receipts) ? receipts : {};
  const ready = (row) => {
    const key = row?.profileKey || row?.cuId || null;
    const expected = sourceObservationIdFor(row);
    return Boolean(key) && Boolean(expected) && profileReceiptReady(available[key], now, expected);
  };
  const rawStream = rows(snapshot.stream);
  const rawQueue = rows(snapshot.queue);
  const stream = rawStream.filter(ready);
  const queue = rawQueue.filter(ready);
  const withheldRows = [...rawStream, ...rawQueue].filter((row) => !ready(row));
  const withheld = withheldRows.length;
  const corePreparing = profilePreparingCount(snapshot);
  const next = {
    ...snapshot,
    ...(Array.isArray(snapshot.stream) ? { stream } : {}),
    ...(Array.isArray(snapshot.queue) ? { queue } : {}),
    // One number for the tab: Core's own immutable preparing partition plus
    // whatever this read had to withhold.
    profilePreparing: corePreparing + withheld,
    profileReceiptWithheld: withheld,
  };
  return {
    snapshot: next,
    withheld,
    preparing: corePreparing + withheld,
    withheldKeys: withheldRows.map((row) => row?.profileKey || row?.cuId || null),
  };
}
