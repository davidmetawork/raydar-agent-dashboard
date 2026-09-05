import { canonicalJson, deepFreeze, sha256 } from "../resume/source-bundle.mjs";

export const PREPARATION_COMMAND_SCHEMA = "raydar.submissions-v2.prepare-command.v1";
export const PREPARATION_RESULT_SCHEMA = "raydar.submissions-v2.prepare-result.v1";
const TRIGGERS = new Set(["initial", "regenerate", "retry"]);
const OUTCOMES = new Set(["existing", "prepared", "review", "failed", "uncertain", "superseded"]);
const clean = (value, limit = 500) => String(value ?? "").trim().slice(0, limit);
const integer = (value) => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;

export function createPreparationCommand({ pair, job, checkpoint = {} } = {}) {
  const pairId = clean(pair?.id || pair?.pair_id, 200);
  const candidateId = clean(pair?.candidate_user_id || pair?.candidateId, 200);
  const roleId = clean(pair?.role_id || pair?.roleId, 200);
  const expectedVersion = integer(checkpoint.expected_pair_version ?? pair?.state_version);
  const jobId = clean(job?.id, 200);
  const triggerKind = TRIGGERS.has(checkpoint.trigger_kind) ? checkpoint.trigger_kind : "initial";
  if (!pairId || !candidateId || !roleId || !expectedVersion || !jobId) throw Object.assign(new TypeError("A preparation command requires an exact pair, version fence, and job."), { code: "prepare_command_invalid" });
  if ((pair.intent_state && pair.intent_state !== "interested")
    || (pair.workflow_state && !["preparing_resume", "interested", "needs_review"].includes(pair.workflow_state))) throw Object.assign(new TypeError("Preparation is permitted only for an interested exact pair."), { code: "prepare_command_not_eligible" });
  return deepFreeze({ schema_version: PREPARATION_COMMAND_SCHEMA, command_id: `prepare_${sha256(canonicalJson({ pairId, jobId, expectedVersion, triggerKind })).slice(0, 24)}`,
    pair: { id: pairId, candidate_id: candidateId, role_id: roleId, expected_state_version: expectedVersion }, job: { id: jobId, attempt: Math.max(1, Number(job.attempt_count) || 1), control_epoch: Number(job.control_epoch || 0) || null }, trigger_kind: triggerKind,
    reuse_policy: Object.freeze({ candidate_original_extraction: "exact-candidate-source-digest-only", pair_supplements: "never", role_context: "never", strategy: "never", validator: "never", artifact: "never" }),
  });
}

export function preparationResult({ command, outcome, generationId = null, artifactId = null, sourceDigest = null, reasonCode = null, safeDetail = null, reservedCents = 0, actualCents = null } = {}) {
  if (!command || command.schema_version !== PREPARATION_COMMAND_SCHEMA || !OUTCOMES.has(outcome)) throw Object.assign(new TypeError("A preparation result requires a valid preparation command and outcome."), { code: "prepare_result_invalid" });
  const reserved = Math.max(0, Math.min(200, Math.ceil(Number(reservedCents) || 0)));
  const actual = actualCents == null ? null : Math.max(0, Math.min(200, Math.ceil(Number(actualCents) || 0)));
  return deepFreeze({ schema_version: PREPARATION_RESULT_SCHEMA, command_id: command.command_id, outcome, generation_id: clean(generationId, 200) || null, artifact_id: clean(artifactId, 200) || null,
    source_digest: /^[a-f0-9]{64}$/u.test(String(sourceDigest || "")) ? sourceDigest : null, reason_code: clean(reasonCode, 120) || null, safe_detail: clean(safeDetail, 500) || null,
    cost: Object.freeze({ reserved_cents: reserved, actual_cents: actual, outcome_uncertain: outcome === "uncertain" }),
  });
}
