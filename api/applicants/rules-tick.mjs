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
//   - Touch the stream. It reads only the published apphub:queue review rows
//     (D1); tier labels are not a hidden action gate.
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
  actionabilityFor,
  generationManifest,
  readActivePublication,
  readPublishedArtifacts,
  verifyGeneration,
} from "./_lib/generation.mjs";
import {
  RULE_INTERVIEW_ALREADY_EMAILED,
  ruleInterviewSkipReason,
} from "./_lib/rule-interview-eligibility.mjs";
import {
  hashDelMany,
  hashGetAllJson,
  hashGetMany,
  getJson,
  hashSetJson,
  K,
  kvConfigured,
  setJson,
} from "./_lib/kv.mjs";
import { evaluateRule, inScope } from "./_lib/rules.mjs";
import { loadFundedEmployerSnapshots } from "./_lib/funded-employers.mjs";
import { profileReceiptReady, sourceObservationIdFor } from "./_lib/profile-readiness.mjs";
import { armedRules, cardsFor, factsFor, pendingRows, profileReceiptsFor, readRules, watchingRules } from "./_lib/rule-store.mjs";
import {randomUUID} from 'node:crypto';
import {
  APPLICANT_REQUEST_ALREADY_EMAILED,
  requireApplicantMutation,
  saveApplicantRequest,
} from './_lib/request-safety.mjs';

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
  authHandler = requireApplicantMutation,
  kvReady = kvConfigured,
  readJson = getJson,
  readActive = () => readActivePublication({ readJson }),
  readArtifacts = (pointer) => readPublishedArtifacts(pointer, { readJson }),
  readHash = hashGetAllJson,
  readMany = hashGetMany,
  writeHash = hashSetJson,
  writeJson = setJson,
  // The per-key decision write is a Lua CAS across two hashes, so it cannot go
  // through writeHash. Injectable for the same reason every store call above
  // is: the concede/overwrite behaviour has to be testable without a live KV.
  // Production always gets saveApplicantRequest.
  saveRequest = saveApplicantRequest,
  now = () => Date.now(),
  readMembershipSnapshots = (rules) => loadFundedEmployerSnapshots(rules, { readJson }),
} = {}) {
  return async function handler(req, res) {
    if (corsHandler(req, res)) return;
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });
    if (!(await authHandler(req, res))) return;
    if (!kvReady()) return res.status(503).json({ ok: false, error: "state_store_not_configured" });

    const startedAt = new Date(now()).toISOString();
    try {
      let body;
      try { body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {}); }
      catch { return res.status(400).json({ ok: false, error: "invalid_json" }); }

      // Rules are a button-only write path, but the button is not permission
      // to act on whatever happens to be in KV when the request arrives. It
      // must name the immutable publication the reviewer saw. This fence is
      // also what prevents a slow run from crossing a newly published queue.
      const generation = await readActive();
      if (!generation) return res.status(503).json({ ok: false, error: "generation_unavailable" });
      const artifacts = await readArtifacts(generation);
      if (!artifacts || !verifyGeneration(artifacts).ok) {
        return res.status(503).json({ ok: false, error: "generation_unavailable" });
      }
      if (String(body.generationId || "") !== generation.generationId
        || String(body.generationDigest || "") !== generation.digest) {
        return res.status(409).json({
          ok: false,
          error: "generation_changed_refresh_required",
          generationId: generation.generationId,
          generationDigest: generation.digest,
        });
      }

      const doc = await readRules({ readJson });
      const live = armedRules(doc);
      const watching = watchingRules(doc);
      // For parked responses there is no decision set yet, so expose the
      // publication's complete queue identity. Once decisions are loaded the
      // run seals the exact undecided IDs it is allowed to consider.
      let manifest = generationManifest(artifacts.queue?.rows || []);
      const ruleRunId = randomUUID();
      const authorizedBy = String(req.applicantActor?.email || req.authedEmail || "unknown").trim().toLowerCase();

      if (doc.pausedAll) {
        return res.status(200).json({
          ok: true, at: startedAt, parked: "all_rules_paused", decided: 0,
          ruleRunId, generationId: generation.generationId, generationDigest: generation.digest,
          manifest,
        });
      }
      if (!live.length && !watching.length) {
        return res.status(200).json({
          ok: true, at: startedAt, parked: "no_active_rules", decided: 0,
          ruleRunId, generationId: generation.generationId, generationDigest: generation.digest,
          manifest,
        });
      }

      // The upstream integrity gate. `counts.alert` is sync's latched
      // count-drop tripwire; a tripped one means the published queue is not a
      // trustworthy picture of who applied.
      const counts = artifacts.counts;
      if (counts?.alert) {
        return res.status(200).json({
          ok: true, at: startedAt, decided: 0,
          parked: "snapshot_counts_alert",
          detail: counts.alert,
          ruleRunId, generationId: generation.generationId, generationDigest: generation.digest,
          manifest,
        });
      }

      const [queueDoc, decisions, acks] = await Promise.all([
        Promise.resolve(artifacts.queue),
        readHash(K.decisions),
        readHash(K.acks),
      ]);
      const pendingQueueRows = pendingRows(queueDoc?.rows ?? [], decisions);
      const candidates = [...new Set(pendingQueueRows
        .map((row) => row?.profileKey || row?.cuId).filter(Boolean))];
      const [cards, receipts] = await Promise.all([
        cardsFor(candidates, { readMany }),
        profileReceiptsFor(candidates, { readMany }),
      ]);
      const cardHasHistory = (card) => Boolean(card && (
        ["data", "verified_empty"].includes(String(card.historyState || "").trim().toLowerCase())
        || ((!("expCount" in card) && !("eduCount" in card))
          || Number(card.expCount) > 0
          || Number(card.eduCount) > 0)
      ));
      const profileReady = (row) => {
        const cuId = row?.profileKey || row?.cuId;
        if (!cuId || !cards[cuId]) return false;
        return profileReceiptReady(receipts[cuId], now(), sourceObservationIdFor(row))
          || (cardHasHistory(cards[cuId]) && profileReceiptReady(receipts[cuId], now()));
      };
      const receiptMismatches=pendingQueueRows.filter((row)=>!profileReady(row));
      if (receiptMismatches.length) {
        return res.status(503).json({
          ok:false,
          error:"generation_unavailable",
          reason:"profile_receipt_mismatch",
          generationId:generation.generationId,
          generationDigest:generation.digest,
        });
      }
      const rows = pendingQueueRows;
      manifest = generationManifest(rows);
      const fundedEmployerSnapshots = await readMembershipSnapshots([...live, ...watching]);
      await writeJson(K.ruleRun(ruleRunId), {
        ruleRunId,
        trigger:"run_rules_now",
        authenticated:true,
        actorId:authorizedBy,
        authenticatedAt:startedAt,
        generationId:generation.generationId,
        generationDigest:generation.digest,
        manifest,
        ruleVersions:[...live,...watching].map((rule)=>({id:rule.id,version:rule.version ?? 1})),
        fundedEmployerSnapshots: Object.values(fundedEmployerSnapshots).map((snapshot) => ({
          id: snapshot.snapshotId,
          digest: snapshot.digest,
          generatedAt: snapshot.generatedAt,
          companyCount: Array.isArray(snapshot.entries) ? snapshot.entries.length : null,
          reviewedParaformIdCount: Object.keys(snapshot.byParaformId || {}).length,
          reviewedSourceNameCount: Object.keys(snapshot.byReviewedSourceName || {}).length,
        })),
      });
      if (!rows.length) {
        return res.status(200).json({
          ok: true,
          at: startedAt,
          decided: 0,
          pending: 0,
          profileCacheWithheld: 0,
          ruleRunId, generationId: generation.generationId, generationDigest: generation.digest,
          manifest,
        });
      }

      const facts = await factsFor(rows.map((row) => row.profileKey || row.cuId), { readMany });
      const stamp = now();

      const newDecisions = {};
      const audit = {};
      const fired = {};                     // ruleId -> count, live only
      const wouldFire = {};                 // ruleId -> count, watching only
      const skipped = {};
      let considered = 0;

      for (const row of rows) {
        considered += 1;
        const subject = {
          row,
          facts: facts[row.profileKey || row.cuId] ?? null,
          fundedEmployerSnapshots,
        };

        // Watching rules are evaluated on exactly the same subject and never
        // write a decision — that equivalence is what makes Watching a
        // trustworthy preview rather than a separate code path.
        for (const rule of watching) {
          if (!inScope(rule, row)) continue;
          const result = evaluateRule(rule, subject, { now: stamp });
          const interviewSkip = result.matched && rule.action === "interview"
            ? ruleInterviewSkipReason(row, { decision: decisions[row.key], ack: acks[row.key] })
            : null;
          if (interviewSkip) skipped[interviewSkip] = (skipped[interviewSkip] ?? 0) + 1;
          else if (result.matched) wouldFire[rule.id] = (wouldFire[rule.id] ?? 0) + 1;
        }

        if (!live.length) continue;
        const outcome = decideRow(live, subject, { now: stamp });
        for (const reason of outcome.skips) skipped[reason] = (skipped[reason] ?? 0) + 1;
        if (!outcome.action) continue;

        // Pass is always a valid, side-effect-free review outcome. Interview
        // also requires no hard hold and no published same-role send evidence.
        const interviewSkip = outcome.action === "interview"
          ? ruleInterviewSkipReason(row, { decision: decisions[row.key], ack: acks[row.key] })
          : null;
        if (interviewSkip) {
          skipped[interviewSkip] = (skipped[interviewSkip] ?? 0) + 1;
          continue;
        }

        const { rule, evidence } = outcome.winner;
        newDecisions[row.key] = decisionRecord({
          action: outcome.action,
          at: new Date(stamp).toISOString(),
          by: ruleActor(rule.id),
          actorType: "rule",
          actorId: rule.id,
          authorizedBy,
          name: row.name,
          roleTitle: row.roleTitle,
        });
        Object.assign(newDecisions[row.key],{requestId:randomUUID(),inputRevision:row.inputRevision,
          readinessRevision:row.readinessRevision,decisionRevision:Number(row.decisionRevision),status:'pending',
          ...(outcome.action === "interview" ? { deliveryState: "requested" } : {}),
          generationId: generation.generationId,
          generationDigest: generation.digest,
          ruleRunId,
          manifestDigest: manifest.digest,
          manifestCount: manifest.count,
          ruleRun: {
            id: ruleRunId,
            trigger: "run_rules_now",
            authenticated: true,
            actorId: authorizedBy,
            generationId: generation.generationId,
            manifestDigest: manifest.digest,
            authenticatedAt: startedAt,
          },
          ...actionabilityFor(row),
          ruleVersions:[{id:rule.id,version:rule.version ?? 1}]});
        audit[row.key] = {
          at: new Date(stamp).toISOString(),
          ruleRunId,
          generationId: generation.generationId,
          generationDigest: generation.digest,
          manifestDigest: manifest.digest,
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

      // LAST-MOMENT RE-READ. A person can decide a row, or published send
      // evidence can arrive, while rules are evaluating it. Both hashes are
      // required reads: an unavailable ack store must fail closed before a
      // request is created. saveApplicantRequest repeats the sent-ack check in
      // its Lua CAS to close the remaining gap between this read and HSET.
      let conceded = 0;
      const [freshDecisions, freshAcks] = await Promise.all([
        readHash(K.decisions),
        readHash(K.acks),
      ]);
      const rowsByKey = new Map(rows.map((row) => [row.key, row]));
      const dropCandidate = (key) => {
        const ruleId = audit[key]?.ruleId;
        if (ruleId && fired[ruleId]) {
          fired[ruleId] -= 1;
          if (!fired[ruleId]) delete fired[ruleId];
        }
        delete newDecisions[key];
        delete audit[key];
      };
      for (const key of Object.keys(newDecisions)) {
        if (freshDecisions?.[key]) {
          dropCandidate(key);
          conceded += 1;
          continue;
        }
        if (newDecisions[key].action !== "interview") continue;
        const reason = ruleInterviewSkipReason(rowsByKey.get(key), {
          decision: freshDecisions?.[key],
          ack: freshAcks?.[key],
        });
        if (!reason) continue;
        dropCandidate(key);
        skipped[reason] = (skipped[reason] ?? 0) + 1;
      }

      // Decisions first: they are the real effect. Audit and counters are
      // reporting, and a reporting failure must not cost a decision that has
      // already been made — but a decision written without its audit row is
      // one nobody can explain, so the audit write is not swallowed silently
      // either; it is reported in the response.
      const decidedKeys=[];
      const requests=Object.entries(newDecisions);
      // A run can take long enough for the desktop to publish a new immutable
      // generation. Never let a stale run write even one more key after that
      // pointer moved. The per-key atomic write below still protects a human
      // click racing this check.
      const currentGeneration = await readActive();
      if (!currentGeneration
        || currentGeneration.generationId !== generation.generationId
        || currentGeneration.digest !== generation.digest) {
        return res.status(409).json({
          ok: false,
          error: "generation_changed_refresh_required",
          generationId: currentGeneration?.generationId || null,
          generationDigest: currentGeneration?.digest || null,
          ruleRunId,
          manifest,
        });
      }
      for(let offset=0;offset<requests.length;offset+=25) {
        const batchGeneration = await readActive();
        if (!batchGeneration
          || batchGeneration.generationId !== generation.generationId
          || batchGeneration.digest !== generation.digest) {
          return res.status(409).json({
            ok: false,
            error: "generation_changed_refresh_required",
            generationId: batchGeneration?.generationId || null,
            generationDigest: batchGeneration?.digest || null,
            ruleRunId,
            manifest,
          });
        }
        const saved=await Promise.all(requests.slice(offset,offset+25).map(async([key,record])=>[
          key,
          await saveRequest(key,record,{rejectSentAck:record.action==="interview"}),
        ]));
        for(const [key,result] of saved) {
          if(result===true) {
            decidedKeys.push(key);
          } else if(result===APPLICANT_REQUEST_ALREADY_EMAILED) {
            dropCandidate(key);
            skipped[RULE_INTERVIEW_ALREADY_EMAILED] = (skipped[RULE_INTERVIEW_ALREADY_EMAILED] ?? 0) + 1;
          } else {
            dropCandidate(key);
            conceded++;
          }
        }
      }

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
        by: authorizedBy,
        actorType: "rule",
        authorizedBy,
        ruleRunId,
        generationId: generation.generationId,
        generationDigest: generation.digest,
        manifest,
        pending: rows.length,
        considered,
        decided: decidedKeys.length,
        ...(conceded ? { concededToHuman: conceded } : {}),
        fired,
        wouldFire,
        skipped,
        profileCacheWithheld: 0,
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
