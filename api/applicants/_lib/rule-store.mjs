// The rules document, and the reads the engine and the editor share.
//
// One JSON doc holds every rule (apphub:rules). Sole writer: the rules
// endpoint. The tick never edits it — it writes counters to apphub:rulestats
// instead — so an armed rule firing can never race a human renaming it.
//
// Concurrent edits are handled by a revision counter rather than a lock: the
// browser sends the `rev` it read, and a save against a stale rev is refused
// with 409 so the second editor re-reads instead of silently clobbering the
// first. A lock would be heavier and would need a timeout story for a page
// that a person can simply close mid-edit.

import { getJson, hashGetAllJson, hashGetMany, K, setJson } from "./kv.mjs";

/** Rules a team will actually maintain, with headroom. Bounded because the
 *  whole set rides in one KV value alongside each rule's version history. */
export const MAX_RULES = 60;
/** Revisions kept per rule for the rollback control. */
export const MAX_VERSIONS = 10;

export const emptyDoc = () => ({ rev: 0, pausedAll: false, rules: [], updatedAt: null });

export async function readRules({ readJson = getJson } = {}) {
  const doc = await readJson(K.rules);
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.rules)) return emptyDoc();
  return {
    rev: Number(doc.rev) || 0,
    pausedAll: Boolean(doc.pausedAll),
    rules: doc.rules,
    updatedAt: doc.updatedAt ?? null,
  };
}

export async function writeRules(doc, { writeJson = setJson } = {}) {
  const next = { ...doc, rev: (Number(doc.rev) || 0) + 1, updatedAt: new Date().toISOString() };
  await writeJson(K.rules, next);
  return next;
}

/** Only rules that could act this tick. */
export const armedRules = (doc) => doc.rules.filter((rule) => rule.state === "live");
/** Rules being previewed against live data without acting. */
export const watchingRules = (doc) => doc.rules.filter((rule) => rule.state === "watching");

/**
 * The applicants a rule may consider: queue rows in the C-tier and unrated
 * review queue that no human and no earlier rule has decided.
 *
 * THREE EXCLUSIONS, all load-bearing:
 *   1. Anything already in `decisions` — a rule never overrules a human, and
 *      never re-decides its own earlier work (D3).
 *   2. Anything outside the published queue — the S/A/B stream is not in it,
 *      which is how "rules never touch S/A/B" is enforced structurally rather
 *      than by a check somebody could forget (D1).
 *   3. Rows with no key, which cannot carry a decision back anyway.
 */
export function pendingRows(snapshotQueue, decisions) {
  const rows = Array.isArray(snapshotQueue) ? snapshotQueue : [];
  return rows.filter((row) => row?.key && (row?.profileKey || row?.cuId) && !decisions?.[row.key]);
}

/** Facts for a set of applicants, in batches HMGET can carry comfortably. */
export async function factsFor(cuIds, { readMany = hashGetMany, batch = 200 } = {}) {
  const unique = [...new Set(cuIds.filter(Boolean))];
  const out = {};
  for (let i = 0; i < unique.length; i += batch) {
    Object.assign(out, await readMany(K.facts, unique.slice(i, i + batch)));
  }
  return out;
}

/** Compact-cache readiness for a set of applicants, with the same bounded
 * HMGET batches as rule facts so a large backfill cannot create one giant
 * Upstash command when the button is pressed. */
export async function cardsFor(cuIds, { readMany = hashGetMany, batch = 200 } = {}) {
  const unique = [...new Set(cuIds.filter(Boolean))];
  const out = {};
  for (let i = 0; i < unique.length; i += batch) {
    Object.assign(out, await readMany(K.cards, unique.slice(i, i + batch)));
  }
  return out;
}

/** Full-profile cache receipts use the same bounded hash batching as cards. */
export async function profileReceiptsFor(cuIds, { readMany = hashGetMany, batch = 200 } = {}) {
  const unique = [...new Set((Array.isArray(cuIds) ? cuIds : []).filter(Boolean))];
  const out = {};
  for (let i = 0; i < unique.length; i += batch) {
    Object.assign(out, await readMany(K.profileReady, unique.slice(i, i + batch)));
  }
  return out;
}

export async function readDirectories({ readHash = hashGetAllJson } = {}) {
  const [schools, companies] = await Promise.all([
    readHash(K.schools).catch(() => ({})),
    readHash(K.companies).catch(() => ({})),
  ]);
  return { schools, companies };
}
