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
  return result?.duplicate === true ? "Already recorded; review item resolved." : "";
}

export function reviewContextPresentation(context = {}) {
  const available = context?.evidence_status === "available";
  const excerptPoints = available && typeof context.candidate_reply_excerpt === "string"
    ? Array.from(context.candidate_reply_excerpt.trim())
    : [];
  const excerpt = excerptPoints.slice(0, 1200).join("");
  return {
    available: Boolean(available && excerpt),
    excerpt,
    excerptTruncated: Boolean(context?.excerpt_truncated) || excerptPoints.length > 1200,
    sourceLabel: typeof context?.source_label === "string" ? context.source_label.trim().slice(0, 160) : "",
    sourceFamily: typeof context?.source_family === "string" ? context.source_family.trim().slice(0, 80) : "",
    receivedAt: typeof context?.received_at === "string" ? context.received_at : "",
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
  const preparing = row.workflow_state === "preparing_resume" || (!hasArtifact && ACTIVE_GENERATION_STATUSES.has(status));
  return {
    hasArtifact,
    preparing,
    generating: ACTIVE_GENERATION_STATUSES.has(status),
    status,
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
