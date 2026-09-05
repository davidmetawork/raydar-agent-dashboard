import { createHash } from "node:crypto";

import { claimSourceCursor, commitSourceCursor, database, releaseSourceCursor } from "../api/submissions-v2/_lib/db.mjs";
import { createRepository } from "../api/submissions-v2/_lib/repository.mjs";
import { createService } from "../api/submissions-v2/_lib/service.mjs";
import { exactCuratedListSource, readActiveRoleIndex, readCandidateIndexPage, readCuratedCandidate, readCuratedPopulation, readCuratedRoleList } from "../api/submissions-v2/_lib/paraform-sources.mjs";
import { paraformCuratedListUrl } from "../api/submissions-v2/_lib/paraform-links.mjs";
import { curatedBatchPlan } from "../api/submissions-v2/_lib/curated.mjs";
import { notificationText, postSafeNotification } from "../api/submissions-v2/_lib/notifications.mjs";
import { exactSlackChannel } from "../api/submissions-v2/_lib/notifications.mjs";
import { collectResumeSourceBundle } from "../api/submissions-v2/_lib/resume/collector.mjs";
import { assertGenerationReady, canonicalJson, sha256 } from "../api/submissions-v2/_lib/resume/source-bundle.mjs";
import { extractPdfWithRenderer } from "../api/submissions-v2/_lib/resume/pipeline-renderer.mjs";
import { createResumePipelineStore } from "../api/submissions-v2/_lib/resume/pipeline-store.mjs";
import { runResumePreparation, settleResumePreparationFailure } from "../api/submissions-v2/_lib/resume/pipeline.mjs";
import { ResumePipelineError, pipelineError } from "../api/submissions-v2/_lib/resume/pipeline-runtime.mjs";
import { readExactSubmissionProofs } from "./proof-reader.mjs";
import { reconcileGmailRoleInterest } from "./gmail-reader.mjs";
import { GMAIL_ROLE_INTEREST_SCOPE } from "../api/submissions-v2/_lib/email-source-policy.mjs";
import { reconcileSequenceInbox } from "./sequence-inbox-reader.mjs";

