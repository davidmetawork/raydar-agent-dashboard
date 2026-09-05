import { paraformCandidateProfileUrl } from "./paraform-links.mjs";

export const REVIEW_REASONS = Object.freeze({
  candidate_not_found: { label: "Candidate is missing in Paraform", action: "Add in Paraform, then Recheck" },
  candidate_ambiguous: { label: "More than one Paraform candidate matches", action: "Select candidate" },
  reply_unclear_or_conditional: { label: "Reply is unclear, conditional, or conflicting", action: "Review Signal" },
  candidate_question: { label: "Candidate asked a question", action: "Review Signal" },
  role_unclear: { label: "Exact offered role is unclear", action: "Select role(s)" },
  role_unavailable: { label: "Role is inactive or missing", action: "Inspect role" },
  candidate_original_resume_missing: { label: "Candidate-original resume is missing or unreadable", action: "Add resume in Paraform, then Recheck" },
  classification_failed: { label: "Both approved classifier paths failed", action: "Retry classification" },
  resume_preparation_failed: { label: "Resume preparation exhausted safe recovery", action: "Retry preparation" },
});

const text = (value, limit = 1_000) => String(value ?? "").trim().slice(0, limit);
const ACTIVE_GENERATION_STATES = new Set([
  "queued", "collecting", "extracting", "strategizing", "validating", "rendering", "archiving",
]);

export const gmailSignalUrl = (value) => /^https:\/\/mail\.google\.com\/mail\/\?authuser=david%40raydar\.xyz#all\/[a-f0-9]{1,64}$/iu.test(String(value || "")) ? value : null;

export function safeHttps(value, allowedHosts = []) {
  const raw = text(value, 2_000);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    if (allowedHosts.length && !allowedHosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) return null;
    return url.href;
  } catch { return null; }
}

function reasons(values = []) {
  return values.map((raw) => {
    const code = text(raw?.reason_code || raw?.code || raw, 100);
    const known = REVIEW_REASONS[code];
    if (!known) return null;
    return { code, label: known.label, detail: text(raw?.safe_detail || raw?.detail, 500) || null, action: known.action };
  }).filter(Boolean);
}

function admissionSource(row, signalUrl) {
  const emailLabels = {
    para_ai_interview_request: "Interview Request reply",
    new_match: "New Match reply",
    fit_follow_up_with_matches: "Fit Follow Up reply",
    paraform_sequence_reply: "Sequence reply",
  };
  let label = "Candidate signal";
  if (row.source_family === "curated") {
    label = row.decisive_status === "APPLIED_TO_ROLE" ? "Curated List interest"
      : row.decisive_status === "NOT_INTERESTED" ? "Curated List decline" : "Curated List response";
  } else if (row.source_family === "email") {
    label = Object.hasOwn(emailLabels, row.email_source_family) ? emailLabels[row.email_source_family] : "Email reply";
  } else if (row.source_family === "manual") label = "Added by recruiter";
  return { label, url: signalUrl };
}

