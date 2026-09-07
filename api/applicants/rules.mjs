// The Rules view's whole API: read the rules, save one, delete one, change a
// rule's state, pause everything, and preview what a draft rule would do.
//
// Everyone signed in through the Raydar Google gate has full access — create,
// edit, arm, delete (David's call, 2026-08-20: "everyone should have full
// access and it should be simple to use"). There are no permission tiers, so
// the only thing standing between a person and an armed rule is the preview,
// which is why the preview is part of this endpoint rather than an optional
// extra: the editor always knows how many people a rule would hit.
//
// Sole writer of apphub:rules. The tick deliberately writes elsewhere.

import { randomUUID } from "node:crypto";

import { cors, requireAuth } from "./_lib/core.mjs";
import { getJson, hashGetAllJson, hashGetMany, hashSetJson, K, kvConfigured, setJson } from "./_lib/kv.mjs";
import {
  generationManifest,
  readActivePublication,
  readPublishedArtifacts,
  verifyGeneration,
} from "./_lib/generation.mjs";
import { ruleInterviewSkipReason } from "./_lib/rule-interview-eligibility.mjs";
import { FIELD_GROUPS, evaluateRule, fieldCatalog, inScope, normalizeRule } from "./_lib/rules.mjs";
import {
  loadFundedEmployerSnapshots,
  readFundedEmployerCatalog,
} from "./_lib/funded-employers.mjs";
import { DEGREE_LEVELS, DEGREE_LEVEL_LABELS } from "./_lib/degree.mjs";
import { requireApplicantMutation } from "./_lib/request-safety.mjs";
import { directoryFromFacts } from "./_lib/facts.mjs";
import { richBindingsForSnapshot, richProfileMatches } from "./_lib/rich-profile.mjs";
import {
  richReceiptMatches,
  richRuleFactsFromProfile,
  richRuleFactsMatch,
  selectRuleFacts,
  ruleNeedsProfileFacts,
} from "./_lib/rich-rule-facts.mjs";
import {
  MAX_RULES,
  MAX_VERSIONS,
  factsFor,
  pendingRows,
  profileReceiptsFor,
  richProfileReceiptsFor,
  richRuleFactsFor,
  readDirectories,
  readRules,
  writeRules,
} from "./_lib/rule-store.mjs";

export const config = { maxDuration: 60 };

/** Samples shown under the editor's match count. Enough to recognise whether
 *  a rule is catching the people you meant; small enough to stay readable. */
const PREVIEW_SAMPLES = 8;

const clean = (value) => String(value ?? "").trim();

