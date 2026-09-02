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

export const gmailSignalUrl = (value) => /^https:\/\/mail\.google\.com\/mail\/\?authuser=david%40raydar\.xyz#all\/[a-f0-9]{1,64}$/iu.test(String(value || "")) ? value : null;

export function safeHttps(value, allowedHosts = []) {
  try {
    const url = new URL(text(value, 2_000), "https://monitor.raydar.xyz");
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

export function rowDto(row) {
  const reviewReasons = reasons(row.review_reasons || []);
  const first = reviewReasons[0];
  const signalUrl = gmailSignalUrl(row.signal_url) || safeHttps(row.signal_url, ["monitor.raydar.xyz", "paraform.com"]);
  return {
    case_id: row.pair_id || row.case_id || null,
    signal_id: row.signal_id || null,
    state_version: Number(row.state_version || 0),
    candidate_id: row.candidate_user_id || null,
    candidate_name: text(row.candidate_name, 500) || null,
    provisional_name: text(row.provisional_name, 500) || null,
    candidate_url: safeHttps(row.candidate_url, ["paraform.com"]),
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
    signal_at: row.signal_at || null,
    workflow_state: row.workflow_state || "needs_review",
    review_reasons: reviewReasons,
    primary_action_label: first?.action || null,
    resume_cautions: (row.resume_cautions || []).map((item) => ({ code: text(item.code || item.source_key || item, 100), label: text(item.label || item.safe_detail || item, 300), impact: text(item.impact, 300) || null })),
    generation_status: row.generation_status || null,
    current_artifact_id: row.current_artifact_id || null,
    artifact_version: Number(row.artifact_version || 0) || null,
    submission_status: row.submission_status || "none",
    negative_reason: text(row.negative_reason, 500) || null,
    corrected_destination: row.corrected_destination || null,
    role_last_confirmed_at: row.role_last_confirmed_at || null,
    source_last_success_at: row.source_last_success_at || null,
  };
}

export function publicHealth(row = {}) {
  return {
    delayed: Boolean(row.delayed),
    last_success_at: row.last_success_at || null,
    database: row.database || "current",
  };
}
