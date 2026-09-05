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
import { getJson, hashGetAllJson, hashGetMany, K, kvConfigured, setJson } from "./_lib/kv.mjs";
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
import {
  MAX_RULES,
  MAX_VERSIONS,
  factsFor,
  pendingRows,
  profileReceiptsFor,
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
    const [facts, fundedEmployerSnapshots, profileReceipts] = await Promise.all([
      factsFor(profileKeys, { readMany }),
      readMembershipSnapshots([rule]),
      needsEmploymentSource ? profileReceiptsFor(profileKeys, { readMany }) : Promise.resolve({}),
    ]);

    const matched = [];
    const skipped = {};
    for (const row of scoped) {
      const result = evaluateRule(rule, {
        row,
        facts: facts[row.profileKey || row.cuId] ?? null,
        profileReceipt: profileReceipts[row.profileKey || row.cuId] ?? null,
        fundedEmployerSnapshots,
      });
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
        return res.status(200).json({
          ok: true,
          pending: run.pending,
          considered: run.considered,
          matched: run.matched.length,
          skipped: run.skipped,
          generationId: publication.generationId,
          generationDigest: publication.digest,
          manifest: run.manifest,
          samples: run.matched.slice(0, PREVIEW_SAMPLES).map(({ row, evidence }) => ({
            key: row.key, name: row.name, roleTitle: row.roleTitle, evidence,
          })),
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
