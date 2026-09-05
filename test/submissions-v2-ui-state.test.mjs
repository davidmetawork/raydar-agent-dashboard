import test from "node:test";
import assert from "node:assert/strict";
import { admissionSourcePresentation, commandConflictResolution, commandSuccessMessage, embeddedModalViewport, healthCoverageDetails, listFailureDisposition, listScopeIsCurrent, navigateSubmitPopup, reconcileListPages, reviewContextCanRender, reviewContextPresentation, reviewProgressPresentation, reviewRowPresentation, resumeUiState } from "../submissions-v2-ui-state.mjs";

test("only stale pair versions refresh into the retry guidance", () => {
  assert.deepEqual(commandConflictResolution({ status: 409, code: "stale_pair_version" }), {
    refresh: true,
    code: "state_conflict_refreshed",
    message: "This item changed, so the latest version was refreshed; please try again.",
  });
  assert.deepEqual(commandConflictResolution({ status: 409, code: "first_response_already_recorded" }), { refresh: false });
  assert.deepEqual(commandConflictResolution({ status: 409, code: "source_not_unresolved" }), { refresh: false });
  assert.deepEqual(commandConflictResolution({ status: 503, code: "stale_pair_version" }), { refresh: false });
});

test("duplicate review dispositions receive a recruiter-facing success message", () => {
  assert.equal(commandSuccessMessage({ duplicate: true }), "Already recorded; review item resolved.");
  assert.equal(commandSuccessMessage({ outcome: "dismissed", destination: "removed_from_review" }), "Removed from Needs Review.");
  assert.equal(commandSuccessMessage({ duplicate: false }), "");
  assert.equal(commandSuccessMessage({}), "");
});

test("admission source text and links are server-provided rather than derived from candidate identity", () => {
  assert.deepEqual(admissionSourcePresentation({ label: "Email reply", url: "https://mail.google.com/mail/u/0/#all/abc" }), {
    label: "Email reply", url: "https://mail.google.com/mail/u/0/#all/abc",
  });
  assert.deepEqual(admissionSourcePresentation({ candidate_id: "candidate-1" }), { label: "", url: "" });
});

test("review evidence only renders an explicitly available bounded excerpt", () => {
  const available = reviewContextPresentation({
    evidence_status: "available", source_label: "Gmail reply", source_family: "master inbox",
    received_at: "2026-09-04T12:00:00.000Z", candidate_reply_excerpt: "Yes\nI am interested.",
  });
  assert.equal(available.available, true);
  assert.equal(available.excerpt, "Yes\nI am interested.");
  assert.equal(available.sourceLabel, "Gmail reply");
  assert.equal(available.sourceFamily, "master inbox");
  assert.equal(available.receivedAt, "2026-09-04T12:00:00.000Z");
  const offer = reviewContextPresentation({
    outbound_offer_excerpt: "Would you like to discuss the Engineer role?",
    offered_roles: [{ role_id: "role-1", company: "Acme", title: "Engineer" }],
  });
  assert.equal(offer.outboundOffer, "Would you like to discuss the Engineer role?");
  assert.deepEqual(offer.offeredRoles, [{ roleId: "role-1", company: "Acme", title: "Engineer" }]);
  const unavailable = reviewContextPresentation({ evidence_status: "unavailable", candidate_reply_excerpt: "Do not show me" });
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.excerpt, "");
  const exact = reviewContextPresentation({ evidence_status: "available", candidate_reply_excerpt: "🙂".repeat(1200) });
  assert.equal(Array.from(exact.excerpt).length, 1200);
  assert.equal(exact.excerptTruncated, false);
  const clipped = reviewContextPresentation({ evidence_status: "available", candidate_reply_excerpt: "🙂".repeat(1201) });
  assert.equal(Array.from(clipped.excerpt).length, 1200);
  assert.equal(clipped.excerptTruncated, true);
});

