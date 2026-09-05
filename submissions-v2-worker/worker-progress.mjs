import { randomUUID } from "node:crypto";

const ERROR_CLASS_PATTERN = /^[a-z0-9_-]{1,120}$/u;
const DEFAULT_STALE_AFTER_MS = 7 * 60_000;

const date = (value) => {
  if (value == null || value === "") return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
};

const iso = (value) => date(value)?.toISOString() || null;

const secondsSince = (value, now) => {
  const parsed = date(value);
  if (!parsed) return null;
  return Math.max(0, Math.floor((now.getTime() - parsed.getTime()) / 1000));
};

export function safeWorkerErrorClass(error, fallback = "worker_cycle_failed") {
  const candidate = String(error?.code || error || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 120);
  return ERROR_CLASS_PATTERN.test(candidate) ? candidate : fallback;
}

export function livenessSnapshot({
  workerId,
  processStartedAt,
  cycleRunning = false,
  release = null,
  now = new Date(),
} = {}) {
  const current = date(now) || new Date();
  return {
    ok: true,
    status: "live",
    worker: "submissions-v2",
    worker_id: String(workerId || "unknown").slice(0, 200),
    process_started_at: iso(processStartedAt),
    process_age_seconds: secondsSince(processStartedAt, current),
    cycle_running: Boolean(cycleRunning),
    ...(release ? { release } : {}),
  };
}

export function unavailableReadiness(error, {
  workerId,
  processStartedAt,
  cycleRunning = false,
  lastAttemptedCycleAt = null,
  lastSuccessfulCycleAt = null,
  now = new Date(),
} = {}) {
  const current = date(now) || new Date();
  return {
    ok: false,
    ready: false,
    status: "not_ready",
    reason: "readiness_probe_failed",
    error_class: safeWorkerErrorClass(error, "readiness_probe_failed"),
    worker_id: String(workerId || "unknown").slice(0, 200),
    process_started_at: iso(processStartedAt),
    cycle_running: Boolean(cycleRunning),
    last_attempted_cycle_at: iso(lastAttemptedCycleAt),
    last_attempted_cycle_age_seconds: secondsSince(lastAttemptedCycleAt, current),
    last_successful_cycle_at: iso(lastSuccessfulCycleAt),
    last_successful_cycle_age_seconds: secondsSince(lastSuccessfulCycleAt, current),
    queue: [],
    sources: [],
  };
}

function readinessReason({ progress, workerId, attemptAgeMs, staleAfterMs }) {
  if (!progress) return "cycle_progress_missing";
  if (String(progress.worker_id) !== String(workerId)) return "cycle_progress_owned_by_prior_process";
  if (attemptAgeMs == null || attemptAgeMs > staleAfterMs) return "worker_cycle_stale";
  if (progress.cycle_running) return "cycle_in_progress";
  if (progress.last_cycle_ok !== true) return progress.last_cycle_error_class || "last_cycle_failed";
  return "ready";
}

