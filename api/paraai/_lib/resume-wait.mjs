export const DEFAULT_RESUME_WAIT_MINUTES = 60;
export const DEFAULT_RESUME_RETRY_DAYS = 7;
export const MIN_RESUME_TERMINAL_ACK_HOURS = 1;
export const DEFAULT_RESUME_TERMINAL_ACK_HOURS = 24;
export const MAX_RESUME_TERMINAL_ACK_HOURS = 72;
export const MIN_RESUME_BACKFILL_TERMINAL_ACK_DAYS = 14;
export const DEFAULT_RESUME_BACKFILL_TERMINAL_ACK_DAYS = 21;
export const MAX_RESUME_BACKFILL_TERMINAL_ACK_DAYS = 30;
export const RESUME_RECEIVED_REVIEW_CODE = "resume_received_review";
export const RESUME_RECEIVED_REVIEW_MESSAGE =
  "Resume received but attachment failed PDF/conversion QA; review the received artifact manually";
export const RESUME_ATTACHMENT_PENDING_REVIEW_CODE =
  "resume_attachment_pending_after_7_days";
export const RESUME_ATTACHMENT_PENDING_REVIEW_MESSAGE =
  "Resume was received but is still pending profile attachment after 7 days";

const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
const RESUME_CHASE_TOUCH_1_DELAY_MS = 2 * HOUR_MS;

