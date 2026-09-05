#!/usr/bin/env node

/**
 * Rebuild the current Applicants generation's derived facts from durable
 * Applicant Hub source profiles. Dry-run is the default.
 *
 *   node --env-file=/absolute/path/.env.local scripts/rebuild-applicant-facts.mjs
 *   node --env-file=/absolute/path/.env.local scripts/rebuild-applicant-facts.mjs --apply
 *
 * The KV module is imported only after the environment is loaded.
 */
import process from "node:process";
import { fileURLToPath } from "node:url";

import { rebuildActiveFacts } from "../api/applicants/_lib/facts-rebuild.mjs";

export function parseArgs(argv) {
  const args = new Set(argv);
  const unknown = [...args].filter((arg) => !["--apply", "--dry-run", "--help"].includes(arg));
  if (unknown.length) throw new Error("unsupported_argument");
  if (args.has("--apply") && args.has("--dry-run")) throw new Error("mode_conflict");
  return { apply: args.has("--apply"), help: args.has("--help") };
}

async function runtime() {
  const [kvModule, generationModule, factsModule, digestModule, readinessModule] = await Promise.all([
    import("../api/applicants/_lib/kv.mjs"),
    import("../api/applicants/_lib/generation.mjs"),
    import("../api/applicants/_lib/facts.mjs"),
    import("../api/applicants/_lib/source-profile-digest.mjs"),
    import("../api/applicants/_lib/profile-readiness.mjs"),
  ]);
  return {
    kvImpl: kvModule.kv,
    K: kvModule.K,
    kvConfigured: kvModule.kvConfigured,
    validPublication: generationModule.validPublication,
    readPublishedArtifacts: generationModule.readPublishedArtifacts,
    factsFromProfile: factsModule.factsFromProfile,
    sourceProfileDigest: digestModule.sourceProfileDigest,
    sourceObservationIdFor: readinessModule.sourceObservationIdFor,
  };
}

function usage() {
  return [
    "Rebuild current Applicant facts from durable source profiles.",
    "Default: read-only dry run.",
    "Usage: node --env-file=/absolute/.env.local scripts/rebuild-applicant-facts.mjs [--dry-run|--apply]",
  ].join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const deps = await runtime();
  if (!deps.kvConfigured()) throw new Error("applicants_state_store_not_configured");
  const report = await rebuildActiveFacts({ apply: options.apply, ...deps });
  console.log(JSON.stringify(report, null, 2));
  if (options.apply && (report.sourceRaceCount || report.generationRaceCount || report.readbackMismatchCount)) {
    process.exitCode = 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: String(error?.message || error).slice(0, 120) }));
    process.exitCode = 1;
  });
}