export function createWorkerProgressStore({
  sql,
  workerKey = "submissions-v2",
  workerId,
  processStartedAt = new Date(),
  now = () => new Date(),
} = {}) {
  if (typeof sql !== "function") throw new TypeError("worker progress requires sql");
  const key = String(workerKey || "submissions-v2").slice(0, 120);
  const owner = String(workerId || "").slice(0, 200);
  if (!owner) throw new TypeError("worker progress requires workerId");
  const startedAt = iso(processStartedAt);

  return {
    async beginCycle({ attemptedAt = now() } = {}) {
      const attempted = iso(attemptedAt);
      const cycleToken = randomUUID();
      const rows = await sql`
        insert into submissions_v2.worker_progress(
          worker_key, worker_id, process_started_at, cycle_token,
          cycle_sequence, cycle_running, last_attempted_cycle_at,
          last_cycle_ok, last_cycle_error_class, updated_at
        ) values (
          ${key}, ${owner}, ${startedAt}, ${cycleToken},
          1, true, ${attempted}, null, null, clock_timestamp()
        )
        on conflict (worker_key) do update set
          worker_id=excluded.worker_id,
          process_started_at=case
            when worker_progress.worker_id is distinct from excluded.worker_id
              then excluded.process_started_at
            else worker_progress.process_started_at
          end,
          cycle_token=excluded.cycle_token,
          cycle_sequence=worker_progress.cycle_sequence + 1,
          cycle_running=true,
          last_attempted_cycle_at=excluded.last_attempted_cycle_at,
          last_cycle_ok=null,
          last_cycle_error_class=null,
          updated_at=clock_timestamp()
        returning cycle_sequence
      `;
      if (!rows[0]) throw Object.assign(new Error("Worker cycle progress was not recorded."), { code: "worker_progress_begin_failed" });
      return { cycleToken, attemptedAt: attempted, cycleSequence: Number(rows[0].cycle_sequence) };
    },

    async finishCycle({
      cycleToken,
      attemptedAt,
      completedAt = now(),
      ok,
      errorClass = null,
      jobCount = 0,
      controlEpoch = null,
    } = {}) {
      const completed = date(completedAt) || new Date();
      const attempted = date(attemptedAt) || completed;
      const durationMs = Math.max(0, Math.min(86_400_000, completed.getTime() - attempted.getTime()));
      const failureClass = ok ? null : safeWorkerErrorClass(errorClass, "worker_cycle_failed");
      const rows = await sql`
        update submissions_v2.worker_progress
           set cycle_running=false,
               last_completed_cycle_at=${completed.toISOString()},
               last_successful_cycle_at=case when ${Boolean(ok)} then ${completed.toISOString()} else last_successful_cycle_at end,
               last_cycle_ok=${Boolean(ok)},
               last_cycle_error_class=${failureClass},
               last_failure_at=case when ${Boolean(ok)} then last_failure_at else ${completed.toISOString()} end,
               last_failure_error_class=case when ${Boolean(ok)} then last_failure_error_class else ${failureClass} end,
               last_cycle_job_count=${Math.max(0, Math.min(10_000, Number(jobCount) || 0))},
               last_cycle_control_epoch=${controlEpoch == null ? null : Math.max(0, Number(controlEpoch) || 0)},
               last_cycle_duration_ms=${durationMs},
               updated_at=clock_timestamp()
         where worker_key=${key} and worker_id=${owner} and cycle_token=${cycleToken}
        returning cycle_sequence
      `;
      if (!rows[0]) throw Object.assign(new Error("Worker cycle progress fence changed."), { code: "worker_progress_fence_lost" });
      return { cycleSequence: Number(rows[0].cycle_sequence), completedAt: completed.toISOString() };
    },

    async readReadiness({
      enabledKinds = [],
      staleAfterMs = DEFAULT_STALE_AFTER_MS,
      observedAt = now(),
    } = {}) {
      const current = date(observedAt) || new Date();
      const kinds = [...new Set(enabledKinds.map((value) => String(value)).filter(Boolean))];
      const [progressRows, queueRows, sourceRows] = await Promise.all([
        sql`select * from submissions_v2.worker_progress where worker_key=${key} limit 1`,
        sql`
          with current_controls as (
            select * from submissions_v2.runtime_controls where singleton=true
          ), classified as (
            select job.*,
                   submissions_v2.worker_job_service_class(job.kind) as service_class,
                   controls.control_epoch as current_control_epoch,
                   submissions_v2.job_control_enabled(job.required_control, controls) as control_enabled
              from submissions_v2.jobs job
              cross join current_controls controls
             where cardinality(${sql.array(kinds)})=0 or job.kind=any(${sql.array(kinds)})
          )
          select fairness.service_class,
                 fairness.weight,
                 fairness.max_service_gap_seconds,
                 fairness.last_claimed_at,
                 fairness.claim_count::bigint,
                 count(classified.id) filter (
                   where classified.control_enabled
                     and classified.scheduled_at <= clock_timestamp()
                     and classified.attempt_count < classified.max_attempts
                     and (classified.state='queued'
                       or (classified.state='running' and classified.lease_expires_at < clock_timestamp()))
                 )::integer as runnable_count,
                 count(classified.id) filter (
                   where classified.state='running' and classified.lease_expires_at >= clock_timestamp()
                 )::integer as running_count,
                 count(classified.id) filter (where classified.state='held')::integer as held_count,
                 count(classified.id) filter (
                   where classified.state='failed'
                      or (classified.state in ('queued','running') and classified.attempt_count >= classified.max_attempts)
                 )::integer as exhausted_count,
                 extract(epoch from (
                   clock_timestamp() - min(classified.scheduled_at) filter (
                     where classified.control_enabled
                       and classified.scheduled_at <= clock_timestamp()
                       and classified.attempt_count < classified.max_attempts
                       and (classified.state='queued'
                         or (classified.state='running' and classified.lease_expires_at < clock_timestamp()))
                   )
                 ))::integer as oldest_runnable_age_seconds
            from submissions_v2.worker_service_fairness fairness
            left join classified on classified.service_class=fairness.service_class
           group by fairness.service_class, fairness.weight,
                    fairness.max_service_gap_seconds, fairness.last_claimed_at,
                    fairness.claim_count
           order by case fairness.service_class
             when 'live_intake' then 0 when 'decision' then 1 when 'proof' then 2
             when 'outbox' then 3 when 'resume' then 4 else 5 end
        `,
        sql`
          select source_key, updated_at, last_full_success_at,
                 (lease_expires_at >= clock_timestamp()) as lease_active,
                 extract(epoch from (clock_timestamp() - updated_at))::integer as progress_age_seconds,
                 extract(epoch from (clock_timestamp() - last_full_success_at))::integer as full_success_age_seconds
            from submissions_v2.source_cursors
           order by source_key
        `,
      ]);
      const progress = progressRows[0] || null;
      const attemptedAt = progress?.last_attempted_cycle_at || null;
      const attemptAgeMs = attemptedAt == null ? null : Math.max(0, current.getTime() - date(attemptedAt).getTime());
      const boundedStaleAfterMs = Math.max(30_000, Math.min(86_400_000, Number(staleAfterMs) || DEFAULT_STALE_AFTER_MS));
      const reason = readinessReason({ progress, workerId: owner, attemptAgeMs, staleAfterMs: boundedStaleAfterMs });
      const ready = reason === "ready" || reason === "cycle_in_progress";
      const queue = queueRows.map((row) => ({
        service_class: row.service_class,
        weight: Number(row.weight),
        max_service_gap_seconds: Number(row.max_service_gap_seconds),
        last_claimed_at: iso(row.last_claimed_at),
        claim_count: Number(row.claim_count),
        runnable_count: Number(row.runnable_count),
        running_count: Number(row.running_count),
        held_count: Number(row.held_count),
        exhausted_count: Number(row.exhausted_count),
        oldest_runnable_age_seconds: row.oldest_runnable_age_seconds == null ? null : Number(row.oldest_runnable_age_seconds),
      }));
      const sources = sourceRows.map((row) => ({
        source_key: row.source_key,
        progress_at: iso(row.updated_at),
        progress_age_seconds: row.progress_age_seconds == null ? null : Number(row.progress_age_seconds),
        last_full_success_at: iso(row.last_full_success_at),
        full_success_age_seconds: row.full_success_age_seconds == null ? null : Number(row.full_success_age_seconds),
        lease_active: Boolean(row.lease_active),
      }));
      return {
        ok: ready,
        ready,
        status: ready ? "ready" : "not_ready",
        reason,
        worker_id: owner,
        process_started_at: iso(progress?.process_started_at || startedAt),
        cycle_running: Boolean(progress?.cycle_running),
        cycle_sequence: Number(progress?.cycle_sequence || 0),
        last_attempted_cycle_at: iso(attemptedAt),
        last_attempted_cycle_age_seconds: secondsSince(attemptedAt, current),
        last_completed_cycle_at: iso(progress?.last_completed_cycle_at),
        last_successful_cycle_at: iso(progress?.last_successful_cycle_at),
        last_successful_cycle_age_seconds: secondsSince(progress?.last_successful_cycle_at, current),
        last_cycle_ok: progress?.last_cycle_ok == null ? null : Boolean(progress.last_cycle_ok),
        last_cycle_error_class: progress?.last_cycle_error_class || null,
        last_failure_at: iso(progress?.last_failure_at),
        last_failure_error_class: progress?.last_failure_error_class || null,
        last_cycle_job_count: Number(progress?.last_cycle_job_count || 0),
        last_cycle_control_epoch: progress?.last_cycle_control_epoch == null ? null : Number(progress.last_cycle_control_epoch),
        last_cycle_duration_ms: progress?.last_cycle_duration_ms == null ? null : Number(progress.last_cycle_duration_ms),
        queue,
        sources,
      };
    },
  };
}

export const workerProgressInternals = Object.freeze({
  DEFAULT_STALE_AFTER_MS,
  readinessReason,
  secondsSince,
});
