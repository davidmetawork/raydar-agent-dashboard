// Shared, side-effect-free domain rules for the Sourcing workspace.
// This file is intentionally browser-safe: the local review lab and serverless
// API use the exact same feedback taxonomy and state transitions.

const text = (value) => String(value ?? "").trim();
const rows = (value) => Array.isArray(value) ? value : [];
const ID = /^[a-zA-Z0-9_-]{6,100}$/;

export const FEEDBACK_REASONS = Object.freeze([
  { id: "wrong_title", label: "Wrong function or title" },
  { id: "too_junior", label: "Too junior" },
  { id: "too_senior", label: "Too senior" },
  { id: "wrong_industry", label: "Wrong industry" },
  { id: "weak_company", label: "Company background misses" },
  { id: "missing_skill", label: "Missing must-have skill" },
  { id: "location", label: "Location mismatch" },
  { id: "job_hopper", label: "Tenure pattern misses" },
  { id: "duplicate_or_known", label: "Duplicate or already known" },
  { id: "other", label: "Other" },
]);

const REASON_LABELS = new Map(FEEDBACK_REASONS.map((reason) => [reason.id, reason.label]));

export const CANDIDATE_STATES = Object.freeze([
  "discovered",
  "dedup_blocked",
  "in_review",
  "good",
  "maybe",
  "bad",
  "project_queued",
  "project_filed",
  "enrollment_queued",
  "enrollment_blocked",
  "enrolled",
]);

export const RUN_STATES = Object.freeze(["draft", "ready", "running", "review", "complete", "failed", "cancelled"]);

const RUN_TRANSITIONS = Object.freeze({
  draft: ["ready", "cancelled"],
  ready: ["running", "cancelled"],
  running: ["review", "failed", "cancelled"],
  review: ["running", "complete", "cancelled"],
  failed: ["ready", "cancelled"],
  complete: [],
  cancelled: [],
});

const TRANSITIONS = Object.freeze({
  discovered: ["dedup_blocked", "in_review"],
  dedup_blocked: [],
  in_review: ["good", "maybe", "bad"],
  good: ["in_review", "maybe", "bad", "project_queued"],
  maybe: ["in_review", "good", "bad"],
  bad: ["in_review", "good", "maybe"],
  project_queued: ["project_filed", "enrollment_blocked"],
  project_filed: ["enrollment_queued", "enrollment_blocked"],
  enrollment_queued: ["enrolled", "enrollment_blocked"],
  enrollment_blocked: ["in_review", "project_filed"],
  enrolled: [],
});

export function transitionCandidate(candidate, nextState, evidence = {}) {
  const current = text(candidate?.state);
  if (!CANDIDATE_STATES.includes(current)) throw new Error(`unknown candidate state: ${current || "empty"}`);
  if (!CANDIDATE_STATES.includes(nextState)) throw new Error(`unknown candidate state: ${nextState}`);
  if (!TRANSITIONS[current].includes(nextState)) throw new Error(`invalid candidate transition: ${current} -> ${nextState}`);
  return {
    ...candidate,
    state: nextState,
    lastTransition: { from: current, to: nextState, ...evidence },
  };
}

export function transitionRun(run, nextState, evidence = {}) {
  const current = text(run?.state);
  if (!RUN_STATES.includes(current)) throw new Error(`unknown run state: ${current || "empty"}`);
  if (!RUN_STATES.includes(nextState)) throw new Error(`unknown run state: ${nextState}`);
  if (!RUN_TRANSITIONS[current].includes(nextState)) throw new Error(`invalid run transition: ${current} -> ${nextState}`);
  return { ...run, state: nextState, lastTransition: { from: current, to: nextState, ...evidence } };
}

export function dedupeResults(candidates = [], evidence = {}) {
  const priorRole = new Set(rows(evidence.seenCandidateIds).map(text));
  const enrolled = new Set(rows(evidence.enrolledCandidateUserIds).map(text));
  const booked = new Set(rows(evidence.bookedCandidateUserIds).map(text));
  const inRun = new Set();
  const accepted = [];
  const blocked = [];
  for (const candidate of rows(candidates)) {
    const candidateId = text(candidate?.candidateId || candidate?.id);
    const candidateUserId = text(candidate?.candidateUserId);
    if (!candidateId) throw new Error("every result requires a candidateId");
    let reason = null;
    if (inRun.has(candidateId)) reason = "duplicate_in_run";
    else if (priorRole.has(candidateId)) reason = "seen_for_role";
    else if (candidateUserId && booked.has(candidateUserId)) reason = "booked_or_later";
    else if (candidateUserId && enrolled.has(candidateUserId)) reason = "already_in_sequence";
    inRun.add(candidateId);
    const normalized = { ...candidate, candidateId };
    if (reason) blocked.push({ ...normalized, state: "dedup_blocked", dedupReason: reason });
    else accepted.push({ ...normalized, state: "in_review", dedupReason: null });
  }
  return { accepted, blocked };
}