function finiteDate(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export function resumeChaseNextDeliveryAckDeadline(
  chain,
  {
    terminalAckHours = DEFAULT_RESUME_TERMINAL_ACK_HOURS,
  } = {},
) {
  const claims = chain?.claims && typeof chain.claims === "object"
    ? chain.claims
    : {};
  const delivered = Object.entries(claims)
    .map(([key, claim]) => ({
      touch: Number(claim?.touch ?? key),
      deliveredAt: finiteDate(claim?.deliveredAt),
    }))
    .filter(({ touch, deliveredAt }) => (
      [1, 2].includes(touch) && deliveredAt != null
    ))
    .sort((left, right) => (
      right.touch - left.touch
      || right.deliveredAt - left.deliveredAt
    ))[0];
  if (!delivered) return null;
  const configuredHours = Number(terminalAckHours);
  const ackHours = Number.isFinite(configuredHours)
    ? Math.max(
        MIN_RESUME_TERMINAL_ACK_HOURS,
        Math.min(MAX_RESUME_TERMINAL_ACK_HOURS, configuredHours),
      )
    : DEFAULT_RESUME_TERMINAL_ACK_HOURS;
  const spacingDays = delivered.touch === 1 ? 3 : 4;
  return (
    delivered.deliveredAt
    + spacingDays * DAY_MS
    + ackHours * 60 * 60_000
  );
}

export function resumeChaseInitialAckDeadline({
  source = "organic",
  enteredAt,
  callEndedAt = enteredAt,
  terminalAckHours = DEFAULT_RESUME_TERMINAL_ACK_HOURS,
  backfillTerminalAckDays =
    DEFAULT_RESUME_BACKFILL_TERMINAL_ACK_DAYS,
} = {}) {
  const entered = finiteDate(enteredAt);
  if (entered == null) return null;
  if (["authorized_backfill", "phase1_sweep"].includes(String(source || ""))) {
    const configuredDays = Number(backfillTerminalAckDays);
    const days = Number.isFinite(configuredDays)
      ? Math.max(
          MIN_RESUME_BACKFILL_TERMINAL_ACK_DAYS,
          Math.min(
            MAX_RESUME_BACKFILL_TERMINAL_ACK_DAYS,
            configuredDays,
          ),
        )
      : DEFAULT_RESUME_BACKFILL_TERMINAL_ACK_DAYS;
    return entered + days * DAY_MS;
  }
  const configuredHours = Number(terminalAckHours);
  const ackHours = Number.isFinite(configuredHours)
    ? Math.max(
        MIN_RESUME_TERMINAL_ACK_HOURS,
        Math.min(MAX_RESUME_TERMINAL_ACK_HOURS, configuredHours),
      )
    : DEFAULT_RESUME_TERMINAL_ACK_HOURS;
  const ended = finiteDate(callEndedAt) ?? entered;
  const touch1DueAt = ended + RESUME_CHASE_TOUCH_1_DELAY_MS;
  return Math.max(touch1DueAt, entered) + ackHours * HOUR_MS;
}

export function resumeWaitSettings(env = process.env) {
  const configuredWait = Number(env.PARAAI_RESUME_WAIT_MINUTES);
  const configuredRetryDays = Number(env.PARAAI_RESUME_RETRY_DAYS);
  const configuredTerminalAckHours = Number(
    env.PARAAI_RESUME_TERMINAL_ACK_HOURS,
  );
  const configuredBackfillTerminalAckDays = Number(
    env.PARAAI_RESUME_BACKFILL_TERMINAL_ACK_DAYS,
  );
  return {
    waitMinutes: Number.isFinite(configuredWait)
      ? Math.max(0, configuredWait)
      : DEFAULT_RESUME_WAIT_MINUTES,
    retryDays: Number.isFinite(configuredRetryDays)
      ? Math.max(1, Math.min(30, Math.floor(configuredRetryDays)))
      : DEFAULT_RESUME_RETRY_DAYS,
    terminalAckHours: Number.isFinite(configuredTerminalAckHours)
      ? Math.max(
          MIN_RESUME_TERMINAL_ACK_HOURS,
          Math.min(
            MAX_RESUME_TERMINAL_ACK_HOURS,
            configuredTerminalAckHours,
          ),
        )
      : DEFAULT_RESUME_TERMINAL_ACK_HOURS,
    backfillTerminalAckDays:
      Number.isFinite(configuredBackfillTerminalAckDays)
        ? Math.max(
            MIN_RESUME_BACKFILL_TERMINAL_ACK_DAYS,
            Math.min(
              MAX_RESUME_BACKFILL_TERMINAL_ACK_DAYS,
              configuredBackfillTerminalAckDays,
            ),
          )
        : DEFAULT_RESUME_BACKFILL_TERMINAL_ACK_DAYS,
  };
}

export function resumeWaitPlan({
  source = "organic",
  anchorAt,
  callEndedAt = anchorAt,
  waitMinutes = DEFAULT_RESUME_WAIT_MINUTES,
  retryDays = DEFAULT_RESUME_RETRY_DAYS,
  terminalAckHours = DEFAULT_RESUME_TERMINAL_ACK_HOURS,
  backfillTerminalAckDays =
    DEFAULT_RESUME_BACKFILL_TERMINAL_ACK_DAYS,
} = {}) {
  const anchor = finiteDate(anchorAt);
  if (anchor == null) throw new Error("valid resume-wait anchor required");
  const normalizedWaitMinutes = Number.isFinite(Number(waitMinutes))
    ? Math.max(0, Number(waitMinutes))
    : DEFAULT_RESUME_WAIT_MINUTES;
  const normalizedRetryDays = Number.isFinite(Number(retryDays))
    ? Math.max(1, Math.min(30, Math.floor(Number(retryDays))))
    : DEFAULT_RESUME_RETRY_DAYS;
  const firstCheckAt = anchor + normalizedWaitMinutes * 60_000;
  const expiresAt = anchor + normalizedRetryDays * DAY_MS;
  const claimableThroughAt = resumeChaseInitialAckDeadline({
    source,
    enteredAt: anchor,
    callEndedAt,
    terminalAckHours,
    backfillTerminalAckDays,
  });
  return {
    source: String(source || "organic").slice(0, 80),
    enteredAt: new Date(anchor).toISOString(),
    firstCheckAt: new Date(firstCheckAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    claimableThroughAt: new Date(claimableThroughAt).toISOString(),
    scheduledChecks: 0,
    nextCheckAt: new Date(firstCheckAt).toISOString(),
    lastCheckedAt: null,
    lastTrigger: null,
  };
}

export function resumeWaitPlanFromEnv({
  source = "organic",
  anchorAt,
  env = process.env,
} = {}) {
  const settings = resumeWaitSettings(env);
  return resumeWaitPlan({
    source,
    anchorAt,
    waitMinutes: settings.waitMinutes,
    retryDays: settings.retryDays,
    terminalAckHours: settings.terminalAckHours,
    backfillTerminalAckDays: settings.backfillTerminalAckDays,
  });
}