export const WORKER_JOB_KINDS = Object.freeze([
  "classify_email_reply", "prepare_resume", "recheck_pair", "reconcile_master_inbox",
  "reconcile_sequence_inbox", "reconcile_curated", "index_candidates", "index_roles", "proof_reconcile",
  "deliver_notification", "source_health", "daily_digest", "purge",
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clean = (value, limit = 500) => String(value ?? "").replace(/[\r\n]+/gu, " ").trim().slice(0, limit);
const MONITOR_URL = "https://monitor.raydar.xyz/#submissions-v2";

function sequenceInboxHealthDetail(error) {
  const evidence = error?.details || {};
  const state = clean(evidence.cache_state, 40) || "unavailable";
  const completeAt = clean(evidence.cache_last_complete_at, 60) || "unknown";
  const missing = Math.max(0, Number(evidence.cache_campaigns_missing) || 0);
  const stale = Math.max(0, Number(evidence.cache_campaigns_stale) || 0);
  return `Sequence Inbox cache is ${state}; last complete ${completeAt}; ${missing} campaign(s) missing and ${stale} stale. Its cursor has not advanced.`;
}

function sourceError(error, code) {
  return pipelineError(error, { code, safeMessage: "The source read failed safely and its cursor was not advanced.", retryable: true });
}

function masterInboxConfig(env) {
  const url = String(env.SUBMISSIONS_V2_MASTER_INBOX_RECONCILE_URL || "").trim();
  const key = String(env.SUBMISSIONS_V2_MASTER_INBOX_WORKER_KEY || "").trim();
  if (!/^https:\/\//u.test(url) || key.length < 32) {
    throw new ResumePipelineError("master_inbox_reconcile_not_configured", "Master Inbox reconciliation is not configured.", { retryable: true });
  }
  return { url, key };
}

async function reconcileMasterInbox({ env, fetchImpl, signal }) {
  const { url, key } = masterInboxConfig(env);
  const response = await fetchImpl(url, {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: "{}", signal,
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.ok !== true) {
    throw new ResumePipelineError("master_inbox_reconcile_failed", "Master Inbox did not confirm reply-event reconciliation.", { retryable: true });
  }
  return body;
}

async function ensureSourceCursor(sql, sourceKey) {
  await sql`insert into submissions_v2.source_cursors(source_key) values (${sourceKey}) on conflict (source_key) do nothing`;
}

async function enqueueInternal(sql, { kind, subjectType, subjectId, idempotencyKey, requiredControl, priority = 100, checkpoint = {}, scheduledAt = null }) {
  const controls = (await sql`select * from submissions_v2.runtime_controls where singleton=true`)[0];
  if (!controls) throw new ResumePipelineError("submissions_v2_controls_unavailable", "Submissions V2 controls are unavailable.");
  const rows = await sql`
    insert into submissions_v2.jobs(kind, subject_type, subject_id, idempotency_key, required_control, priority, checkpoint, control_epoch, scheduled_at)
    values (${kind}, ${subjectType}, ${subjectId}, ${idempotencyKey}, ${requiredControl}, ${priority}, ${sql.json(checkpoint)}, ${controls.control_epoch}, coalesce(${scheduledAt}, clock_timestamp()))
    on conflict (kind, idempotency_key) do nothing returning *
  `;
  return rows[0] || null;
}

function ownerName(value) {
  const local = clean(value, 200).split("@", 1)[0];
  if (!local || local === "unassigned") return "Unassigned";
  return local.split(/[^A-Za-z0-9]+/u).filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`).join(" ") || "Unassigned";
}

const dailyDigestText = (data = {}) => {
  const interested = Number(data.interested || 0);
  const needsReview = Number(data.needs_review || 0);
  const open = Number(data.open_items || interested + needsReview);
  return `Submissions daily digest for ${clean(data.owner_name || "Unassigned", 120)}: ${open} open — ${interested} interested, ${needsReview} needs review; ${data.monitor_url || MONITOR_URL}`;
};

async function queueOutbox(sql, env, { kind, payload, dedupeKey }) {
  const destinationId = exactSlackChannel(env.SUBMISSIONS_V2_SLACK_CHANNEL_ID);
  const rows = await sql`
    insert into submissions_v2.notification_outbox(kind, destination_id, safe_payload, dedupe_key)
    values (${kind}, ${destinationId}, ${sql.json(payload)}, ${dedupeKey})
    on conflict (dedupe_key) do nothing returning id
  `;
  return Boolean(rows[0]);
}

export function createWorkerHandlers({
  env = process.env,
  sql = database(),
  repository = createRepository({ sql, env }),
  service = createService({ repository, env }),
  resumeStore = createResumePipelineStore({ sql, repository, env }),
  runResume = runResumePreparation,
  settleResumeFailure = settleResumePreparationFailure,
  candidatePage = readCandidateIndexPage,
  activeRoles = readActiveRoleIndex,
  curatedPopulation = readCuratedPopulation,
  curatedCandidate = readCuratedCandidate,
  curatedRoleList = readCuratedRoleList,
  collectSources = collectResumeSourceBundle,
  extractPdf = extractPdfWithRenderer,
  masterInbox = reconcileMasterInbox,
  gmailInterviews = reconcileGmailRoleInterest,
  sequenceInbox = reconcileSequenceInbox,
  proofReader = readExactSubmissionProofs,
  notify = postSafeNotification,
  fetchImpl = globalThis.fetch,
  sleepImpl = sleep,
  sourceLease = { claimSourceCursor, commitSourceCursor, releaseSourceCursor },
  now = () => new Date(),
} = {}) {
  const result = Object.create(null);
  const executionFence = (context) => ({
    jobId: context.job.id,
    workerId: context.workerId,
    fencingToken: context.fencingToken,
    controlEpoch: context.controlEpoch,
  });
  const sourceFence = (context, sourceKey, claimed) => ({
    sourceKey,
    workerId: context.workerId,
    fencingToken: Number(claimed.fencing_token),
    controlEpoch: context.controlEpoch,
  });

  result.classify_email_reply = async (context) => {
    const signalId = String(context.job.subject_id || context.job.checkpoint?.signal_id || "");
    if (!signalId) throw new ResumePipelineError("classification_subject_invalid", "The classification job is missing its source event.");
    const candidateId = clean(context.job.checkpoint?.candidate_id, 200) || undefined;
    const roleIds = Array.isArray(context.job.checkpoint?.role_ids)
      ? [...new Set(context.job.checkpoint.role_ids.map((value) => clean(value, 200)).filter(Boolean))].slice(0, 25)
      : [];
    await context.checkpoint({ ...context.job.checkpoint, stage: "classifying", signal_id: signalId });
    const classified = await service.processSignal(signalId, {
      candidateId,
      roleIds,
      executionFence: executionFence(context),
      beforeApply: () => context.checkpoint({ ...context.job.checkpoint, stage: "classification_external_complete", signal_id: signalId }),
    });
    return { checkpoint: { ...context.job.checkpoint, stage: "classified", signal_id: signalId, created_count: Number(classified?.created_count || 0) } };
  };

  result.prepare_resume = async (context) => {
    try {
      return await runResume(context, {
        store: resumeStore, env, fetchImpl, now: () => now().getTime(),
        executionFence: executionFence(context),
      });
    } catch (error) {
      const normalized = pipelineError(error, { safeMessage: "Resume preparation failed safely before publication.", retryable: true, checkpoint: error?.checkpoint || context.job.checkpoint });
      if (normalized.code === "execution_fence_lost") throw normalized;
      const terminal = normalized.retryable === false
        || Number(context.job.attempt_count || 0) >= Number(context.job.max_attempts || 3)
        || normalized.code === "generation_budget_exhausted";
      if (!terminal) {
        if (normalized.details?.generationId && typeof resumeStore.abandonGenerationForRetry === "function") {
          await resumeStore.abandonGenerationForRetry({
            generationId: normalized.details.generationId,
            reasonCode: normalized.code,
            safeDetail: normalized.safeMessage,
            executionFence: executionFence(context),
          });
        }
        throw normalized;
      }
      await settleResumeFailure(normalized, context, { store: resumeStore, executionFence: executionFence(context) });
      return { checkpoint: { ...(normalized.checkpoint || context.job.checkpoint), terminal_routed: true, safe_failure_code: normalized.code } };
    }
  };

  result.recheck_pair = async (context) => {
    const pairId = String(context.job.subject_id || "");
    const loaded = await resumeStore.loadPairContext(pairId, context.job.checkpoint || {});
    await context.checkpoint({ ...context.job.checkpoint, stage: "rechecking_original_resume" });
    const bundle = await collectSources({ candidateUserId: loaded.pair.candidate_user_id, roleId: loaded.pair.role_id, supplements: [], knownRaydarDigests: loaded.knownRaydarDigests }, {
      extractResumeImpl: (bytes) => extractPdf(bytes, { env, fetchImpl, signal: context.signal }), env, fetchImpl, now: () => now().getTime(),
    });
    if (!bundle.readiness.canGenerate) return { checkpoint: { ...context.job.checkpoint, stage: "original_resume_still_missing", source_digest: bundle.sourceDigest } };
    assertGenerationReady(bundle);
    await context.checkpoint({ ...context.job.checkpoint, stage: "recheck_external_complete", source_digest: bundle.sourceDigest });
    const resumed = await resumeStore.resumeAfterRecheck({
      pairId,
      expectedPairVersion: Number(context.job.checkpoint?.expected_pair_version || loaded.pair.state_version),
      executionFence: executionFence(context),
    });
    return { checkpoint: { ...context.job.checkpoint, stage: "recheck_complete", prepare_job_id: resumed.job?.id || null } };
  };

  result.index_candidates = async (context) => {
    const sourceKey = "candidate_index";
    await ensureSourceCursor(sql, sourceKey);
    const claimed = await sourceLease.claimSourceCursor({ sourceKey, workerId: context.workerId, leaseSeconds: 600, controlEpoch: context.controlEpoch }, sql);
    if (!claimed) return { checkpoint: { stage: "candidate_index_coalesced" } };
    const authoritativeCycleId = clean(claimed.checkpoint?.cycle_id, 200);
    const requestedCycleId = clean(context.job.checkpoint?.cycle_id, 200);
    if (context.job.checkpoint?.continuation === true && requestedCycleId !== authoritativeCycleId) {
      await sourceLease.releaseSourceCursor({ sourceKey, workerId: context.workerId, fencingToken: claimed.fencing_token, controlEpoch: context.controlEpoch }, sql);
      return { checkpoint: { stage: "candidate_index_stale_continuation", cycle_id: requestedCycleId || null } };
    }
    const cycleId = authoritativeCycleId || String(context.job.id);
    let cursor = authoritativeCycleId ? (claimed.checkpoint?.cursor ?? 0) : 0;
    let pages = 0;
    let changed = 0;
    try {
      do {
        await context.checkpoint({ ...context.job.checkpoint, cursor, cycle_id: cycleId, stage: "reading_candidate_index" });
        const page = await candidatePage(cursor, 100, { env });
        await context.checkpoint({ ...context.job.checkpoint, cursor, cycle_id: cycleId, stage: "candidate_index_page_read" });
        const stored = await repository.upsertCandidateIndex(page.rows, {
          cycleId,
          executionFence: executionFence(context),
          sourceFence: sourceFence(context, sourceKey, claimed),
        });
        changed += Number(stored.changed_count || 0);
        cursor = page.next_cursor;
        pages += 1;
        await context.checkpoint({ ...context.job.checkpoint, cursor, cycle_id: cycleId, pages, changed, stage: "candidate_index_checkpoint" });
      } while (cursor != null && pages < 5 && !context.signal.aborted);
      let retired = 0;
      let deactivated = 0;
      if (cursor == null) {
        const finalized = await repository.finalizeCandidateIndexCycle({
          cycleId,
          executionFence: executionFence(context),
          sourceFence: sourceFence(context, sourceKey, claimed),
        });
        deactivated = Number(finalized.deactivated_count || 0);
        const retirement = await repository.retirePreviousCandidateHmac({
          currentVersion: env.SUBMISSIONS_V2_EMAIL_HMAC_VERSION,
          executionFence: executionFence(context),
          sourceFence: sourceFence(context, sourceKey, claimed),
        });
        retired = Number(retirement.retired_count || 0);
      }
      const sourceCheckpoint = cursor == null ? {} : { cursor, cycle_id: cycleId };
      const committed = await sourceLease.commitSourceCursor({
        sourceKey,
        workerId: context.workerId,
        fencingToken: claimed.fencing_token,
        controlEpoch: context.controlEpoch,
        checkpoint: sourceCheckpoint,
        fullSuccess: cursor == null,
      }, sql);
      if (!committed) throw new ResumePipelineError("candidate_index_cursor_fence_lost", "Candidate indexing lost its source cursor fence.");
      if (cursor != null) await enqueueInternal(sql, {
        kind: "index_candidates",
        subjectType: "source",
        subjectId: "paraform_candidates",
        idempotencyKey: `index-candidates:${sha256(`${cycleId}:${cursor}`).slice(0, 32)}`,
        requiredControl: "ingestion",
        priority: 30,
        checkpoint: { cursor, cycle_id: cycleId, continuation: true },
      });
      await repository.recordSourceHealth({ sourceKey, enabled: true, success: cursor == null });
      return { checkpoint: { cursor, cycle_id: cycleId, pages, changed, deactivated_count: deactivated, retired_previous_hmac_count: retired, complete: cursor == null } };
    } catch (error) {
      await sourceLease.releaseSourceCursor({ sourceKey, workerId: context.workerId, fencingToken: claimed.fencing_token, controlEpoch: context.controlEpoch }, sql).catch(() => {});
      await repository.recordSourceHealth({ sourceKey, enabled: true, delayed: true, errorClass: clean(error?.code, 120) || "candidate_index_failed", safeDetail: "Candidate indexing has not completed successfully." }).catch(() => {});
      throw sourceError(error, "candidate_index_failed");
    }
  };

  result.index_roles = async (context) => {
    const sourceKey = "role_index";
    await ensureSourceCursor(sql, sourceKey);
    const claimed = await sourceLease.claimSourceCursor({ sourceKey, workerId: context.workerId, leaseSeconds: 600, controlEpoch: context.controlEpoch }, sql);
    if (!claimed) return { checkpoint: { stage: "role_index_coalesced" } };
    try {
      await context.checkpoint({ ...context.job.checkpoint, stage: "reading_role_index" });
      const roles = await activeRoles();
      await context.checkpoint({ ...context.job.checkpoint, stage: "role_index_read_complete", read_count: roles.rows.length });
      const stored = await repository.upsertRoleIndex(roles.rows, {
        deactivateMissing: true,
        confirmedAt: roles.confirmed_at,
        executionFence: executionFence(context),
        sourceFence: sourceFence(context, sourceKey, claimed),
      });
      const committed = await sourceLease.commitSourceCursor({
        sourceKey,
        workerId: context.workerId,
        fencingToken: claimed.fencing_token,
        controlEpoch: context.controlEpoch,
        checkpoint: { confirmed_at: roles.confirmed_at },
        fullSuccess: true,
      }, sql);
      if (!committed) throw new ResumePipelineError("role_index_cursor_fence_lost", "Role indexing lost its source cursor fence.");
      await repository.recordSourceHealth({ sourceKey, enabled: true, success: true });
      return { checkpoint: { stage: "role_index_complete", read_count: stored.read_count, changed_count: stored.changed_count, confirmed_at: roles.confirmed_at } };
    } catch (error) {
      await sourceLease.releaseSourceCursor({ sourceKey, workerId: context.workerId, fencingToken: claimed.fencing_token, controlEpoch: context.controlEpoch }, sql).catch(() => {});
      await repository.recordSourceHealth({ sourceKey, enabled: true, delayed: true, errorClass: clean(error?.code, 120) || "role_index_failed", safeDetail: "Role indexing has not completed successfully." }).catch(() => {});
      throw sourceError(error, "role_index_failed");
    }
  };

  result.reconcile_master_inbox = async (context) => {
    const reader = env.SUBMISSIONS_V2_EMAIL_READER || "master_inbox";
    if (!["gmail", "master_inbox"].includes(reader)) throw new ResumePipelineError("email_reader_invalid", "The email reader is not recognized.");
    // The durable master_inbox control is the existing email-ingress stop control;
    // retain its epoch/fence semantics when changing only the transport.
    if (reader === "gmail") {
      const sourceKey = "master_inbox";
      await ensureSourceCursor(sql, sourceKey);
      const claimed = await sourceLease.claimSourceCursor({ sourceKey, workerId: context.workerId, leaseSeconds: 300, controlEpoch: context.controlEpoch }, sql);
      if (!claimed) return { checkpoint: { stage: "gmail_coalesced" } };
      try {
        const gmailCheckpoint = claimed.checkpoint?.gmail || {};
        const scopedCheckpoint = gmailCheckpoint?.scopes?.[GMAIL_ROLE_INTEREST_SCOPE] || {};
        // Keep the pre-existing Gmail cursor as the live lane's seed. The
        // broad role-interest reader must prove current intake first; its
        // historical replay is a separate lane so a quota failure cannot erase
        // or rewind live progress.
        const legacyThrough = Number(gmailCheckpoint.through);
        const seededLive = Number.isFinite(legacyThrough)
          ? { through: legacyThrough }
          : {};
        const liveCheckpoint = scopedCheckpoint.live
          || seededLive;
        const catchupCheckpoint = scopedCheckpoint.catchup
          // A predecessor may have stored a scoped activation cursor. Preserve
          // it only as historical catch-up, never as the live cursor.
          || (Number.isFinite(Number(scopedCheckpoint.through))
            ? { through: Number(scopedCheckpoint.through), window_span_ms: scopedCheckpoint.window_span_ms }
            : {});
        // Always advance the live lane first. A catch-up error is recorded as
        // partial after its live result is durably committed below, so the
        // historical backlog cannot freeze current candidate replies.
        const live = await gmailInterviews({
          env, fetchImpl, signal: context.signal, checkpoint: liveCheckpoint, now: now().getTime(),
          maxThreads: 12,
          assertCurrent: () => context.checkpoint({ stage: "reading_gmail_role_interest_live" }),
          admit: (event) => service.intakeMasterInbox(event),
        });
        const nextLive = { ...live.checkpoint, caught_up: Boolean(live.caught_up) };
        let catchup = null;
        let catchupFailure = null;
        const remainingThreads = Math.max(0, 12 - Math.max(0, Number(live.threads_read) || 0));
        if (nextLive.caught_up && catchupCheckpoint.caught_up !== true && remainingThreads > 0) {
          try {
            catchup = await gmailInterviews({
              env, fetchImpl, signal: context.signal, checkpoint: catchupCheckpoint, now: now().getTime(),
              maxThreads: remainingThreads,
              assertCurrent: () => context.checkpoint({ stage: "reading_gmail_role_interest_catchup" }),
              admit: (event) => service.intakeMasterInbox(event),
            });
          } catch (error) {
            catchupFailure = error;
          }
        }
        if (catchupFailure) {
          context.signal?.throwIfAborted?.();
          if (catchupFailure?.name === "AbortError" || /(?:fence|aborted)/iu.test(String(catchupFailure?.code || catchupFailure?.message || ""))) {
            throw catchupFailure;
          }
        }
        const nextCatchup = catchup
          ? { ...catchup.checkpoint, caught_up: Boolean(catchup.caught_up) }
          : catchupCheckpoint;
        const allCaughtUp = nextLive.caught_up === true && nextCatchup.caught_up === true;
        const nextScope = {
          ...scopedCheckpoint,
          live: nextLive,
          catchup: nextCatchup,
        };
        const committed = await sourceLease.commitSourceCursor({
          sourceKey, workerId: context.workerId, fencingToken: claimed.fencing_token, controlEpoch: context.controlEpoch,
          checkpoint: {
            ...claimed.checkpoint,
            gmail: {
              ...gmailCheckpoint,
              scopes: { ...(gmailCheckpoint.scopes || {}), [GMAIL_ROLE_INTEREST_SCOPE]: nextScope },
            },
          },
          fullSuccess: allCaughtUp,
        }, sql);
        if (!committed) throw new ResumePipelineError("gmail_cursor_fence_lost", "The Gmail reader lost its source cursor fence.");
        if (allCaughtUp) await repository.recordSourceHealth({ sourceKey, enabled: true, success: true });
        else await repository.recordSourceHealth({
          sourceKey,
          enabled: true,
          delayed: true,
          errorClass: clean(catchupFailure?.code, 120) || "gmail_catching_up",
          safeDetail: catchupFailure
            ? "Gmail live intake advanced; historical catch-up is delayed and will retry from its saved cursor."
            : "Gmail live intake is checkpointed separately while historical replies catch up from the approved activation time.",
        });
        return { checkpoint: {
          stage: catchupFailure ? "gmail_catchup_delayed" : live.narrowed ? "gmail_window_narrowed" : live.completed ? "gmail_live_window_complete" : "gmail_waiting_for_window",
          observed: (live.observed || 0) + (catchup?.observed || 0),
          accepted: (live.accepted || 0) + (catchup?.accepted || 0),
          catchup_delayed: Boolean(catchupFailure),
        } };
      } catch (error) {
        await sourceLease.releaseSourceCursor({ sourceKey, workerId: context.workerId, fencingToken: claimed.fencing_token, controlEpoch: context.controlEpoch }, sql).catch(() => {});
        await repository.recordSourceHealth({ sourceKey, enabled: true, delayed: true, errorClass: clean(error?.code, 120) || "gmail_reader_failed", safeDetail: "Gmail role-interest reply intake is delayed; its cursor has not advanced." }).catch(() => {});
        throw sourceError(error, "gmail_reader_failed");
      }
    }
    await context.checkpoint({ ...context.job.checkpoint, stage: "requesting_master_inbox_reconciliation" });
    try {
      const reconciled = await masterInbox({ env, fetchImpl, signal: context.signal });
      await repository.recordSourceHealth({ sourceKey: "master_inbox", enabled: true, success: true });
      return { checkpoint: { stage: "master_inbox_complete", result_digest: sha256(canonicalJson(reconciled)) } };
    } catch (error) {
      await repository.recordSourceHealth({ sourceKey: "master_inbox", enabled: true, delayed: true, errorClass: clean(error?.code, 120) || "master_inbox_failed", safeDetail: "Master Inbox reconciliation has not completed successfully." }).catch(() => {});
      throw sourceError(error, "master_inbox_reconcile_failed");
    }
  };

  result.reconcile_sequence_inbox = async (context) => {
    const sourceKey = "sequence_inbox";
    await ensureSourceCursor(sql, sourceKey);
    const claimed = await sourceLease.claimSourceCursor({
      sourceKey,
      workerId: context.workerId,
      leaseSeconds: 300,
      controlEpoch: context.controlEpoch,
    }, sql);
    if (!claimed) return { checkpoint: { stage: "sequence_inbox_coalesced" } };
    try {
      const reconciled = await sequenceInbox({
        env,
        signal: context.signal,
        checkpoint: claimed.checkpoint || {},
        now,
        assertCurrent: () => context.checkpoint({
          ...context.job.checkpoint,
          stage: "reading_sequence_inbox",
        }),
        admit: (event) => service.intakeMasterInbox(event),
      });
      const committed = await sourceLease.commitSourceCursor({
        sourceKey,
        workerId: context.workerId,
        fencingToken: claimed.fencing_token,
        controlEpoch: context.controlEpoch,
        checkpoint: reconciled.checkpoint,
        fullSuccess: reconciled.caught_up,
      }, sql);
      if (!committed) {
        throw new ResumePipelineError(
          "sequence_inbox_cursor_fence_lost",
          "Sequence Inbox intake lost its source cursor fence.",
        );
      }
      if (reconciled.caught_up) {
        await repository.recordSourceHealth({ sourceKey, enabled: true, success: true });
      } else {
        await repository.recordSourceHealth({
          sourceKey,
          enabled: true,
          delayed: true,
          errorClass: "sequence_inbox_catching_up",
          safeDetail: "Sequence Inbox replies are being read in order from the approved activation time.",
        });
      }
      return { checkpoint: {
        stage: reconciled.caught_up ? "sequence_inbox_complete" : "sequence_inbox_page_complete",
        observed: reconciled.observed,
        accepted: reconciled.accepted,
        existing: reconciled.existing,
        cache_state: reconciled.cache.state,
        cache_last_complete_at: reconciled.cache.last_complete_at,
        cache_campaigns_targeted: reconciled.cache.campaigns_targeted,
        cache_campaigns_missing: reconciled.cache.campaigns_missing,
        cache_campaigns_stale: reconciled.cache.campaigns_stale,
        sourcing_role_mapping_status: reconciled.cache.sourcing_role_mapping_status,
        sourcing_role_mapping_inventory_count: reconciled.cache.sourcing_role_mapping_inventory_count,
        sourcing_role_mapping_valid_record_count: reconciled.cache.sourcing_role_mapping_valid_record_count,
      } };
    } catch (error) {
      await sourceLease.releaseSourceCursor({
        sourceKey,
        workerId: context.workerId,
        fencingToken: claimed.fencing_token,
        controlEpoch: context.controlEpoch,
      }, sql).catch(() => {});
      await repository.recordSourceHealth({
        sourceKey,
        enabled: true,
        delayed: true,
        errorClass: clean(error?.code, 120) || "sequence_inbox_failed",
        safeDetail: sequenceInboxHealthDetail(error),
      }).catch(() => {});
      throw sourceError(error, "sequence_inbox_failed");
    }
  };

  result.reconcile_curated = async (context) => {
    const sourceKey = "curated";
    await ensureSourceCursor(sql, sourceKey);
    const claimed = await sourceLease.claimSourceCursor({ sourceKey, workerId: context.workerId, leaseSeconds: 300, controlEpoch: context.controlEpoch }, sql);
    if (!claimed) return { checkpoint: { stage: "curated_coalesced" } };
    try {
      const population = await curatedPopulation();
      const cursor = Number(claimed.checkpoint?.cursor || 0);
      const plan = curatedBatchPlan(population, { cursor, batchSize: 100, maxBatch: 120 });
      const observedAt = now().toISOString();
      const seed = !claimed.last_full_success_at;
      const observations = [];
      for (const [index, candidate] of plan.rows.entries()) {
        if (index) await sleepImpl(1_500);
        await context.checkpoint({ ...context.job.checkpoint, stage: "curated_read", cursor, batch_offset: index });
        const candidateUserId = String(candidate.candidateUserId);
        const statuses = await curatedCandidate(candidateUserId);
        const decisive = statuses.some((status) => ["APPLIED_TO_ROLE", "NOT_INTERESTED"].includes(status.status));
        let freshlyDecisiveRoleIds = new Set();
        let curatedList = null;
        if (!seed && decisive) {
          // A list link is optional provenance. Do not spend another provider read
          // for seeded, unchanged, or historical-pending status rows.
          const snapshots = await repository.curatedSnapshots(candidateUserId).catch(() => null);
          if (Array.isArray(snapshots)) {
            const priorByRole = new Map(snapshots.map((snapshot) => [String(snapshot?.role_id || ""), snapshot]));
            freshlyDecisiveRoleIds = new Set(statuses.filter((status) => {
              const prior = priorByRole.get(status.role_id);
              return ["APPLIED_TO_ROLE", "NOT_INTERESTED"].includes(status.status)
                && prior?.resolved === true && prior.last_confirmed_status !== status.status;
            }).map((status) => status.role_id));
            if (freshlyDecisiveRoleIds.size) {
              // A failed detail read never blocks decisive-status admission.
              curatedList = await curatedRoleList(candidateUserId).catch(() => null);
            }
          }
        }
        for (const status of statuses) {
          const exactSource = freshlyDecisiveRoleIds.has(status.role_id)
            ? exactCuratedListSource(curatedList, status.role_id, { listUrl: paraformCuratedListUrl })
            : null;
          observations.push({
            candidate_user_id: candidateUserId, role_id: status.role_id, status: status.status, observed_at: observedAt,
            digest: createHash("sha256").update(`${candidateUserId}:${status.role_id}:${status.status}:${observedAt}`).digest("hex"),
            ...(exactSource || {}),
          });
        }
      }
      await context.checkpoint({ ...context.job.checkpoint, stage: "curated_read_complete", cursor, observation_count: observations.length });
      const applied = await repository.applyCuratedObservations(observations, {
        seed,
        executionFence: executionFence(context),
        sourceFence: sourceFence(context, sourceKey, claimed),
      });
      const nextCheckpoint = { cursor: plan.next_cursor ?? 0 };
      const committed = await sourceLease.commitSourceCursor({ sourceKey, workerId: context.workerId, fencingToken: claimed.fencing_token, controlEpoch: context.controlEpoch, checkpoint: nextCheckpoint, fullSuccess: plan.cycle_complete }, sql);
      if (!committed) throw new ResumePipelineError("curated_cursor_fence_lost", "Curated reconciliation lost its source cursor fence.");
      await repository.recordSourceHealth({ sourceKey, enabled: true, success: plan.cycle_complete });
      return { checkpoint: { stage: "curated_batch_complete", cursor: nextCheckpoint.cursor, read_count: plan.rows.length, observation_count: observations.length, applied_count: applied.filter((row) => row.applied).length, cycle_complete: plan.cycle_complete } };
    } catch (error) {
      await sourceLease.releaseSourceCursor({ sourceKey, workerId: context.workerId, fencingToken: claimed.fencing_token, controlEpoch: context.controlEpoch }, sql).catch(() => {});
      await repository.recordSourceHealth({ sourceKey, enabled: true, delayed: true, errorClass: clean(error?.code, 120) || "curated_failed", safeDetail: "Curated reconciliation has not completed successfully." }).catch(() => {});
      throw sourceError(error, "curated_reconcile_failed");
    }
  };

  result.proof_reconcile = async (context) => {
    const sourceKey = "submission_proof";
    const targeted = context.job.subject_type === "pair";
    let claimed = null;
    try {
      let page;
      if (targeted) {
        const pair = await repository.pair(context.job.subject_id);
        page = {
          rows: [pair].filter((row) => row && row.submission_status !== "proven"),
          next_cursor: null,
          cycle_complete: false,
        };
      } else {
        await ensureSourceCursor(sql, sourceKey);
        claimed = await sourceLease.claimSourceCursor({
          sourceKey,
          workerId: context.workerId,
          leaseSeconds: 300,
          controlEpoch: context.controlEpoch,
        }, sql);
        if (!claimed) return { checkpoint: { stage: "proof_coalesced" } };
        page = await repository.pairsForSubmissionProofPage({
          limit: 8,
          cursor: claimed.checkpoint?.cursor || null,
        });
        if (!page || !Array.isArray(page.rows) || typeof page.cycle_complete !== "boolean") {
          throw new ResumePipelineError("submission_proof_page_shape_invalid", "Submission proof selection did not return a valid bounded page.");
        }
      }
      const pairs = page.rows;
      await context.checkpoint({ ...context.job.checkpoint, stage: "proof_read", pair_count: pairs.length });
      const proofs = pairs.length ? await proofReader(pairs, { now: now(), env }) : [];
      if (!Array.isArray(proofs)) throw new ResumePipelineError("submission_proof_shape_invalid", "Submission proof reconciliation did not return an authoritative result.");
      await context.checkpoint({ ...context.job.checkpoint, stage: "proof_read_complete", pair_count: pairs.length, proof_count: proofs.length });
      let proven = 0;
      for (const proof of proofs) {
        await context.checkpoint({ ...context.job.checkpoint, stage: "proof_apply", pair_id: proof.pairId });
        await repository.applySubmissionProof({ ...proof, executionFence: executionFence(context) });
        proven += 1;
      }
      if (claimed) {
        const nextCheckpoint = { cursor: page.next_cursor || null };
        const committed = await sourceLease.commitSourceCursor({
          sourceKey,
          workerId: context.workerId,
          fencingToken: claimed.fencing_token,
          controlEpoch: context.controlEpoch,
          checkpoint: nextCheckpoint,
          fullSuccess: page.cycle_complete,
        }, sql);
        if (!committed) throw new ResumePipelineError("submission_proof_cursor_fence_lost", "Submission proof reconciliation lost its source cursor fence.");
        if (page.cycle_complete) {
          await repository.recordSourceHealth({ sourceKey, enabled: true, success: true });
        }
      }
      return {
        checkpoint: {
          stage: targeted ? "proof_complete" : "proof_batch_complete",
          checked_count: pairs.length,
          proven_count: proven,
          ...(targeted ? {} : { cursor: page.next_cursor || null, cycle_complete: page.cycle_complete }),
        },
      };
    } catch (error) {
      if (claimed) {
        await sourceLease.releaseSourceCursor({
          sourceKey,
          workerId: context.workerId,
          fencingToken: claimed.fencing_token,
          controlEpoch: context.controlEpoch,
        }, sql).catch(() => {});
      }
      await repository.recordSourceHealth({ sourceKey, enabled: true, delayed: true, errorClass: clean(error?.code, 120) || "submission_proof_failed", safeDetail: "Submission proof reconciliation has not completed successfully." }).catch(() => {});
      throw sourceError(error, "submission_proof_reconcile_failed");
    }
  };

  result.deliver_notification = async (context) => {
    let sent = 0;
    let claimed = 0;
    for (let index = 0; index < 10; index += 1) {
      await context.checkpoint({ ...context.job.checkpoint, stage: "notification_claim", claimed_count: claimed });
      const rows = await repository.claimNotifications({
        workerId: context.workerId,
        limit: 1,
        leaseSeconds: 180,
        executionFence: executionFence(context),
      });
      if (!rows.length) break;
      const row = rows[0];
      claimed += 1;
      try {
        await context.checkpoint({ ...context.job.checkpoint, stage: "notification_send", notification_id: row.id });
      } catch (error) {
        await repository.settleNotification({
          id: row.id,
          workerId: context.workerId,
          fencingToken: row.fencing_token,
          sent: false,
          retryable: true,
          errorCode: "notification_not_started_fence_lost",
          safeDetail: "The notification was not started because its worker fence changed.",
          retryAt: new Date(now().getTime() + 5 * 60_000).toISOString(),
        });
        throw error;
      }
      try {
        const delivery = await repository.deliverNotification({
          id: row.id,
          workerId: context.workerId,
          fencingToken: row.fencing_token,
          executionFence: executionFence(context),
          deliver: async (current) => {
            const text = current.kind === "daily_digest" ? dailyDigestText(current.safe_payload) : notificationText(current.kind, current.safe_payload);
            const receipt = await notify(text, { env, fetchImpl, destinationId: current.destination_id });
            return receipt.receipt;
          },
        });
        if (delivery.sent) sent += 1;
      } catch (error) {
        const retryable = error?.deliveryOutcome === "not_sent";
        await repository.settleNotification({ id: row.id, workerId: context.workerId, fencingToken: row.fencing_token, sent: false, retryable, errorCode: clean(error?.code, 120) || "notification_failed", safeDetail: retryable ? "Slack confirmed that the notification was not sent." : "Slack delivery was not confirmed, so this notification is held to prevent a duplicate.", retryAt: retryable ? new Date(now().getTime() + 5 * 60_000).toISOString() : null });
      }
    }
    return { checkpoint: { stage: "notifications_complete", claimed_count: claimed, sent_count: sent } };
  };

  result.source_health = async () => {
    const [health, rows] = await Promise.all([
      repository.health(),
      sql`
        select h.*,
               exists(
                 select 1 from submissions_v2.notification_outbox n
                  where n.kind='source_delayed' and n.state='sent'
                    and n.safe_payload->>'source'=h.source_key
               ) as delayed_alert_sent
          from submissions_v2.source_health h where h.enabled order by h.source_key
      `,
    ]);
    const delayCutoff = now().getTime() - 15 * 60_000;
    let delayedAlerts = 0;
    let recoveryAlerts = 0;
    for (const row of rows) {
      const source = clean(row.source_key, 100) || "unknown source";
      const delayedAt = Date.parse(row.delayed_since || "");
      if (Number.isFinite(delayedAt) && delayedAt <= delayCutoff) {
        if (await queueOutbox(sql, env, {
          kind: "source_delayed",
          payload: { source, monitor_url: MONITOR_URL },
          dedupeKey: `source-delayed:${source}:${new Date(delayedAt).toISOString()}`,
        })) delayedAlerts += 1;
      }
      const recoveredAt = Date.parse(row.last_recovery_at || "");
      if (!row.delayed_since && row.delayed_alert_sent && Number.isFinite(recoveredAt)) {
        if (await queueOutbox(sql, env, {
          kind: "source_recovered",
          payload: { source, monitor_url: MONITOR_URL },
          dedupeKey: `source-recovered:${source}:${new Date(recoveredAt).toISOString()}`,
        })) recoveryAlerts += 1;
      }
    }
    return { checkpoint: {
      stage: "source_health_complete",
      delayed: Boolean(health.delayed),
      last_success_at: health.last_success_at || null,
      delayed_alert_count: delayedAlerts,
      recovery_alert_count: recoveryAlerts,
    } };
  };

  result.daily_digest = async () => {
    const date = now().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    const rows = await sql`
      with open_pairs as (
        select p.owner_email, p.workflow_state, p.original_signal_at
          from submissions_v2.candidate_role_pairs p
         where p.case_hidden_at is null
           and (p.workflow_state='needs_review'
                or (p.workflow_state='interested' and p.submission_status <> 'proven'))
      ), owner_rows as (
        select coalesce(nullif(owner_email,''), 'unassigned') as owner_email,
               count(*) filter (where workflow_state='interested')::integer as interested,
               count(*) filter (where workflow_state='needs_review')::integer as needs_review,
               count(*)::integer as open_items, min(original_signal_at) as oldest_waiting_at
          from open_pairs group by coalesce(nullif(owner_email,''), 'unassigned')
      ), unresolved as (
        select 'unassigned'::text as owner_email, 0::integer as interested,
               count(distinct unresolved_signal_id)::integer as needs_review,
               count(distinct unresolved_signal_id)::integer as open_items,
               min(opened_at) as oldest_waiting_at
          from submissions_v2.review_items
         where unresolved_signal_id is not null and action_state='open'
      )
      select * from owner_rows
      union all select * from unresolved where open_items > 0
      order by owner_email
    `;
    let queued = 0;
    const totals = { interested: 0, needs_review: 0, open_items: 0 };
    for (const row of rows) {
      const payload = {
        owner_name: ownerName(row.owner_email),
        interested: Number(row.interested || 0),
        needs_review: Number(row.needs_review || 0),
        open_items: Number(row.open_items || 0),
        oldest_waiting_at: row.oldest_waiting_at || null,
        monitor_url: MONITOR_URL,
      };
      totals.interested += payload.interested;
      totals.needs_review += payload.needs_review;
      totals.open_items += payload.open_items;
      if (await queueOutbox(sql, env, {
        kind: "daily_digest",
        payload,
        dedupeKey: `daily-digest:${date}:${sha256(String(row.owner_email || "unassigned")).slice(0, 24)}`,
      })) queued += 1;
    }
    return { checkpoint: { stage: "daily_digest_queued", date, owner_count: rows.length, queued_count: queued, totals } };
  };

  result.purge = async (context) => {
    return { checkpoint: {
      stage: "purge_delegated",
      isolated_service_required: true,
      ordinary_worker_delete_capability: false,
      scheduled_at: now().toISOString(),
    } };
  };

  return result;
}

let defaults = null;
const defaultHandlers = () => (defaults ||= createWorkerHandlers());

// Each kind is explicit so unknown jobs fail closed in runner.mjs.
export const handlers = Object.freeze(Object.fromEntries(WORKER_JOB_KINDS.map((kind) => [kind, (context) => defaultHandlers()[kind](context)])));

export const workerHandlerInternals = Object.freeze({ dailyDigestText, enqueueInternal, ensureSourceCursor, masterInboxConfig, ownerName, queueOutbox, reconcileMasterInbox, sequenceInboxHealthDetail });
