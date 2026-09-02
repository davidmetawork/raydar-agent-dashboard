// The engine. It runs only when an authenticated person presses "Run rules
// now" in the Applicants Rules view, reads the whole pending review queue, and
// writes the decisions its live rules match.
//
// WHAT IT WRITES. Exactly the record a human click writes, into the same
// apphub:decisions hash, through the same module (_lib/decision-record.mjs).
// That is the entire integration: the desktop invite loop pulls un-acked
// `interview` decisions on its next cycle without knowing or caring that a
// rule produced this one, applies every send-time gate it always applies, and
// acks the outcome back. There is no second pipeline to keep in step.
//
// WHAT IT WILL NOT DO.
//   - Touch the S/A/B stream. It reads only apphub:queue, which is by
//     construction the C-tier and unrated review queue (D1).
//   - Overwrite any existing decision, human or machine (D3). Re-running a
//     tick is therefore free, which is what lets both triggers coexist.
//   - Act on a fact it does not have. Skips are counted, never guessed.
//   - Act at all while the snapshot's own count tripwire is latched — see
//     UPSTREAM SAFETY below.
//
// THERE IS NO VOLUME CAP. David's explicit decision (2026-08-20): an interview
// costs about 80 cents, and a rule that legitimately matches 1,500 people was
// previewed at 1,500 before it was armed. The only thing that stops a tick is
// broken upstream data.
//
// UPSTREAM SAFETY. Sync keeps a latched tripwire (apphub:counts) that fires
// when a publish collapses — on 2026-08-10 a credential-less index rebuild
// took the review queue from 2,244 rows to 22 overnight and the tab rendered
// it confidently. A collapsed queue is not a reason to act on the survivors,
// and an inflated one is not a reason to act on strangers, so a latched alert
// parks the tick until a healthy publish clears it. This is a data-integrity
// guard, not a throttle: it never limits a rule that is merely busy.

import { cors, requireAuth } from "./_lib/core.mjs";
import { decisionRecord, ruleActor } from "./_lib/decision-record.mjs";
import {
  getJson,
  hashDelMany,
  hashGetAllJson,
  hashGetMany,
  hashSetJson,
  K,
  kvConfigured,
} from "./_lib/kv.mjs";
import { evaluateRule, inScope } from "./_lib/rules.mjs";
import { profileReceiptReady } from "./_lib/profile-readiness.mjs";
import { armedRules, cardsFor, factsFor, pendingRows, profileReceiptsFor, readRules, watchingRules } from "./_lib/rule-store.mjs";

export const config = { maxDuration: 120 };

/** Audit rows kept. Enough for "the last 10 it hit" on every rule plus room
 *  to answer "why did this person get an email" weeks later. */
const MAX_AUDIT_ROWS = 4_000;

/**
 * Decide one applicant against the armed rules.
 *
 * PASS BEATS INTERVIEW (D10). Deny-beats-allow is what a team expects from a
 * rule list: an exclusion someone wrote deliberately should not be quietly
 * cancelled by a broader inclusion. Both matches are recorded either way, so
 * the audit shows the rule that lost as well as the one that won.
 */
export function decideRow(rules, subject, { now = Date.now() } = {}) {
  const matches = [];
  const skips = [];
  for (const rule of rules) {
    if (!inScope(rule, subject.row)) continue;
    const result = evaluateRule(rule, subject, { now });
    if (result.matched) matches.push({ rule, evidence: result.evidence });
    else if (result.skipped) skips.push(result.reason);
  }
  if (!matches.length) return { action: null, matches, skips };
  const winner = matches.find(({ rule }) => rule.action === "pass") ?? matches[0];
  return { action: winner.rule.action, winner, matches, skips };
}

