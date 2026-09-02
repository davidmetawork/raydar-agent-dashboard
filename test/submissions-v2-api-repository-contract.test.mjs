import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createRepository } from "../api/submissions-v2/_lib/repository.mjs";

test("repository exposes the complete API and worker persistence boundary", () => {
  const repository = createRepository({ sql: {} });
  const expected = [
    "list", "counts", "health", "searchCandidates", "searchRoles", "pair", "jobs",
    "recordEmailSource", "applyClassifiedSignal", "routeClassificationFailure", "bindUnresolvedSignal",
    "addCandidate", "transition", "keepReview", "enqueuePairAction", "enqueueSignalAction",
    "addSupplement", "regenerate", "issueDownload", "downloadableArtifact", "openSubmit", "archive",
    "upsertCandidateIndex", "upsertRoleIndex", "curatedSnapshots", "applyCuratedObservations",
    "resumeWorkInput", "startResumeGeneration", "resumeGeneration", "updateResumeGeneration",
    "startResumeStageRun", "finishResumeStageRun", "persistResumeSources", "persistResumeClaims",
    "persistClaimEvidenceLinks", "persistClaimValidations", "updateSupplementProcessing",
    "promoteResumeArtifacts", "failResumeGeneration", "openedPairsForProof", "applySubmissionProof",
    "recordSourceHealth", "claimNotifications", "settleNotification", "deliverNotification", "duePurges", "markArtifactPurged",
    "runtimeControls", "setControls", "scheduleTick", "candidateMatches", "reservePrivateObject",
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

test("API repository and worker share only canonical job kinds", async () => {
  const [repository, service, worker, pipelineStore] = await Promise.all([
    readFile(new URL("../api/submissions-v2/_lib/repository.mjs", import.meta.url), "utf8"),
    readFile(new URL("../api/submissions-v2/_lib/service.mjs", import.meta.url), "utf8"),
    readFile(new URL("../submissions-v2-worker/runner.mjs", import.meta.url), "utf8"),
    readFile(new URL("../api/submissions-v2/_lib/resume/pipeline-store.mjs", import.meta.url), "utf8"),
  ]);
  const canonical = [
    "classify_email_reply", "prepare_resume", "recheck_pair", "reconcile_master_inbox", "reconcile_curated",
    "index_candidates", "index_roles", "proof_reconcile", "deliver_notification", "source_health", "daily_digest", "purge",
  ];
  for (const kind of canonical) assert.match(worker, new RegExp(`\\b${kind}\\b`));
  for (const kind of ["classify_email_reply", "prepare_resume", "recheck_pair", "reconcile_master_inbox", "reconcile_curated"]) {
    assert.match(`${repository}\n${service}`, new RegExp(`\\b${kind}\\b`));
  }
  assert.doesNotMatch(`${repository}\n${service}`, /resume_prepare|classify_reply|gmail_poll/);
  assert.doesNotMatch(repository, /from submissions_v2\.(?:candidate_index|role_index)[^`]*for share/iu,
    "read-only index validation must not request a PostgreSQL write privilege through row locks");
  assert.doesNotMatch(`${repository}\n${pipelineStore}`, /\.array\([^\n]*["']uuid["']/u,
    "Postgres.js array element types must use numeric OIDs so empty UUID arrays serialize as PostgreSQL arrays");
});