export function rowDto(row) {
  const reviewReasons = reasons(row.review_reasons || []);
  const first = reviewReasons[0];
  const signalUrl = gmailSignalUrl(row.signal_url) || safeHttps(row.signal_url, ["monitor.raydar.xyz", "paraform.com"]);
  const workflowState = row.workflow_state || "needs_review";
  const generationStatus = text(row.generation_status, 100).toLowerCase() || null;
  const artifactReady = row.artifact_ready === true;
  const currentArtifactId = artifactReady ? row.current_artifact_id || null : null;
  const submissionStatus = row.submission_status || "none";
  const identifiedPair = Boolean((row.pair_id || row.case_id) && row.candidate_user_id && row.role_id);
  const readyWorkflow = workflowState === "interested";
  const generationActive = ACTIVE_GENERATION_STATES.has(generationStatus);
  return {
    case_id: row.pair_id || row.case_id || null,
    signal_id: row.signal_id || null,
    state_version: Number(row.state_version || 0),
    candidate_id: row.candidate_user_id || null,
    candidate_name: text(row.candidate_name, 500) || null,
    provisional_name: text(row.provisional_name, 500) || null,
    candidate_url: paraformCandidateProfileUrl(row.candidate_user_id),
    linkedin_url: safeHttps(row.linkedin_url, ["linkedin.com"]),
    raydar_url: safeHttps(row.raydar_url, ["monitor.raydar.xyz"]),
    role_id: row.role_id || null,
    company: text(row.company_name || row.company, 500) || null,
    role_title: text(row.role_title, 500) || null,
    role_label: text(row.role_label, 1_000) || null,
    role_url: safeHttps(row.role_url, ["paraform.com"]),
    offered_role_count: Number(row.offered_role_count || 0),
    offered_roles: (Array.isArray(row.offered_roles) ? row.offered_roles : []).map((offered) => ({
      role_id: text(offered?.role_id, 200),
      company: text(offered?.company, 500) || null,
      title: text(offered?.title, 500) || null,
      url: safeHttps(offered?.url, ["paraform.com"]),
    })).filter((offered) => offered.role_id),
    signal_url: signalUrl,
    admission_source: admissionSource(row, signalUrl),
    signal_at: row.signal_at || null,
    workflow_state: workflowState,
    review_reasons: reviewReasons,
    primary_action_label: first?.action || null,
    resume_cautions: (row.resume_cautions || []).map((item) => ({ code: text(item.code || item.source_key || item, 100), label: text(item.label || item.safe_detail || item, 300), impact: text(item.impact, 300) || null })),
    generation_status: generationStatus,
    generation_stage: text(row.generation_stage, 100) || null,
    preparation_error_code: text(row.preparation_error_code, 100) || null,
    preparation_error_detail: text(row.preparation_error_detail, 500) || null,
    current_artifact_id: currentArtifactId,
    artifact_version: Number(row.artifact_version || 0) || null,
    artifact_ready: artifactReady,
    submission_status: submissionStatus,
    negative_reason: text(row.negative_reason, 500) || null,
    corrected_destination: row.corrected_destination || null,
    role_active: row.role_active === true,
    role_last_confirmed_at: row.role_last_confirmed_at || null,
    source_last_success_at: row.source_last_success_at || null,
    capabilities: {
      can_correct: identifiedPair && submissionStatus !== "proven",
      can_duplicate: identifiedPair,
      can_download: readyWorkflow && artifactReady,
      can_regenerate: readyWorkflow && artifactReady && !generationActive,
      can_submit: readyWorkflow && artifactReady && row.role_active === true && submissionStatus !== "proven",
    },
  };
}

function safeInstant(value) {
  if (value == null || value === "" || typeof value === "boolean") return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : null;
}

const nullableBoolean = (value) => typeof value === "boolean" ? value : null;

export function publicHealth(row = {}) {
  const sources = Object.fromEntries(Object.entries(row.sources || {}).map(([rawKey, source]) => {
    const key = text(rawKey, 100);
    return [key, {
      enabled: source?.enabled === true,
      delayed: Boolean(source?.delayed_since || source?.error_class),
      last_success_at: source?.last_success_at || null,
      delayed_since: source?.delayed_since || null,
      quota_state: text(source?.quota_state, 100) || null,
      error_class: text(source?.error_class, 100) || null,
      safe_error_detail: text(source?.safe_error_detail, 500) || null,
      retry_at: safeInstant(source?.quota_retry_at),
      last_complete_at: safeInstant(source?.last_complete_at),
      coverage: {
        live_through: safeInstant(source?.coverage?.live_through),
        history_through: safeInstant(source?.coverage?.history_through),
        live_caught_up: nullableBoolean(source?.coverage?.live_caught_up),
        history_caught_up: nullableBoolean(source?.coverage?.history_caught_up),
        cache_confirmed_through: safeInstant(source?.coverage?.cache_confirmed_through),
        caught_up: nullableBoolean(source?.coverage?.caught_up),
      },
    }];
  }).filter(([key]) => key));
  return {
    delayed: Boolean(row.delayed),
    last_success_at: row.last_success_at || null,
    database: row.database || "current",
    sources,
  };
}