export function createTickHandler({
  corsHandler = cors,
  authHandler = requireAuth,
  kvReady = kvConfigured,
  readJson = getJson,
  readHash = hashGetAllJson,
  readMany = hashGetMany,
  writeHash = hashSetJson,
  now = () => Date.now(),
} = {}) {
  return async function handler(req, res) {
    if (corsHandler(req, res)) return;
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });
    if (!(await authHandler(req, res))) return;
    if (!kvReady()) return res.status(503).json({ ok: false, error: "state_store_not_configured" });

    const startedAt = new Date(now()).toISOString();
    try {
      const doc = await readRules({ readJson });
      const live = armedRules(doc);
      const watching = watchingRules(doc);

      if (doc.pausedAll) {
        return res.status(200).json({ ok: true, at: startedAt, parked: "all_rules_paused", decided: 0 });
      }
      if (!live.length && !watching.length) {
        return res.status(200).json({ ok: true, at: startedAt, parked: "no_active_rules", decided: 0 });
      }

      // The upstream integrity gate. `counts.alert` is sync's latched
      // count-drop tripwire; a tripped one means the published queue is not a
      // trustworthy picture of who applied.
      const counts = await readJson(K.counts).catch(() => null);
      if (counts?.alert) {
        return res.status(200).json({
          ok: true, at: startedAt, decided: 0,
          parked: "snapshot_counts_alert",
          detail: counts.alert,
        });
      }

      const [queueDoc, decisions] = await Promise.all([
        readJson(K.queue),
        readHash(K.decisions),
      ]);
      const candidates = [...new Set((Array.isArray(queueDoc?.rows) ? queueDoc.rows : [])
        .map((row) => row?.cuId).filter(Boolean))];
      const [cards, receipts] = await Promise.all([
        cardsFor(candidates, { readMany }),
        profileReceiptsFor(candidates, { readMany }),
      ]);
      const profileReady = (cuId) => Boolean(cards[cuId]
        && profileReceiptReady(receipts[cuId], now()));
      const rows = pendingRows(queueDoc?.rows ?? [], decisions)
        .filter((row) => profileReady(row.cuId));
      if (!rows.length) {
        return res.status(200).json({
          ok: true,
          at: startedAt,
          decided: 0,
          pending: 0,
          profileCacheWithheld: candidates.filter((cuId) => !profileReady(cuId)).length,
        });
      }

      const facts = await factsFor(rows.map((row) => row.cuId), { readMany });
      const stamp = now();

      const newDecisions = {};
      const audit = {};
      const fired = {};                     // ruleId -> count, live only
      const wouldFire = {};                 // ruleId -> count, watching only
      const skipped = {};
      let considered = 0;

      for (const row of rows) {
        considered += 1;
        const subject = { row, facts: facts[row.cuId] ?? null };

        // Watching rules are evaluated on exactly the same subject and never
        // write a decision — that equivalence is what makes Watching a
        // trustworthy preview rather than a separate code path.
        for (const rule of watching) {
          if (!inScope(rule, row)) continue;
          const result = evaluateRule(rule, subject, { now: stamp });
          if (result.matched) wouldFire[rule.id] = (wouldFire[rule.id] ?? 0) + 1;
        }

        if (!live.length) continue;
        const outcome = decideRow(live, subject, { now: stamp });
        for (const reason of outcome.skips) skipped[reason] = (skipped[reason] ?? 0) + 1;
        if (!outcome.action) continue;

        // Pass is always a valid review outcome, but Interview has external
        // consequences and must use the Core's own readiness bit. A rule may
        // match a candidate whose resume/projection/identity gates are still
        // incomplete; report that candidate instead of writing a decision the
        // Core will reject on its next cycle.
        if (outcome.action === "interview" && row.interviewAllowed !== true) {
          skipped.interview_not_ready = (skipped.interview_not_ready ?? 0) + 1;
          continue;
        }

        const { rule, evidence } = outcome.winner;
        newDecisions[row.key] = decisionRecord({
          action: outcome.action,
          at: new Date(stamp).toISOString(),
          by: ruleActor(rule.id),
          name: row.name,
          roleTitle: row.roleTitle,
        });
        audit[row.key] = {
          at: new Date(stamp).toISOString(),
          ruleId: rule.id,
          ruleName: rule.name,
          ruleVersion: rule.version ?? 1,
          action: outcome.action,
          name: row.name,
          roleTitle: row.roleTitle,
          evidence,
          // Every rule that matched, so the audit shows an Interview rule that
          // lost to a Pass rule rather than pretending it never fired.
          alsoMatched: outcome.matches
            .filter(({ rule: other }) => other.id !== rule.id)
            .map(({ rule: other }) => ({ id: other.id, name: other.name, action: other.action })),
          // How old the LinkedIn snapshot behind this decision was.
          factsUpdatedAt: subject.facts?.updatedAt ?? null,
        };
        fired[rule.id] = (fired[rule.id] ?? 0) + 1;
      }

      // LAST-MOMENT RE-READ. Everything above ran against the decisions hash
      // as it was when the tick started, and a person reviewing the queue can
      // click during that window. HSET would overwrite their call, which is
      // exactly what D3 forbids — so re-read and drop any key that gained a
      // decision while we were thinking. This narrows the race to the width of
      // a single HSET rather than the width of a whole tick; it cannot close
      // it completely without a lock, and a lock on the hash a human clicks
      // into is a worse trade.
      let conceded = 0;
      const fresh = await readHash(K.decisions).catch(() => decisions);
      for (const key of Object.keys(newDecisions)) {
        if (!fresh?.[key]) continue;
        delete newDecisions[key];
        delete audit[key];
        conceded += 1;
      }

      // Decisions first: they are the real effect. Audit and counters are
      // reporting, and a reporting failure must not cost a decision that has
      // already been made — but a decision written without its audit row is
      // one nobody can explain, so the audit write is not swallowed silently
      // either; it is reported in the response.
      const decidedKeys = Object.keys(newDecisions);
      if (decidedKeys.length) await writeHash(K.decisions, newDecisions);

      let auditWritten = true;
      if (decidedKeys.length) {
        try { await writeHash(K.ruleruns, audit); }
        catch { auditWritten = false; }
      }

      try {
        const stats = await readHash(K.rulestats).catch(() => ({}));
        const next = {};
        for (const rule of [...live, ...watching]) {
          const previous = stats[rule.id] ?? {};
          const firedNow = fired[rule.id] ?? 0;
          const wouldNow = wouldFire[rule.id] ?? 0;
          next[rule.id] = {
            fired: (previous.fired ?? 0) + firedNow,
            wouldFire: (previous.wouldFire ?? 0) + wouldNow,
            firedAt: firedNow ? new Date(stamp).toISOString() : (previous.firedAt ?? null),
            lastSeenAt: new Date(stamp).toISOString(),
          };
        }
        if (Object.keys(next).length) await writeHash(K.rulestats, next);
      } catch { /* counters are display-only */ }

      await pruneAudit({ readHash }).catch(() => {});

      return res.status(200).json({
        ok: true,
        at: startedAt,
        by: req.authedEmail || "authenticated-user",
        pending: rows.length,
        considered,
        decided: decidedKeys.length,
        ...(conceded ? { concededToHuman: conceded } : {}),
        fired,
        wouldFire,
        skipped,
        profileCacheWithheld: candidates.filter((cuId) => !profileReady(cuId)).length,
        ...(auditWritten ? {} : { auditWriteFailed: true }),
      });
    } catch (error) {
      return res.status(502).json({
        ok: false,
        error: "tick_failed",
        detail: String(error?.message || error).slice(0, 180),
      });
    }
  };
}

/** Keep the audit bounded; oldest rows fall off first. */
async function pruneAudit({ readHash, deleteFields = hashDelMany }) {
  const runs = await readHash(K.ruleruns);
  const keys = Object.keys(runs ?? {});
  if (keys.length <= MAX_AUDIT_ROWS) return;
  const stale = keys
    .sort((a, b) => String(runs[a]?.at ?? "").localeCompare(String(runs[b]?.at ?? "")))
    .slice(0, keys.length - MAX_AUDIT_ROWS);
  if (stale.length) await deleteFields(K.ruleruns, stale);
}

export default createTickHandler();
