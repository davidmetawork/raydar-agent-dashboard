const ACTIVE_GENERATION_STATUSES = new Set([
  "queued", "collecting", "extracting", "strategizing", "validating", "rendering", "archiving",
]);

export function commandConflictResolution({ status, code } = {}) {
  if (Number(status) !== 409 || code !== "stale_pair_version") return { refresh: false };
  return {
    refresh: true,
    code: "state_conflict_refreshed",
    message: "This item changed, so the latest version was refreshed; please try again.",
  };
}

export function commandSuccessMessage(result) {
  if (result?.duplicate === true) return "Already recorded; review item resolved.";
  if (result?.outcome === "dismissed" && result?.destination === "removed_from_review") return "Removed from Needs Review.";
  return "";
}

export function admissionSourcePresentation(source = {}) {
  const label = typeof source?.label === "string" ? source.label.trim().slice(0, 160) : "";
  const url = typeof source?.url === "string" ? source.url.trim() : "";
  return { label, url };
}

export function reviewContextPresentation(context = {}) {
  const available = context?.evidence_status === "available";
  const excerptPoints = available && typeof context.candidate_reply_excerpt === "string"
    ? Array.from(context.candidate_reply_excerpt.trim())
    : [];
  const excerpt = excerptPoints.slice(0, 1200).join("");
  const outboundPoints = typeof context?.outbound_offer_excerpt === "string"
    ? Array.from(context.outbound_offer_excerpt.trim())
    : [];
  const outboundOffer = outboundPoints.slice(0, 2400).join("");
  const offeredRoles = Array.isArray(context?.offered_roles) ? context.offered_roles.flatMap((role) => {
    if (!role || typeof role !== "object") return [];
    const roleId = typeof role.role_id === "string" ? role.role_id.trim().slice(0, 200) : "";
    if (!roleId) return [];
    return [{
      roleId,
      company: typeof role.company === "string" ? role.company.trim().slice(0, 300) : "",
      title: typeof role.title === "string" ? role.title.trim().slice(0, 500) : "",
    }];
  }).slice(0, 30) : [];
  return {
    available: Boolean(available && excerpt),
    excerpt,
    excerptTruncated: Boolean(context?.excerpt_truncated) || excerptPoints.length > 1200,
    sourceLabel: typeof context?.source_label === "string" ? context.source_label.trim().slice(0, 160) : "",
    sourceFamily: typeof context?.source_family === "string" ? context.source_family.trim().slice(0, 80) : "",
    receivedAt: typeof context?.received_at === "string" ? context.received_at : "",
    outboundOffer,
    outboundOfferTruncated: Boolean(context?.outbound_offer_truncated) || outboundPoints.length > 2400,
    offeredRoles,
  };
}

const HEALTH_SOURCE_LABELS = Object.freeze({
  master_inbox: "Gmail",
  sequence_inbox: "Sequence Inbox",
  candidate_index: "Candidate index",
  role_index: "Role index",
  curated: "Curated candidates",
  submission_proof: "Submission proof",
});