export function createRulesHandler({
  corsHandler = cors,
  authHandler = requireAuth,
  mutationAuthHandler = requireApplicantMutation,
  kvReady = kvConfigured,
  readJson = getJson,
  readActive = () => readActivePublication({ readJson }),
  readArtifacts = (pointer) => readPublishedArtifacts(pointer, { readJson }),
  writeJson = setJson,
  readHash = hashGetAllJson,
  readMany = hashGetMany,
  writeHash = hashSetJson,
  now = () => new Date().toISOString(),
  newId = () => `rule-${randomUUID()}`,
  readMembershipSnapshots = (rules) => loadFundedEmployerSnapshots(rules, { readJson }),
  readMembershipCatalog = () => readFundedEmployerCatalog({ readJson }),
} = {}) {
  const loadRules = () => readRules({ readJson });
  const saveRules = (doc) => writeRules(doc, { writeJson });

  /**
   * Evaluate a rule against every pending applicant. Shared by the editor's
   * preview and by "see the last 10 it hit", and deliberately the SAME
   * evaluateRule the tick uses — a preview that could disagree with the
   * engine would be worse than no preview.
   */
  async function runAgainstQueue(rule, artifacts) {
    const [decisions, acks] = await Promise.all([
      readHash(K.decisions),
      readHash(K.acks),
    ]);
    const rows = pendingRows(artifacts?.queue?.rows ?? [], decisions);
    const scoped = rows.filter((row) => inScope(rule, row));
    const profileKeys = scoped.map((row) => row.profileKey || row.cuId);
    const needsEmploymentSource = (Array.isArray(rule?.conditions) ? rule.conditions : [])
      .some((condition) => condition?.field === "employment.fundedEmployerSnapshot");
    const needsRich = ruleNeedsProfileFacts(rule);
    const bindings = richBindingsForSnapshot({ ...artifacts.snapshot, queue: artifacts.queue.rows });
    const evaluatedAt = Date.parse(now());
    const [facts, richFacts, richReceipts, fundedEmployerSnapshots, profileReceipts] = await Promise.all([
      factsFor(profileKeys, { readMany }),
      needsRich ? richRuleFactsFor(profileKeys, { readMany }) : {},
      needsRich ? richProfileReceiptsFor(profileKeys, { readMany }) : {},
      readMembershipSnapshots([rule]),
      needsEmploymentSource ? profileReceiptsFor(profileKeys, { readMany }) : Promise.resolve({}),
    ]);

    const matched = [];
    const skipped = {};
    const profileFactsCoverage = { required: 0, ready: 0, pending: 0 };
    for (const row of scoped) {
      const key = row.profileKey || row.cuId;
      const selected = selectRuleFacts({
        row, sourceFacts: facts[key], richFacts: richFacts[key], richReceipt: richReceipts[key],
        bindings, now: evaluatedAt,
      });
      if (needsRich && selected.richEligible) {
        profileFactsCoverage.required += 1;
        profileFactsCoverage[selected.projectionPending ? "pending" : "ready"] += 1;
      }
      const result = evaluateRule(rule, {
        row,
        facts: selected.facts,
        profileFactsPending: selected.projectionPending,
        profileReceipt: profileReceipts[row.profileKey || row.cuId] ?? null,
        fundedEmployerSnapshots,
      }, { now: evaluatedAt });
      const interviewSkip = result.matched && rule.action === "interview"
        ? ruleInterviewSkipReason(row, { decision: decisions[row.key], ack: acks[row.key] })
        : null;
      if (interviewSkip) {
        skipped[interviewSkip] = (skipped[interviewSkip] ?? 0) + 1;
      } else if (result.matched) matched.push({ row, evidence: result.evidence });
      else if (result.skipped) skipped[result.reason] = (skipped[result.reason] ?? 0) + 1;
    }
    return {
      pending: rows.length,
      considered: scoped.length,
      matched,
      skipped,
      profileFactsCoverage,
      generation: artifacts.pointer,
      manifest: generationManifest(rows),
    };
  }

  return async function handler(req, res) {
    if (corsHandler(req, res)) return;
    if (req.method !== "GET" && req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "GET or POST only" });
    }
    if (req.method === "GET") {
      if (!(await authHandler(req, res))) return;
    } else if (!(await mutationAuthHandler(req, res))) return;
    if (!kvReady()) return res.status(503).json({ ok: false, error: "state_store_not_configured" });
    res.setHeader("Cache-Control", "no-store");

    try {
      if (req.method === "GET") {
        const doc = await loadRules();
        const [stats, publication, fundedEmployers] = await Promise.all([
          readHash(K.rulestats).catch(() => ({})),
          readActive(),
          readMembershipCatalog().catch(() => ({ activeSnapshotId: null, snapshots: [] })),
        ]);
        // Directories are thousands of entries; the list view does not need
        // them, only the editor does.
        const directories = clean(req.query?.with) === "directories"
          ? await readDirectories({ readHash })
          : null;
        return res.status(200).json({
          ok: true,
          rev: doc.rev,
          pausedAll: doc.pausedAll,
          rules: doc.rules,
          stats,
          // The editor renders its pickers from the server's own catalog, so
          // the choices offered and the values accepted are the same list.
          catalog: fieldCatalog(),
          groups: FIELD_GROUPS,
          degreeLevels: DEGREE_LEVELS.map((id) => ({ id, label: DEGREE_LEVEL_LABELS[id] })),
          fundedEmployers,
          ...(publication ? {
            generation: {
              generationId: publication.generationId,
              digest: publication.digest,
            },
          } : {}),
          ...(directories ? { directories } : {}),
        });
      }

      let body;
      try { body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {}); }
      catch { return res.status(400).json({ ok: false, error: "invalid_json" }); }

      const op = clean(body.op);
      const by = clean(req.authedEmail).toLowerCase() || "unknown";

      // ── preview: never touches stored state ──────────────────────────────
      if (op === "preview") {
        const publication = await readActive();
        if (!publication) return res.status(503).json({ ok: false, error: "generation_unavailable" });
        if (String(body.generationId || "") !== publication.generationId
          || String(body.generationDigest || "") !== publication.digest) {
          return res.status(409).json({
            ok: false,
            error: "generation_changed_refresh_required",
            generationId: publication.generationId,
            generationDigest: publication.digest,
          });
        }
        const artifacts = await readArtifacts(publication);
        if (!artifacts || !verifyGeneration(artifacts).ok) {
          return res.status(503).json({ ok: false, error: "generation_unavailable" });
        }
        const normalized = normalizeRule(body.rule, { now, by });
        if (!normalized.ok) return res.status(400).json({ ok: false, error: "rule_invalid", detail: normalized.error });
        const run = await runAgainstQueue(normalized.rule, artifacts);
        const latest = await readActive();
        if (latest?.generationId !== publication.generationId || latest?.digest !== publication.digest) {
          return res.status(409).json({ ok: false, error: "generation_changed_refresh_required",
            generationId: latest?.generationId || null, generationDigest: latest?.digest || null });
        }
        return res.status(200).json({
          ok: true,
          pending: run.pending,
          considered: run.considered,
          matched: run.matched.length,
          skipped: run.skipped,
          profileFactsCoverage: run.profileFactsCoverage,
          projectionPending: run.profileFactsCoverage.pending,
          generationId: publication.generationId,
          generationDigest: publication.digest,
          manifest: run.manifest,
          samples: run.matched.slice(0, PREVIEW_SAMPLES).map(({ row, evidence }) => ({
            key: row.key, name: row.name, roleTitle: row.roleTitle, evidence,
          })),
        });
      }

      if (op === "prepareProfileFacts") {
        const publication = await readActive();
        if (!publication) return res.status(503).json({ ok: false, error: "generation_unavailable" });
        if (String(body.generationId || "") !== publication.generationId
          || String(body.generationDigest || "") !== publication.digest) {
          return res.status(409).json({ ok: false, error: "generation_changed_refresh_required",
            generationId: publication.generationId, generationDigest: publication.digest });
        }
        const artifacts = await readArtifacts(publication);
        if (!artifacts || !verifyGeneration(artifacts).ok) {
          return res.status(503).json({ ok: false, error: "generation_unavailable" });
        }
        const cursor = Number(body.cursor ?? 0);
        const batchSize = Number(body.batchSize ?? 25);
        if (!Number.isSafeInteger(cursor) || cursor < 0
          || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 50) {
          return res.status(400).json({ ok: false, error: "invalid_prepare_profile_facts_page" });
        }
        const snapshot = { ...artifacts.snapshot, queue: artifacts.queue.rows };
        const bindings = richBindingsForSnapshot(snapshot);
        const keys = [...new Set((artifacts.queue?.rows || [])
          .map((row) => row?.profileKey || row?.cuId).filter((key) => bindings.has(key)))].sort();
        const page = keys.slice(cursor, cursor + batchSize);
        const [receipts, storedFacts] = await Promise.all([
          richProfileReceiptsFor(page, { readMany }),
          richRuleFactsFor(page, { readMany }),
        ]);
        const preparedAt = Date.parse(now());
        const projected = {};
        const schools = {};
        const companies = {};
        const unavailable = [];
        const errors = [];
        let alreadyReady = 0;
        const prepareOne = async (key) => {
          const binding = bindings.get(key);
          const receipt = receipts[key];
          if (!richReceiptMatches(binding, receipt, { now: preparedAt })) {
            unavailable.push({ key, reason: "rich_profile_receipt_unavailable" });
            return;
          }
          if (richRuleFactsMatch({ binding, facts: storedFacts[key], receipt, now: preparedAt })) {
            alreadyReady += 1;
            return;
          }
          try {
            const profile = await readJson(K.richProfile(key));
            if (!richProfileMatches(binding, profile, { now: preparedAt })
              || profile.profileEnrichedAt !== receipt.profileEnrichedAt
              || profile.richProfileRetainedUntil !== receipt.richProfileRetainedUntil) {
              unavailable.push({ key, reason: "rich_profile_cache_unavailable" });
              return;
            }
            const factsRow = richRuleFactsFromProfile(profile, {
              now: preparedAt, receiptVersion: Number(receipt.v) || 0,
            });
            if (!factsRow) {
              unavailable.push({ key, reason: "rich_profile_cache_invalid" });
              return;
            }
            projected[key] = factsRow;
          } catch (error) {
            errors.push({ key, reason: String(error?.message || error).slice(0, 120) });
          }
        };
        for (let offset = 0; offset < page.length; offset += 5) {
          await Promise.all(page.slice(offset, offset + 5).map(prepareOne));
        }
        const freshReceipts = await richProfileReceiptsFor(Object.keys(projected), { readMany });
        for (const key of Object.keys(projected)) {
          if (!richRuleFactsMatch({ binding: bindings.get(key), facts: projected[key], receipt: freshReceipts[key], now: Date.parse(now()) })) {
            delete projected[key];
            unavailable.push({ key, reason: "rich_profile_receipt_changed" });
          }
        }
        const current = await readActive();
        if (!current || current.generationId !== publication.generationId || current.digest !== publication.digest) {
          return res.status(409).json({ ok: false, error: "generation_changed_refresh_required",
            generationId: current?.generationId || null, generationDigest: current?.digest || null });
        }
        if (Object.keys(projected).length) await writeHash(K.richRuleFacts, projected);
        const [readback, finalReceipts, finalPublication] = await Promise.all([
          richRuleFactsFor(Object.keys(projected), { readMany }),
          richProfileReceiptsFor(Object.keys(projected), { readMany }), readActive(),
        ]);
        if (finalPublication?.generationId !== publication.generationId || finalPublication?.digest !== publication.digest) {
          return res.status(409).json({ ok: false, error: "generation_changed_refresh_required",
            generationId: finalPublication?.generationId || null, generationDigest: finalPublication?.digest || null });
        }
        let verified = 0;
        for (const key of Object.keys(projected)) {
          if (!richRuleFactsMatch({ binding: bindings.get(key), facts: readback[key], receipt: finalReceipts[key], now: Date.parse(now()) })) {
            errors.push({ key, reason: "rich_profile_projection_readback_failed" });
            continue;
          }
          verified += 1;
          const directory = directoryFromFacts(readback[key]);
          Object.assign(schools, directory.schools);
          Object.assign(companies, directory.companies);
        }
        if (Object.keys(schools).length) await writeHash(K.schools, schools);
        if (Object.keys(companies).length) await writeHash(K.companies, companies);
        const nextCursor = cursor + page.length < keys.length ? cursor + page.length : null;
        return res.status(200).json({
          ok: true, generationId: publication.generationId, generationDigest: publication.digest,
          cursor, nextCursor,
          coverage: { total: keys.length, processed: page.length, projected: Object.keys(projected).length,
            alreadyReady, readbackVerified: verified, unavailable: unavailable.length, errors: errors.length,
            remaining: Math.max(0, keys.length - cursor - page.length), complete: nextCursor == null },
          unavailable, errors,
        });
      }

      // Every mutating op is guarded by the revision the browser read.
      const doc = await loadRules();
      const staleRev = Number.isInteger(body.rev) && body.rev !== doc.rev;
      if (staleRev && op !== "pauseAll") {
        return res.status(409).json({ ok: false, error: "rules_changed", rev: doc.rev });
      }

      if (op === "pauseAll") {
        const next = await saveRules({ ...doc, pausedAll: Boolean(body.paused) });
        return res.status(200).json({ ok: true, rev: next.rev, pausedAll: next.pausedAll });
      }

      if (op === "delete") {
        const id = clean(body.id);
        const rules = doc.rules.filter((rule) => rule.id !== id);
        if (rules.length === doc.rules.length) return res.status(404).json({ ok: false, error: "rule_not_found" });
        const next = await saveRules({ ...doc, rules });
        return res.status(200).json({ ok: true, rev: next.rev, rules: next.rules });
      }

      if (op === "setState") {
        const id = clean(body.id);
        const state = clean(body.state);
        const index = doc.rules.findIndex((rule) => rule.id === id);
        if (index < 0) return res.status(404).json({ ok: false, error: "rule_not_found" });
        const normalized = normalizeRule({ ...doc.rules[index], state }, { now, by });
        if (!normalized.ok) return res.status(400).json({ ok: false, error: "rule_invalid", detail: normalized.error });
        const rules = [...doc.rules];
        rules[index] = { ...doc.rules[index], state: normalized.rule.state, updatedAt: normalized.rule.updatedAt, updatedBy: by };
        const next = await saveRules({ ...doc, rules });
        return res.status(200).json({ ok: true, rev: next.rev, rules: next.rules });
      }

      if (op === "save") {
        const normalized = normalizeRule(body.rule, { now, by });
        if (!normalized.ok) return res.status(400).json({ ok: false, error: "rule_invalid", detail: normalized.error });
        const incoming = normalized.rule;
        const index = incoming.id ? doc.rules.findIndex((rule) => rule.id === incoming.id) : -1;

        if (index < 0 && doc.rules.length >= MAX_RULES) {
          return res.status(409).json({ ok: false, error: "too_many_rules", max: MAX_RULES });
        }

        const previous = index >= 0 ? doc.rules[index] : null;
        // The version history is what the rollback control reads. Only the
        // parts that change what a rule DOES are kept — state changes are not
        // a revision, they are just the switch being flipped.
        const versions = [
          ...(previous?.versions ?? []),
          ...(previous
            ? [{
              at: previous.updatedAt ?? null,
              by: previous.updatedBy ?? null,
              name: previous.name,
              action: previous.action,
              conditions: previous.conditions,
              scope: previous.scope,
              note: previous.note,
            }]
            : []),
        ].slice(-MAX_VERSIONS);

        const saved = {
          ...incoming,
          id: incoming.id || newId(),
          createdAt: previous?.createdAt ?? incoming.updatedAt,
          createdBy: previous?.createdBy ?? by,
          version: (previous?.version ?? 0) + 1,
          versions,
        };
        const rules = index >= 0
          ? doc.rules.map((rule, i) => (i === index ? saved : rule))
          : [...doc.rules, saved];
        const next = await saveRules({ ...doc, rules });
        return res.status(200).json({ ok: true, rev: next.rev, rule: saved, rules: next.rules });
      }

      if (op === "hits") {
        // "See the last 10 it hit" — the audit hash, filtered to one rule.
        const runs = await readHash(K.ruleruns).catch(() => ({}));
        const id = clean(body.id);
        const hits = Object.entries(runs)
          .filter(([, run]) => run?.ruleId === id)
          .sort((a, b) => String(b[1]?.at ?? "").localeCompare(String(a[1]?.at ?? "")))
          .slice(0, 10)
          .map(([key, run]) => ({ key, ...run }));
        return res.status(200).json({ ok: true, hits });
      }

      return res.status(400).json({ ok: false, error: "unsupported_op" });
    } catch (error) {
      return res.status(502).json({
        ok: false,
        error: "rules_unavailable",
        detail: String(error?.message || error).slice(0, 180),
      });
    }
  };
}

export default createRulesHandler();
