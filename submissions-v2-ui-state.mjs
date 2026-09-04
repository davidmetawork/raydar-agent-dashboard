const ACTIVE_GENERATION_STATUSES = new Set([
  "queued", "collecting", "extracting", "strategizing", "validating", "rendering", "archiving",
]);

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