export function validateFeedback(input = {}) {
  const verdict = text(input.verdict).toLowerCase();
  if (!["good", "maybe", "bad"].includes(verdict)) throw new Error("verdict must be good, maybe, or bad");
  const reason = text(input.reason);
  if (verdict === "bad" && !REASON_LABELS.has(reason)) throw new Error("bad feedback requires a structured reason");
  if (verdict !== "bad" && reason) throw new Error("only bad feedback carries a rejection reason");
  return {
    verdict,
    reason: verdict === "bad" ? reason : null,
    note: text(input.note).slice(0, 1000) || null,
  };
}

export function applyFeedback(candidate, input = {}) {
  const feedback = validateFeedback(input);
  const base = candidate?.state === "discovered"
    ? transitionCandidate(candidate, "in_review", { source: "review" })
    : ["good", "maybe", "bad"].includes(candidate?.state)
      ? transitionCandidate(candidate, "in_review", { source: "relabel" })
      : candidate;
  const next = transitionCandidate(base, feedback.verdict, { source: "feedback", reason: feedback.reason });
  return { ...next, feedback };
}

export function summarizeFeedback(items = []) {
  const summary = { total: 0, good: 0, maybe: 0, bad: 0, unreviewed: 0, reasons: [] };
  const counts = new Map();
  for (const item of rows(items)) {
    const verdict = ["good", "maybe", "bad"].includes(item?.verdict) ? item.verdict : "unreviewed";
    summary.total++;
    summary[verdict]++;
    if (verdict === "bad" && REASON_LABELS.has(item?.reason)) {
      counts.set(item.reason, (counts.get(item.reason) || 0) + 1);
    }
  }
  summary.reasons = [...counts.entries()]
    .map(([id, count]) => ({ id, label: REASON_LABELS.get(id), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return summary;
}

export function proposeNextRun(items = [], minimumEvidence = 2) {
  const summary = summarizeFeedback(items);
  const proposals = [];
  for (const reason of summary.reasons) {
    if (reason.count < minimumEvidence) continue;
    const action = {
      wrong_title: "Tighten target titles and add the rejected title family to exclusions.",
      too_junior: "Raise minimum years of experience or require a stronger seniority title.",
      too_senior: "Lower maximum years of experience or exclude leadership titles.",
      wrong_industry: "Add industry or ideal-company constraints; exclude the repeated off-target sector.",
      weak_company: "Strengthen the ideal-company lane or talent-density requirement.",
      missing_skill: "Promote the repeated missing capability to a required skill filter.",
      location: "Tighten included locations and explicitly exclude the repeated mismatch.",
      job_hopper: "Increase minimum time in current role or add a tenure requirement.",
      duplicate_or_known: "Expand the pre-search dedup set; do not change fit filters for duplicates.",
      other: "Review the notes and turn any repeated pattern into a named reason before rerunning.",
    }[reason.id];
    proposals.push({
      reason: reason.id,
      evidence: reason.count,
      scope: reason.id === "duplicate_or_known" ? "dedup" : "rubric",
      action,
    });
  }
  return { summary, proposals, autoApply: false };
}

export function validateRoleMapping(mapping = {}) {
  const value = {
    roleId: text(mapping.roleId),
    reviewProjectId: text(mapping.reviewProjectId),
    sequenceId: text(mapping.sequenceId) || null,
    rubricVersionId: text(mapping.rubricVersionId) || null,
  };
  if (!ID.test(value.roleId)) throw new Error("valid roleId required");
  if (!ID.test(value.reviewProjectId)) throw new Error("valid reviewProjectId required");
  if (value.sequenceId && !ID.test(value.sequenceId)) throw new Error("invalid sequenceId");
  if (value.rubricVersionId && !ID.test(value.rubricVersionId)) throw new Error("invalid rubricVersionId");
  return value;
}

export function buildRunPlan({ runId, mapping, rubricVersionId, lanes = [], candidateCap = 100 } = {}) {
  const role = validateRoleMapping({ ...mapping, rubricVersionId: rubricVersionId || mapping?.rubricVersionId });
  const id = text(runId);
  if (!ID.test(id)) throw new Error("valid runId required");
  if (!role.rubricVersionId) throw new Error("rubricVersionId required");
  const cap = Number(candidateCap);
  if (!Number.isInteger(cap) || cap < 1 || cap > 500) throw new Error("candidateCap must be an integer from 1 to 500");
  const normalizedLanes = rows(lanes).map((lane, index) => ({
    id: text(lane?.id) || `lane-${index + 1}`,
    rationale: text(lane?.rationale).slice(0, 1200),
    filters: lane?.filters && typeof lane.filters === "object" ? lane.filters : {},
  }));
  if (!normalizedLanes.length || normalizedLanes.length > 8) throw new Error("one to eight search lanes required");
  return {
    id,
    roleId: role.roleId,
    reviewProjectId: role.reviewProjectId,
    sequenceId: role.sequenceId,
    rubricVersionId: role.rubricVersionId,
    candidateCap: cap,
    lanes: normalizedLanes,
    state: "draft",
    writesEnabled: false,
  };
}

export function actionIdempotencyKey({ runId, candidateId, action } = {}) {
  const values = [runId, candidateId, action].map(text);
  if (values.some((value) => !ID.test(value))) throw new Error("runId, candidateId, and action must be stable IDs");
  return `sourcing:${values.join(":")}`;
}
