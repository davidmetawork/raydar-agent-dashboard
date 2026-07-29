#!/usr/bin/env node
/**
 * Reversible Paraform sequence-link migration.
 *
 * Default mode is a read-only audit. `--apply` is intentionally impossible
 * until the two production routes respond, the dashboard reports the native
 * webhook/index enabled and healthy, an explicit cutover phrase is present,
 * and a private absolute manifest path is supplied. Every write is read back.
 * Any partial failure rolls all already-written sequences back and verifies the
 * rollback before exiting non-zero.
 *
 * This script never prints step bodies, sender addresses, credentials, or
 * candidate data. The private rollback manifest contains exact sequence steps,
 * is created mode 0600, and must never be committed.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  trpcGet,
  trpcPost,
} from "../api/seq/_lib/core.mjs";
import {
  AGENT_SCHEDULING_URL,
  HUMAN_SCHEDULING_URL,
  findLegacySchedulingLinks,
  rewriteLegacySchedulingLinks,
} from "../api/seq/_lib/scheduling-links.mjs";

const APPLY_PHRASE = "APPLY_ALL_RAYDAR_SEQUENCE_LINKS";
const ROLLBACK_PHRASE = "ROLLBACK_ALL_RAYDAR_SEQUENCE_LINKS";
const MANIFEST_SCHEMA = "raydar-sequence-link-migration-v1";
const HEALTH_URL = "https://monitor.raydar.xyz/api/seq/health";

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stable(value[key])]),
  );
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function parseArgs(argv) {
  const out = { mode: "audit", manifest: null };
  for (const arg of argv) {
    if (arg === "--audit") out.mode = "audit";
    else if (arg === "--apply") out.mode = "apply";
    else if (arg === "--rollback") out.mode = "rollback";
    else if (arg.startsWith("--manifest=")) out.manifest = arg.slice("--manifest=".length);
    else fail("ARGUMENT_INVALID");
  }
  return out;
}

function requirePrivateManifestPath(value) {
  if (!value || !path.isAbsolute(value)) fail("ABSOLUTE_MANIFEST_PATH_REQUIRED");
  const resolved = path.resolve(value);
  const repo = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  if (resolved === repo || resolved.startsWith(`${repo}${path.sep}`)) {
    fail("MANIFEST_MUST_BE_OUTSIDE_REPOSITORY");
  }
  return resolved;
}

function stepProjection(step) {
  return {
    id: step?.id ?? null,
    step_number: step?.step_number ?? null,
    subject: step?.subject ?? "",
    body: step?.body ?? "",
  };
}

function exactStepReadback(expected, actual) {
  const wanted = expected.map(stepProjection);
  const got = actual.map(stepProjection);
  return digest(wanted) === digest(got);
}

export function planSequence(sequence, campaign) {
  const steps = Array.isArray(campaign?.steps) ? campaign.steps : [];
  const afterSteps = [];
  const changedSteps = [];
  const unknown = [];
  let agent = 0;
  let human = 0;
  let callouts = 0;
  let agentLabels = 0;
  let humanLabels = 0;

  for (const step of steps) {
    let next = { ...step };
    const changedFields = [];
    for (const field of ["subject", "body"]) {
      const before = String(step?.[field] ?? "");
      const found = findLegacySchedulingLinks(before);
      unknown.push(...found.unknown.map((url) => ({
        step: step.step_number ?? null,
        field,
        url,
      })));
      const rewritten = rewriteLegacySchedulingLinks(before);
      if (rewritten.changed) {
        next[field] = rewritten.value;
        changedFields.push(field);
        agent += rewritten.replacements.agent;
        human += rewritten.replacements.human;
        callouts += rewritten.copyNormalizations.callouts;
        agentLabels += rewritten.copyNormalizations.agentLabels;
        humanLabels += rewritten.copyNormalizations.humanLabels;
      }
    }
    if (changedFields.length) {
      changedSteps.push({
        step: step.step_number ?? null,
        fields: changedFields,
      });
    }
    afterSteps.push(next);
  }

  return {
    id: sequence.id,
    name: sequence.name,
    enabled: Boolean(sequence.enabled),
    beforeSteps: steps,
    afterSteps,
    changedSteps,
    replacements: { agent, human },
    copyNormalizations: { callouts, agentLabels, humanLabels },
    unknown,
    changed: changedSteps.length > 0,
    beforeDigest: digest(steps.map(stepProjection)),
    afterDigest: digest(afterSteps.map(stepProjection)),
  };
}

async function loadPlans() {
  const sequences = (await trpcGet("campaigns.getListOfCampaignsOptimized", {})) || [];
  const plans = [];
  for (const sequence of sequences) {
    const campaign = await trpcGet("campaigns.getCampaign", { campaign_id: sequence.id });
    plans.push(planSequence(sequence, campaign));
  }
  return { sequenceCount: sequences.length, plans };
}

function redactedInventory(sequenceCount, plans) {
  const changed = plans.filter((plan) => plan.changed);
  return {
    schema: MANIFEST_SCHEMA,
    mode: "audit",
    sequenceCount,
    sequencesWithLegacyLinks: changed.length,
    enabledWithLegacyLinks: changed.filter((plan) => plan.enabled).length,
    disabledWithLegacyLinks: changed.filter((plan) => !plan.enabled).length,
    agentReplacements: changed.reduce((sum, plan) => sum + plan.replacements.agent, 0),
    humanReplacements: changed.reduce((sum, plan) => sum + plan.replacements.human, 0),
    calloutCopyNormalizations: changed.reduce((sum, plan) => sum + plan.copyNormalizations.callouts, 0),
    agentLinkLabelNormalizations: changed.reduce((sum, plan) => sum + plan.copyNormalizations.agentLabels, 0),
    humanLinkLabelNormalizations: changed.reduce((sum, plan) => sum + plan.copyNormalizations.humanLabels, 0),
    unknownLegacyLinks: plans.reduce((sum, plan) => sum + plan.unknown.length, 0),
    sequences: changed.map((plan) => ({
      id: plan.id,
      name: plan.name,
      enabled: plan.enabled,
      changedSteps: plan.changedSteps,
      replacements: plan.replacements,
      copyNormalizations: plan.copyNormalizations,
      unknown: plan.unknown,
      beforeDigest: plan.beforeDigest,
      afterDigest: plan.afterDigest,
    })),
  };
}

async function requireCutoverReadiness(fetchImpl = fetch) {
  for (const url of [AGENT_SCHEDULING_URL, HUMAN_SCHEDULING_URL]) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      fail("SCHEDULER_ROUTE_UNAVAILABLE");
    }
    if (!response.ok) fail("SCHEDULER_ROUTE_UNAVAILABLE");
  }

  let response;
  try {
    response = await fetchImpl(HEALTH_URL, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    fail("BOOKING_STOP_HEALTH_UNAVAILABLE");
  }
  const health = await response.json().catch(() => null);
  const native = health?.bookingStop?.raydarScheduler;
  if (!response.ok
    || health?.bookingStop?.stale !== false
    || native?.enabled !== true
    || native?.webhookConfigured !== true
    || native?.indexConfigured !== true
    || native?.lastSweepEnabled !== true
    || native?.lastSweepComplete !== true
    || !Number.isInteger(native?.bookingsLastPass)
    || native.bookingsLastPass < 1) {
    fail("BOOKING_STOP_NOT_CUTOVER_READY");
  }
}

async function writeManifest(manifestPath, changed) {
  const payload = {
    schema: MANIFEST_SCHEMA,
    createdAt: new Date().toISOString(),
    targets: {
      agent: AGENT_SCHEDULING_URL,
      human: HUMAN_SCHEDULING_URL,
    },
    sequences: changed.map((plan) => ({
      id: plan.id,
      name: plan.name,
      enabledAtSnapshot: plan.enabled,
      beforeSteps: plan.beforeSteps,
      afterSteps: plan.afterSteps,
      beforeDigest: plan.beforeDigest,
      afterDigest: plan.afterDigest,
    })),
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

async function updateAndVerify(entry, steps) {
  await trpcPost("campaigns.updateSequenceSteps", {
    campaign_id: entry.id,
    steps,
  });
  const readback = await trpcGet("campaigns.getCampaign", {
    campaign_id: entry.id,
  });
  if (!exactStepReadback(steps, readback?.steps || [])) {
    fail("SEQUENCE_READBACK_MISMATCH");
  }
}

export async function rollbackEntries(entries, writeAndVerify = updateAndVerify) {
  const failures = [];
  for (const entry of [...entries].reverse()) {
    try { await writeAndVerify(entry, entry.beforeSteps); }
    catch { failures.push({ id: entry.id, name: entry.name }); }
  }
  if (failures.length) {
    const error = new Error("ROLLBACK_READBACK_FAILED");
    error.code = "ROLLBACK_READBACK_FAILED";
    error.failures = failures;
    throw error;
  }
}

export async function migratePlansTransaction(changed, {
  writeAndVerify = updateAndVerify,
  verifyComplete = async () => {},
} = {}) {
  const attempted = [];
  try {
    for (const plan of changed) {
      // Include the current target before issuing its write. If the write
      // succeeds but the read-back request fails or detects drift, this target
      // must still be restored from the pre-write manifest.
      attempted.push(plan);
      await writeAndVerify(plan, plan.afterSteps);
    }
    await verifyComplete();
    return attempted;
  } catch (error) {
    try {
      await rollbackEntries(attempted, writeAndVerify);
    } catch (rollbackError) {
      rollbackError.cause = error;
      throw rollbackError;
    }
    throw error;
  }
}

async function applyMigration(args) {
  if (process.env.SCHEDULER_SEQUENCE_LINK_CUTOVER !== APPLY_PHRASE) {
    fail("APPLY_CONFIRMATION_MISSING");
  }
  const manifestPath = requirePrivateManifestPath(args.manifest);
  await requireCutoverReadiness();

  const { sequenceCount, plans } = await loadPlans();
  const inventory = redactedInventory(sequenceCount, plans);
  if (inventory.unknownLegacyLinks) fail("UNKNOWN_SCHEDULING_LINKS_REQUIRE_CLASSIFICATION");
  const changed = plans.filter((plan) => plan.changed);
  if (!changed.length) return { ...inventory, mode: "apply", alreadyMigrated: true };

  await writeManifest(manifestPath, changed);
  // The inventory read is deliberately complete and can take close to a minute.
  // Re-check immediately before the first candidate-facing mutation.
  await requireCutoverReadiness();
  const applied = await migratePlansTransaction(changed, {
    verifyComplete: async () => {
      // Route/booking-stop readiness is part of post-write read-back. If the
      // destination degraded during the batch, restoring legacy links is safer
      // than leaving a partially operational cutover.
      await requireCutoverReadiness();
      const final = await loadPlans();
      const remaining = final.plans.filter((plan) => plan.changed || plan.unknown.length);
      if (remaining.length) fail("POST_MIGRATION_LEGACY_LINKS_REMAIN");
      const finalById = new Map(final.plans.map((plan) => [plan.id, plan]));
      for (const expected of changed) {
        if (finalById.get(expected.id)?.beforeDigest !== expected.afterDigest) {
          fail("POST_MIGRATION_READBACK_DRIFT");
        }
      }
      await requireCutoverReadiness();
    },
  });

  return {
    ...inventory,
    mode: "apply",
    migrated: applied.length,
    readbackVerified: applied.length,
    rollbackManifest: manifestPath,
  };
}

async function rollbackMigration(args) {
  if (process.env.SCHEDULER_SEQUENCE_LINK_CUTOVER !== ROLLBACK_PHRASE) {
    fail("ROLLBACK_CONFIRMATION_MISSING");
  }
  const manifestPath = requirePrivateManifestPath(args.manifest);
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (manifest?.schema !== MANIFEST_SCHEMA
    || manifest?.targets?.agent !== AGENT_SCHEDULING_URL
    || manifest?.targets?.human !== HUMAN_SCHEDULING_URL
    || !Array.isArray(manifest.sequences)
    || !manifest.sequences.length) {
    fail("ROLLBACK_MANIFEST_INVALID");
  }
  const seenIds = new Set();
  for (const entry of manifest.sequences) {
    if (typeof entry?.id !== "string"
      || !entry.id
      || seenIds.has(entry.id)
      || !Array.isArray(entry.beforeSteps)
      || !Array.isArray(entry.afterSteps)
      || entry.beforeDigest !== digest(entry.beforeSteps.map(stepProjection))
      || entry.afterDigest !== digest(entry.afterSteps.map(stepProjection))) {
      fail("ROLLBACK_MANIFEST_INVALID");
    }
    seenIds.add(entry.id);
  }

  // Never overwrite post-cutover operator edits. Every target must still equal
  // the exact native state captured in the manifest (or already be restored).
  for (const entry of manifest.sequences) {
    const current = await trpcGet("campaigns.getCampaign", {
      campaign_id: entry.id,
    });
    const currentDigest = digest((current?.steps || []).map(stepProjection));
    if (currentDigest !== entry.afterDigest && currentDigest !== entry.beforeDigest) {
      fail("ROLLBACK_CURRENT_STATE_DRIFT");
    }
  }
  await rollbackEntries(manifest.sequences);
  return {
    schema: MANIFEST_SCHEMA,
    mode: "rollback",
    restored: manifest.sequences.length,
    readbackVerified: manifest.sequences.length,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.mode === "apply") return applyMigration(args);
  if (args.mode === "rollback") return rollbackMigration(args);
  const { sequenceCount, plans } = await loadPlans();
  return redactedInventory(sequenceCount, plans);
}

const isCli = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  main().then(
    (result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`),
    (error) => {
      process.stderr.write(`${JSON.stringify({
        ok: false,
        error: String(error?.code || error?.message || "migration_failed"),
        rollbackFailures: error?.failures || undefined,
      })}\n`);
      process.exitCode = 1;
    },
  );
}