test("review rows identify the next required action without exposing a reason code", () => {
  assert.deepEqual(reviewRowPresentation({
    review_reasons: [
      { code: "role_unclear", label: "Exact offered role is unclear", detail: "Confirm the exact role from the source email." },
      { code: "candidate_ambiguous", label: "More than one Paraform candidate matches" },
    ],
  }), {
    label: "Role unclear",
    detail: "Confirm the exact role from the source email.",
    action: "Select role",
    additionalReasons: 1,
    reasonCount: 2,
  });
  assert.equal(reviewRowPresentation({ review_reasons: [{ code: "classification_failed" }], primary_action_label: "Retry now" }).action, "Retry now");
});

test("an active review generation presents actual progress and blocks another retry", () => {
  assert.deepEqual(reviewProgressPresentation({
    generation_status: "strategizing", generation_stage: "strategy", generation_updated_at: "2026-09-05T03:25:00.000Z",
    generation_deadline_at: "2026-09-05T03:30:00.000Z", preparation_error_detail: "A prior attempt timed out safely.",
  }), {
    active: true,
    status: "strategizing",
    statusLabel: "Planning the role-specific resume",
    stage: "strategy",
    detail: "A prior attempt timed out safely.",
    updatedAt: "2026-09-05T03:25:00.000Z",
    deadlineAt: "2026-09-05T03:30:00.000Z",
  });
});

test("a delayed review-context response cannot replace a newer dialog or a closed modal", () => {
  const firstRequest = {}, secondRequest = {}, firstDialog = {}, secondDialog = {};
  assert.equal(reviewContextCanRender({ request: firstRequest, currentRequest: firstRequest, active: firstDialog, currentActive: firstDialog, modalOpen: true }), true);
  assert.equal(reviewContextCanRender({ request: firstRequest, currentRequest: secondRequest, active: firstDialog, currentActive: firstDialog, modalOpen: true }), false);
  assert.equal(reviewContextCanRender({ request: firstRequest, currentRequest: firstRequest, active: firstDialog, currentActive: secondDialog, modalOpen: true }), false);
  assert.equal(reviewContextCanRender({ request: firstRequest, currentRequest: firstRequest, active: firstDialog, currentActive: firstDialog, modalOpen: false }), false);
});

test("an embedded modal uses only the visible slice of a tall iframe", () => {
  assert.deepEqual(embeddedModalViewport({ frameTop: 120, frameBottom: 1620, viewportTop: 0, viewportBottom: 936 }), { top: 0, height: 816 });
  assert.deepEqual(embeddedModalViewport({ frameTop: -240, frameBottom: 1260, viewportTop: 0, viewportBottom: 936 }), { top: 240, height: 936 });
  assert.equal(embeddedModalViewport({ frameTop: 1000, frameBottom: 1500, viewportTop: 0, viewportBottom: 936 }), null);
});

test("source health details expose only committed checkpoints and an authoritative retry time", () => {
  const details = healthCoverageDetails({
    master_inbox: { enabled: true, delayed: true, safe_error_detail: "The Gmail cursor is paused.", last_complete_at: "2026-09-04T12:01:00.000Z", coverage: { live_through: "2026-09-04T12:00:00.000Z", history_through: "2026-09-03T12:00:00.000Z", live_caught_up: true, history_caught_up: false } },
    sequence_inbox: { enabled: true, delayed: false, retry_at: "2026-09-04T12:20:00.000Z", coverage: { cache_confirmed_through: "2026-09-04T11:55:00.000Z", caught_up: true } },
  });
  assert.deepEqual(details.map(({ key, label, liveThrough, historyThrough, cacheConfirmedThrough, retryAt, liveCaughtUp, historyCaughtUp, caughtUp }) => ({ key, label, liveThrough, historyThrough, cacheConfirmedThrough, retryAt, liveCaughtUp, historyCaughtUp, caughtUp })), [
    { key: "master_inbox", label: "Gmail", liveThrough: "2026-09-04T12:00:00.000Z", historyThrough: "2026-09-03T12:00:00.000Z", cacheConfirmedThrough: null, retryAt: null, liveCaughtUp: true, historyCaughtUp: false, caughtUp: null },
    { key: "sequence_inbox", label: "Sequence Inbox", liveThrough: null, historyThrough: null, cacheConfirmedThrough: "2026-09-04T11:55:00.000Z", retryAt: "2026-09-04T12:20:00.000Z", liveCaughtUp: null, historyCaughtUp: null, caughtUp: true },
  ]);
  assert.equal(details[0].safeErrorDetail, "The Gmail cursor is paused.");
});