function safeHealthInstant(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

export function healthCoverageDetails(sources = {}) {
  return Object.entries(sources || {}).flatMap(([key, source]) => {
    if (!source || typeof source !== "object") return [];
    const coverage = source.coverage && typeof source.coverage === "object" ? source.coverage : {};
    return [{
      key,
      label: HEALTH_SOURCE_LABELS[key] || key.replace(/[_-]+/g, " "),
      enabled: source.enabled === true,
      delayed: source.delayed === true,
      safeErrorDetail: typeof source.safe_error_detail === "string" ? Array.from(source.safe_error_detail.trim()).slice(0, 500).join("") : "",
      lastCompleteAt: safeHealthInstant(source.last_complete_at),
      retryAt: safeHealthInstant(source.retry_at),
      liveThrough: safeHealthInstant(coverage.live_through),
      historyThrough: safeHealthInstant(coverage.history_through),
      liveCaughtUp: typeof coverage.live_caught_up === "boolean" ? coverage.live_caught_up : null,
      historyCaughtUp: typeof coverage.history_caught_up === "boolean" ? coverage.history_caught_up : null,
      cacheConfirmedThrough: safeHealthInstant(coverage.cache_confirmed_through),
      caughtUp: typeof coverage.caught_up === "boolean" ? coverage.caught_up : null,
    }];
  });
}

export function reviewContextCanRender({ request, currentRequest, active, currentActive, modalOpen } = {}) {
  return request === currentRequest && active === currentActive && modalOpen === true;
}

export function listScopeIsCurrent(scope, state) {
  return scope.sequence === state.listSequence && scope.page === state.page && scope.query === state.query;
}

export function listFailureDisposition({ scope, state, append = false, refresh = false }) {
  if (!listScopeIsCurrent(scope, state)) return "ignore";
  return (append || refresh) && state.rows.length > 0 ? "preserve" : "empty";
}

export function reconcileListPages({ pages, append = false, currentRows = [] }) {
  const rows = append ? [...currentRows] : [];
  const seen = new Set(rows.map((row) => String(row.case_id || row.signal_id || "")));
  for (const page of pages) {
    for (const row of page.rows || []) {
      const id = String(row.case_id || row.signal_id || "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      rows.push(row);
    }
  }
  const last = pages.at(-1) || {};
  const reportedTotal = Number(last.total_count ?? last.total ?? last.count);
  return {
    rows,
    nextCursor: last.next_cursor || null,
    totalCount: Number.isFinite(reportedTotal) ? reportedTotal : (last.next_cursor ? null : rows.length),
  };
}

export function resumeUiState(row = {}) {
  const status = String(row.generation_status || "").toLowerCase();
  const hasArtifact = Boolean(row.current_artifact_id);
  if (row.submission_status === "proven" && row.workflow_state === "needs_review") {
    return { hasArtifact, preparing: false, generating: false, status };
  }
  const preparing = row.workflow_state === "preparing_resume" || (!hasArtifact && ACTIVE_GENERATION_STATUSES.has(status));
  return {
    hasArtifact,
    preparing,
    generating: ACTIVE_GENERATION_STATUSES.has(status),
    status,
  };
}

const GENERATION_STAGE_LABELS = Object.freeze({
  queued: "Queued",
  collecting: "Collecting resume evidence",
  extracting: "Checking resume details",
  strategizing: "Planning the role-specific resume",
  validating: "Validating the resume",
  rendering: "Rendering the resume",
  archiving: "Finalizing the resume",
  failed: "Preparation failed",
  cancelled: "Preparation cancelled",
  held: "Preparation paused",
});

function safeProgressText(value, limit = 360) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function safeProgressInstant(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : "";
}

export function reviewProgressPresentation(row = {}) {
  const status = safeProgressText(row.generation_status, 80).toLowerCase();
  const stage = safeProgressText(row.generation_stage, 120);
  return {
    active: ACTIVE_GENERATION_STATUSES.has(status),
    status,
    statusLabel: GENERATION_STAGE_LABELS[status] || (status ? "Resume preparation is running" : "Resume preparation status unavailable"),
    stage: stage || status,
    detail: safeProgressText(row.preparation_error_detail),
    updatedAt: safeProgressInstant(row.generation_updated_at),
    deadlineAt: safeProgressInstant(row.generation_deadline_at || row.deadline_at),
  };
}

const REVIEW_ACTION_FALLBACKS = Object.freeze({
  candidate_not_found: "Match candidate",
  candidate_ambiguous: "Select candidate",
  reply_unclear_or_conditional: "Review Signal",
  candidate_question: "Review Signal",
  role_unclear: "Select role",
  role_unavailable: "Recheck role",
  candidate_original_resume_missing: "Add resume, then Recheck",
  classification_failed: "Retry classification",
  resume_preparation_failed: "Retry preparation",
});

const REVIEW_REASON_LABELS = Object.freeze({
  candidate_not_found: "Candidate missing",
  candidate_ambiguous: "Candidate match unclear",
  reply_unclear_or_conditional: "Reply needs review",
  candidate_question: "Candidate question",
  role_unclear: "Role unclear",
  role_unavailable: "Role unavailable",
  candidate_original_resume_missing: "Original resume missing",
  classification_failed: "Classification failed",
  resume_preparation_failed: "Resume preparation failed",
});

export function reviewRowPresentation(row = {}) {
  const reasons = Array.isArray(row.review_reasons) ? row.review_reasons.filter((reason) => reason && typeof reason === "object") : [];
  const first = reasons[0] || {};
  const code = typeof first.code === "string" ? first.code : "";
  const label = REVIEW_REASON_LABELS[code] || (typeof first.label === "string" && first.label.trim() ? first.label.trim().slice(0, 160) : "Review needed");
  const detail = typeof first.detail === "string" && first.detail.trim()
    ? first.detail.trim().slice(0, 360)
    : "Review the verified source before deciding what to do next.";
  const suppliedAction = typeof row.primary_action_label === "string" ? row.primary_action_label.trim().slice(0, 160) : "";
  return {
    label,
    detail,
    action: suppliedAction || REVIEW_ACTION_FALLBACKS[code] || "Review Signal",
    additionalReasons: Math.max(0, reasons.length - 1),
    reasonCount: reasons.length,
  };
}

export function navigateSubmitPopup(popup, url) {
  if (!popup || !url) {
    popup?.close();
    return false;
  }
  popup.location.replace(url);
  return true;
}
