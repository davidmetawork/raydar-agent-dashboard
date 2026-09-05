export const INTENT_STATES = Object.freeze([
  "unknown",
  "unclear",
  "interested",
  "not_interested",
]);

export const WORKFLOW_STATES = Object.freeze([
  "classifying",
  "preparing_resume",
  "interested",
  "needs_review",
  "not_interested",
]);

export const SUBMISSION_STATUSES = Object.freeze(["none", "opened", "proven"]);

export const INTERESTED_PAGE_WORKFLOW_STATES = Object.freeze([
  "preparing_resume",
  "interested",
]);

const WORKFLOW_TRANSITIONS = Object.freeze({
  classifying: new Set(["classifying", "preparing_resume", "needs_review", "not_interested"]),
  preparing_resume: new Set(["preparing_resume", "interested", "needs_review", "not_interested"]),
  interested: new Set(["interested", "needs_review", "not_interested"]),
  needs_review: new Set(["needs_review", "preparing_resume", "interested", "not_interested"]),
  not_interested: new Set(["not_interested", "preparing_resume", "needs_review"]),
});

const SUBMISSION_TRANSITIONS = Object.freeze({
  none: new Set(["none", "opened", "proven"]),
  opened: new Set(["opened", "proven"]),
  proven: new Set(["proven"]),
});

export class PairStateError extends Error {
  constructor(code, message, current = null) {
    super(message);
    this.name = "PairStateError";
    this.code = code;
    this.status = code === "stale_pair_version" || code === "invalid_pair_transition" ? 409 : 422;
    if (current) this.current = current;
  }
}

function member(value, values, label) {
  if (!values.includes(value)) {
    throw new PairStateError("invalid_pair_state", `${label} is invalid`);
  }
}

function hasArtifact(state) {
  return Boolean(state.current_artifact_id || state.currentArtifactId);
}

function hasResumeReadyAt(state) {
  return Boolean(state.resume_ready_at || state.resumeReadyAt);
}

function value(state, snake, camel) {
  return state[snake] ?? state[camel];
}

export function assertPairState(state) {
  const intent = value(state, "intent_state", "intentState");
  const workflow = value(state, "workflow_state", "workflowState");
  const submission = value(state, "submission_status", "submissionStatus") || "none";
  member(intent, INTENT_STATES, "intent_state");
  member(workflow, WORKFLOW_STATES, "workflow_state");
  member(submission, SUBMISSION_STATUSES, "submission_status");

  if (workflow === "classifying" && intent !== "unknown") {
    throw new PairStateError("invalid_pair_state", "classifying requires unknown intent");
  }
  if (workflow === "preparing_resume" && intent !== "interested") {
    throw new PairStateError("invalid_pair_state", "preparing_resume requires interested intent");
  }
  if (workflow === "interested" && intent !== "interested") {
    throw new PairStateError("invalid_pair_state", "interested workflow requires interested intent");
  }
  if (workflow === "interested" && (!hasArtifact(state) || !hasResumeReadyAt(state))) {
    throw new PairStateError("invalid_pair_state", "interested requires a current artifact and resume_ready_at");
  }
  if (workflow === "not_interested" && intent !== "not_interested") {
    throw new PairStateError("invalid_pair_state", "not_interested workflow requires negative intent");
  }
  if (workflow === "needs_review" && intent === "not_interested") {
    throw new PairStateError("invalid_pair_state", "needs_review cannot retain negative intent");
  }
  if (submission === "proven"
    && !((intent === "interested" && ["preparing_resume", "interested", "needs_review"].includes(workflow))
      || (intent === "unclear" && workflow === "needs_review"))) {
    throw new PairStateError("invalid_pair_state", "proven submission must preserve the independently recorded candidate intent");
  }
  return state;
}

export function assertPairTransition(current, next, expectedVersion) {
  assertPairState(current);
  assertPairState(next);
  const currentVersion = Number(value(current, "state_version", "stateVersion"));
  const nextVersion = Number(value(next, "state_version", "stateVersion"));
  if (!Number.isInteger(currentVersion) || currentVersion < 1) {
    throw new PairStateError("invalid_pair_state", "current state_version is invalid");
  }
  if (Number(expectedVersion) !== currentVersion) {
    throw new PairStateError("stale_pair_version", "The pair changed before this action was committed", current);
  }
  if (nextVersion !== currentVersion + 1) {
    throw new PairStateError("invalid_pair_transition", "state_version must increase by exactly one", current);
  }

  const currentWorkflow = value(current, "workflow_state", "workflowState");
  const nextWorkflow = value(next, "workflow_state", "workflowState");
  if (!WORKFLOW_TRANSITIONS[currentWorkflow]?.has(nextWorkflow)) {
    throw new PairStateError("invalid_pair_transition", `${currentWorkflow} cannot transition to ${nextWorkflow}`, current);
  }

  const currentSubmission = value(current, "submission_status", "submissionStatus") || "none";
  const nextSubmission = value(next, "submission_status", "submissionStatus") || "none";
  if (!SUBMISSION_TRANSITIONS[currentSubmission]?.has(nextSubmission)) {
    throw new PairStateError("invalid_pair_transition", `${currentSubmission} cannot transition to ${nextSubmission}`, current);
  }
  if (currentSubmission === "proven") {
    const intentChanged = value(current, "intent_state", "intentState") !== value(next, "intent_state", "intentState");
    const proofLifecycle = {
      preparing_resume: new Set(["preparing_resume", "interested", "needs_review"]),
      needs_review: new Set(["needs_review", "preparing_resume", "interested"]),
      interested: new Set(["interested"]),
    };
    if (intentChanged || !proofLifecycle[currentWorkflow]?.has(nextWorkflow)) {
      throw new PairStateError("invalid_pair_transition", "A proven submission cannot be reclassified", current);
    }
  }
  return next;
}

export function nextPairState(current, patch, expectedVersion) {
  const currentVersion = Number(value(current, "state_version", "stateVersion"));
  const next = {
    ...current,
    ...patch,
    state_version: currentVersion + 1,
  };
  assertPairTransition(current, next, expectedVersion);
  return next;
}

export function isVisiblePair(state) {
  assertPairState(state);
  return [...INTERESTED_PAGE_WORKFLOW_STATES, "needs_review", "not_interested"].includes(
    value(state, "workflow_state", "workflowState"),
  );
}