test("a background refresh keeps all already loaded pages and removes a repeated cursor row", () => {
  const result = reconcileListPages({
    pages: [
      { rows: [{ case_id: "new" }, { case_id: "one" }], total_count: 3, next_cursor: "cursor-two" },
      { rows: [{ case_id: "two" }, { case_id: "one" }], total_count: 3, next_cursor: null },
    ],
  });
  assert.deepEqual(result.rows.map((row) => row.case_id), ["new", "one", "two"]);
  assert.equal(result.nextCursor, null);
  assert.equal(result.totalCount, 3);
});

test("loading another page appends only candidates not already displayed", () => {
  const result = reconcileListPages({
    append: true,
    currentRows: [{ case_id: "one" }],
    pages: [{ rows: [{ case_id: "one" }, { case_id: "two" }], total_count: 2, next_cursor: null }],
  });
  assert.deepEqual(result.rows.map((row) => row.case_id), ["one", "two"]);
});

test("stale refresh results cannot replace a changed page or search scope", () => {
  const scope = { sequence: 8, page: "interested", query: "Ada" };
  assert.equal(listScopeIsCurrent(scope, { listSequence: 8, page: "interested", query: "Ada" }), true);
  assert.equal(listScopeIsCurrent(scope, { listSequence: 9, page: "interested", query: "Ada" }), false);
  assert.equal(listScopeIsCurrent(scope, { listSequence: 8, page: "needs_review", query: "Ada" }), false);
  assert.equal(listScopeIsCurrent(scope, { listSequence: 8, page: "interested", query: "Grace" }), false);
});

test("a stale list failure is ignored and a load-more failure keeps the loaded candidates", () => {
  const scope = { sequence: 8, page: "interested", query: "Ada" };
  const active = { listSequence: 8, page: "interested", query: "Ada", rows: [{ case_id: "one" }] };
  assert.equal(listFailureDisposition({ scope, state: { ...active, listSequence: 9 }, refresh: true }), "ignore");
  assert.equal(listFailureDisposition({ scope, state: active, append: true }), "preserve");
  assert.equal(listFailureDisposition({ scope, state: { ...active, rows: [] } }), "empty");
});

test("preparing candidates cannot use an absent artifact while regeneration retains the prior artifact", () => {
  assert.deepEqual(resumeUiState({ workflow_state: "preparing_resume", generation_status: "rendering", current_artifact_id: null }), {
    hasArtifact: false, preparing: true, generating: true, status: "rendering",
  });
  assert.deepEqual(resumeUiState({ workflow_state: "interested", generation_status: "archiving", current_artifact_id: "artifact-1" }), {
    hasArtifact: true, preparing: false, generating: true, status: "archiving",
  });
});

test("a proven submission in review remains history instead of appearing to prepare a resume", () => {
  assert.deepEqual(resumeUiState({ workflow_state: "needs_review", submission_status: "proven", generation_status: "strategizing" }), {
    hasArtifact: false, preparing: false, generating: false, status: "strategizing",
  });
});

test("role-unavailable review rows expose a same-pair role recheck", () => {
  assert.equal(reviewRowPresentation({
    review_reasons: [{ code: "role_unavailable", detail: "Role is inactive." }],
  }).action, "Recheck role");
});

test("submit popup only navigates when a validated destination is available and closes on failure", () => {
  const popup = { location: { replace(url) { this.url = url; } }, close() { this.closed = true; } };
  assert.equal(navigateSubmitPopup(popup, "https://www.paraform.com/roles/1"), true);
  assert.equal(popup.location.url, "https://www.paraform.com/roles/1");
  assert.equal(navigateSubmitPopup(popup, ""), false);
  assert.equal(popup.closed, true);
});
