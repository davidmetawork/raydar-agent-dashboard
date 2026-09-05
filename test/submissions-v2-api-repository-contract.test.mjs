import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createRepository, decodeCursor, repositoryInternals } from "../api/submissions-v2/_lib/repository.mjs";

test("repository persists curated source links only with an exact canonical provenance marker", () => {
  assert.equal(repositoryInternals.curatedSignalUrlFromObservation({
    source_link_kind: "curated_list_exact",
    signal_url: "https://www.paraform.com/lists/list-1",
  }), "https://www.paraform.com/lists/list-1");
  assert.equal(repositoryInternals.curatedSignalUrlFromObservation({
    source_link_kind: "curated_list_exact",
    signal_url: "https://www.paraform.com/lists/list-1?other=role-1",
  }), null);
  assert.equal(repositoryInternals.curatedSignalUrlFromObservation({
    source_link_kind: "unverified",
    signal_url: "https://www.paraform.com/lists/list-1",
  }), null);
});

test("repository exposes the complete API and worker persistence boundary", () => {
  const repository = createRepository({ sql: {} });
  const expected = [
    "list", "counts", "health", "searchCandidates", "searchRoles", "pair", "jobs", "sourceForReview",
    "recordEmailSource", "applyClassifiedSignal", "routeClassificationFailure", "bindUnresolvedSignal", "dismissUnresolvedSignal",
    "addCandidate", "transition", "keepReview", "enqueuePairAction", "enqueueSignalAction",
    "addSupplement", "regenerate", "issueDownload", "downloadableArtifact", "openSubmit", "archive",
    "upsertCandidateIndex", "upsertRoleIndex", "curatedSnapshots", "applyCuratedObservations",
    "resumeWorkInput", "startResumeGeneration", "resumeGeneration", "updateResumeGeneration",
    "startResumeStageRun", "finishResumeStageRun", "persistResumeSources", "persistResumeClaims",
    "persistClaimEvidenceLinks", "persistClaimValidations", "updateSupplementProcessing",
    "promoteResumeArtifacts", "failResumeGeneration", "pairsForSubmissionProofPage", "applySubmissionProof",
    "recordSourceHealth", "claimNotifications", "settleNotification", "deliverNotification", "duePurges", "markArtifactPurged",
    "runtimeControls", "setControls", "scheduleTick", "recoverExpiredResumeGenerations", "candidateMatches", "reservePrivateObject",
    "renewPrivateObjectWrite", "commitPrivateObjectReservation", "reserveUploadIntent", "redeemDownloadTicket", "auditDownloadFailure",
    "finalizeCandidateIndexCycle", "retirePreviousCandidateHmac", "duePrivateObjectReservations",
    "markPrivateObjectReservationPurged", "releasePrivateObjectReservationCleanup", "dueUploadReservations", "markUploadReservationPurged", "releaseUploadReservationCleanup",
    "dueQuarantinedSupplements", "markQuarantinedSupplementPurged", "releaseQuarantinedSupplementCleanup", "reserveCaseRetentionCommand",
    "caseDeletionManifest", "caseDeletionForRestore", "softDeleteCase", "restoreCase",
    "failCaseRetentionCommand", "issueArchiveRetrieval",
  ];
  for (const name of expected) assert.equal(typeof repository[name], "function", `${name} must be exported`);
  assert.equal(repository.markCasePurged, undefined, "general API and worker identities must not expose case purge finalization");
});

test("submission proof selection pages every visible positive pair with a stable bounded cursor", async () => {
  let query = "";
  let values = [];
  const rows = Array.from({ length: 9 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    candidate_user_id: `candidate-${index}`,
    role_id: `role-${index}`,
    original_signal_at: new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString(),
    submission_status: index % 2 ? "opened" : "none",
  }));
  const sql = async (strings, ...parameters) => {
    query = strings.join("?");
    values = parameters;
    return rows;
  };
  const repository = createRepository({ sql });
  const page = await repository.pairsForSubmissionProofPage({ limit: 100 });
  assert.equal(page.rows.length, 8);
  assert.equal(page.cycle_complete, false);
  assert.deepEqual(decodeCursor(page.next_cursor), {
    at: rows[7].original_signal_at,
    id: rows[7].id,
  });
  assert.match(query, /submission_status <> 'proven'/u);
  assert.match(query, /workflow_state in \('preparing_resume','interested','needs_review'\)/u);
  assert.match(query, /intent_state in \('interested','unclear'\)/u);
  assert.equal(values.at(-1), 9, "an eight-pair page reads only one lookahead row");
});

test("API repository and worker share only canonical job kinds", async () => {
  const [repository, service, worker, pipelineStore] = await Promise.all([
    readFile(new URL("../api/submissions-v2/_lib/repository.mjs", import.meta.url), "utf8"),
    readFile(new URL("../api/submissions-v2/_lib/service.mjs", import.meta.url), "utf8"),
    readFile(new URL("../submissions-v2-worker/runner.mjs", import.meta.url), "utf8"),
    readFile(new URL("../api/submissions-v2/_lib/resume/pipeline-store.mjs", import.meta.url), "utf8"),
  ]);
  const canonical = [
    "classify_email_reply", "prepare_resume", "recheck_pair", "reconcile_master_inbox", "reconcile_sequence_inbox", "reconcile_curated",
    "index_candidates", "index_roles", "proof_reconcile", "deliver_notification", "source_health", "daily_digest", "purge",
  ];
  for (const kind of canonical) assert.match(worker, new RegExp(`\\b${kind}\\b`));
  for (const kind of ["classify_email_reply", "prepare_resume", "recheck_pair", "reconcile_master_inbox", "reconcile_sequence_inbox", "reconcile_curated"]) {
    assert.match(`${repository}\n${service}`, new RegExp(`\\b${kind}\\b`));
  }
  assert.doesNotMatch(`${repository}\n${service}`, /resume_prepare|classify_reply|gmail_poll/);
  assert.doesNotMatch(repository, /from submissions_v2\.(?:candidate_index|role_index)[^`]*for share/iu,
    "read-only index validation must not request a PostgreSQL write privilege through row locks");
  assert.doesNotMatch(`${repository}\n${pipelineStore}`, /\.array\([^\n]*["']uuid["']/u,
    "Postgres.js array element types must use numeric OIDs so empty UUID arrays serialize as PostgreSQL arrays");
  assert.match(repository, /resume_regeneration_in_progress/,
    "a candidate-role pair must reject overlapping paid resume regenerations");
  assert.match(repository, /status in \('queued','collecting','extracting','strategizing','validating','rendering','archiving'\)/);
  assert.match(repository, /state in \('queued','running'\)/);
  assert.match(repository, /when pending_job\.id is not null then 'queued'/,
    "row progress must stay active while a retry job is queued between generation attempts");
  assert.match(repository, /where \(p\.workflow_state in \('preparing_resume','interested'\) or p\.submission_status='proven'\) and p\.case_hidden_at is null/,
    "positive candidates must appear immediately while their first resume is preparing");
  assert.match(repository, /workflow_state in \('preparing_resume','interested'\).*as interested/s,
    "the Interested count must use the same positive workflow states as the list");
  assert.match(repository, /current_artifact\.validation_status='passed'/,
    "list capabilities must be grounded in a validated current artifact");
  assert.match(repository, /workflow_state in \('preparing_resume','interested'\) and submission_status <> 'proven'/,
    "preparing positives must remain represented in the actionable count");
});
