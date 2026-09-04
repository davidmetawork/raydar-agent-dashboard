import test from "node:test";
import assert from "node:assert/strict";
import { listFailureDisposition, listScopeIsCurrent, navigateSubmitPopup, reconcileListPages, resumeUiState } from "../submissions-v2-ui-state.mjs";

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

test("submit popup only navigates when a validated destination is available and closes on failure", () => {
  const popup = { location: { replace(url) { this.url = url; } }, close() { this.closed = true; } };
  assert.equal(navigateSubmitPopup(popup, "https://www.paraform.com/roles/1"), true);
  assert.equal(popup.location.url, "https://www.paraform.com/roles/1");
  assert.equal(navigateSubmitPopup(popup, ""), false);
  assert.equal(popup.closed, true);
});
