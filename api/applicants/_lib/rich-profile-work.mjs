import { richBindingsForSnapshot, richProfileReadyMatches } from './rich-profile.mjs';
import { profileHistoryState, profilePreparingCount, profileReceiptReady } from './profile-readiness.mjs';

// A read-only work plan from the already published generation. This does not
// discover identities or make a future Core source observation authoritative.
export function richProfileWork(snapshot, sourceReceipts, cards, richReceipts, { now = Date.now() } = {}) {
  const all = [...(snapshot?.queue || []), ...(snapshot?.stream || [])];
  const groups = new Map();
  for (const row of all) {
    const key = row?.profileKey || row?.cuId;
    if (!key) throw new Error('rich_profile_work_invalid_row');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const bound = richBindingsForSnapshot(snapshot);
  const counts = {
    total: groups.size, profilePreparing: profilePreparingCount(snapshot),
    totalIncludingPreparing: groups.size + profilePreparingCount(snapshot),
    bound: 0, unbound: 0, sourceUnavailable: 0,
    available: 0, missing: 0, bindingMismatch: 0, expired: 0,
    withHistory: 0, sparse: 0, withLogos: 0, withRatings: 0,
  };
  const bindings = [];
  const repairProfileKeys = [];
  for (const [profileKey, rows] of groups) {
    const receipt = sourceReceipts?.[profileKey];
    if (receipt?.source !== 'applicant_hub' || receipt.durable !== true || !profileHistoryState(receipt) || rows.some(row =>
      !profileReceiptReady(receipt, now, row.sourceObservationId))) {
      counts.sourceUnavailable++;
      continue;
    }
    const binding = bound.get(profileKey);
    if (!binding) { counts.unbound++; continue; }
    counts.bound++;
    bindings.push({ profileKey, ...binding });
    const card = cards?.[profileKey];
    const richReceipt = richReceipts?.[profileKey];
    if (!card || !richReceipt) { counts.missing++; repairProfileKeys.push(profileKey); continue; }
    if (card.profileSource !== 'paraform' || richReceipt.source !== 'paraform' ||
      ['sourceObservationId', 'candidateUserId', 'connectionReceiptId'].some(field => card[field] !== binding[field] || richReceipt[field] !== binding[field]) ||
      card.profileEnrichedAt !== richReceipt.profileEnrichedAt || card.richProfileRetainedUntil !== richReceipt.richProfileRetainedUntil) {
      counts.bindingMismatch++;
      repairProfileKeys.push(profileKey);
      continue;
    }
    if (!richProfileReadyMatches(binding, card, richReceipt, { now })) {
      counts.expired++;
      repairProfileKeys.push(profileKey);
      continue;
    }
    counts.available++;
    const jobs = Array.isArray(card.exp) ? card.exp : [];
    const schools = Array.isArray(card.edu) ? card.edu : [];
    if (jobs.length || schools.length) counts.withHistory++;
    else counts.sparse++;
    if ([...jobs, ...schools].some(row => row.logo)) counts.withLogos++;
    if (card.paraformTier || Number.isFinite(card.densityScore) ||
      [...jobs, ...schools].some(row => row.talentRank)) counts.withRatings++;
  }
  return {
    counts,
    bindings: bindings.sort((a, b) => a.profileKey.localeCompare(b.profileKey)),
    repairProfileKeys: repairProfileKeys.sort((a, b) => a.localeCompare(b)),
  };
}
