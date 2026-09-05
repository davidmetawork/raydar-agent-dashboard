const VERSION = "raydar.submissions-v2.pair-projection.v1";
const ACTIVE_PREPARATION = new Set(["queued", "collecting", "extracting", "strategizing", "validating", "rendering", "archiving"]);
const INTENTS = new Set(["unknown", "unclear", "interested", "not_interested"]);
const SUBMISSIONS = new Set(["none", "opened", "proven"]);

const clean = (value, limit = 500) => String(value ?? "").trim().slice(0, limit);
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const instant = (value) => {
  const at = new Date(value || "").getTime();
  return Number.isFinite(at) && at > 0 ? new Date(at).toISOString() : null;
};

function artifact(row) {
  const ready = row.artifact_ready === true || Boolean(row.current_artifact_id && row.current_artifact_validation_status === "passed");
  return Object.freeze({ id: ready ? clean(row.current_artifact_id, 200) || null : null, ready, version: ready && number(row.artifact_version) > 0 ? number(row.artifact_version) : null });
}

function preparation(row, currentArtifact) {
  const generationStatus = clean(row.generation_status, 80).toLowerCase();
  const errorCode = clean(row.preparation_error_code || row.generation_safe_failure_code, 120) || null;
  const errorDetail = clean(row.preparation_error_detail || row.generation_safe_failure_detail, 500) || null;
  const isActive = ACTIVE_PREPARATION.has(generationStatus);
  const initialFailure = !currentArtifact.ready && (generationStatus === "failed" || Boolean(errorCode));
  const regenerationFailure = currentArtifact.ready && (generationStatus === "failed" || Boolean(errorCode));
  return Object.freeze({
    state: isActive ? "preparing" : currentArtifact.ready ? "ready" : initialFailure ? (errorCode === "candidate_original_resume_missing" ? "blocked" : "failed") : "not_started",
    generation_id: clean(row.generation_id, 200) || null, generation_status: generationStatus || null,
    stage: clean(row.generation_stage, 100) || null, updated_at: instant(row.generation_updated_at), deadline_at: instant(row.generation_deadline_at),
    error_code: errorCode, error_detail: errorDetail, initial_failure: initialFailure, regeneration_failure: regenerationFailure,
  });
}

function history(rows) {
  if (!Array.isArray(rows)) return Object.freeze([]);
  return Object.freeze(rows.map((row) => Object.freeze({
    id: clean(row?.id, 200) || null, event_type: clean(row?.event_type, 120) || null, at: instant(row?.created_at || row?.at),
    from: Object.freeze({ intent: clean(row?.from_intent_state, 80) || null, preparation: clean(row?.from_workflow_state, 80) || null, submission: clean(row?.from_submission_status, 80) || null }),
    to: Object.freeze({ intent: clean(row?.to_intent_state, 80) || null, preparation: clean(row?.to_workflow_state, 80) || null, submission: clean(row?.to_submission_status, 80) || null }),
  })));
}

export function projectSubmissionPair(row = {}) {
  const intent = INTENTS.has(row.intent_state) ? row.intent_state : "unknown";
  const workflow = clean(row.workflow_state, 80) || "needs_review";
  const submission = SUBMISSIONS.has(row.submission_status) ? row.submission_status : "none";
  const currentArtifact = artifact(row);
  const currentPreparation = preparation(row, currentArtifact);
  const view = intent === "not_interested" ? "not_interested"
    : intent === "interested" && (workflow === "preparing_resume" || currentPreparation.state === "preparing" || (workflow === "interested" && currentPreparation.state === "ready")) ? "interested"
      : "needs_review";
  const identified = Boolean(row.pair_id || row.case_id || row.id) && Boolean(row.candidate_user_id) && Boolean(row.role_id);
  const readyWorkflow = workflow === "interested";
  const active = currentPreparation.state === "preparing";
  const submitEligible = readyWorkflow && currentArtifact.ready && row.role_active === true && submission !== "proven";
  return Object.freeze({
    schema_version: VERSION, pair_id: clean(row.pair_id || row.case_id || row.id, 200) || null,
    candidate_id: clean(row.candidate_user_id, 200) || null, role_id: clean(row.role_id, 200) || null, state_version: number(row.state_version),
    intent: Object.freeze({ state: intent, decision_revision: number(row.decision_revision) || null, first_signal_id: clean(row.first_signal_id || row.signal_id, 200) || null }),
    preparation: currentPreparation, artifact: currentArtifact,
    submission: Object.freeze({ state: submission, proof_id: clean(row.submission_proof_id, 200) || null, checked_at: instant(row.submission_checked_at || row.proof_checked_at) }),
    view,
    capabilities: Object.freeze({
      navigate_source: Boolean(clean(row.signal_url, 2_000)), navigate_candidate: Boolean(clean(row.candidate_user_id, 200)), navigate_role: Boolean(clean(row.role_url, 2_000) || clean(row.role_id, 200)),
      correct_intent: identified && submission !== "proven", duplicate_pair: identified,
      retry_preparation: (readyWorkflow || (submission === "proven" && workflow === "needs_review" && intent === "interested")) && currentArtifact.ready && !active,
      download_artifact: currentArtifact.ready && (readyWorkflow || submission === "proven"),
      open_submission_destination: submitEligible, mark_submitted: false,
    }), history: history(row.history || row.pair_events),
  });
}

export function projectSubmissionCounts(rows = []) {
  const projected = Array.isArray(rows) ? rows.map(projectSubmissionPair) : [];
  return Object.freeze({ schema_version: VERSION, interested: projected.filter((row) => row.view === "interested").length, needs_review: projected.filter((row) => row.view === "needs_review").length, not_interested: projected.filter((row) => row.view === "not_interested").length, total: projected.length });
}

export const projectionInternals = Object.freeze({ ACTIVE_PREPARATION, artifact, preparation });
