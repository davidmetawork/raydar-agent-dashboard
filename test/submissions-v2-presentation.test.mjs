import test from "node:test";
import assert from "node:assert/strict";
import { REVIEW_REASONS, rowDto, safeHttps } from "../api/submissions-v2/_lib/presentation.mjs";

test("all nine normalized review reasons have simple recruiter actions", () => assert.equal(Object.keys(REVIEW_REASONS).length, 9));

test("row DTO rejects unsafe Signal destinations", () => {
  const row = rowDto({ signal_id: "s", provisional_name: "Unknown", signal_url: "javascript:alert(1)", workflow_state: "needs_review", review_reasons: ["candidate_not_found"] });
  assert.equal(row.signal_url, null);
  assert.equal(row.review_reasons[0].label, "Candidate is missing in Paraform");
  assert.equal(row.primary_action_label, "Add in Paraform, then Recheck");
});

test("safe URL allowlist includes exact trusted subdomains only", () => {
  assert.ok(safeHttps("https://www.paraform.com/browse?role=x", ["paraform.com"]));
  assert.equal(safeHttps("https://paraform.com.attacker.example/", ["paraform.com"]), null);
});
