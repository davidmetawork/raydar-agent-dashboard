// Self-imposed daily Talent Network submission budget.
//
// Paraform appears to stop accepting new Talent Network members after roughly
// 80 a day, and it does NOT refuse past that point — the mutation returns 200
// with no error while the candidate silently lands INELIGIBLE with no
// membership timestamp. Evidence is a single sharp cliff observed 2026-08-01:
// 163 submitted, 79 confirmed by read-back, ten prior days peaking at 79, and
// an immediate retry confirming 0 of 4. Paraform documents nothing, and
// getTalentNetworkDirectSubmitQuota returned null before being withdrawn
// entirely, so no API exposes the real number.
//
// Without a budget the lane discovers that ceiling by burning writes into a
// void. This stops one short of the observed cliff and defers the rest, so a
// batch day becomes predictable instead of silently lossy.
//
// ROLLING 24 HOURS, not a calendar day. We do not know when Paraform's counter
// resets. If ours reset at a different hour than theirs we could spend a fresh
// budget while they still counted the old period — the exact overshoot this
// exists to prevent. A rolling window cannot overshoot under ANY reset
// boundary; the cost is that throughput smooths out instead of arriving in a
// midnight burst, which for a backlog that drains over days is not a cost.

const WINDOW_MS = 24 * 60 * 60 * 1000;
const BUDGET_KEY = "paraai:submit-budget:v1";
const DEFAULT_BUDGET = 79;

export function dailySubmitBudget(raw = process.env.PARAAI_DAILY_SUBMIT_BUDGET) {
  // An unset or blank variable must mean "use the default", never zero.
  // Number("") is 0, so a trailing `PARAAI_DAILY_SUBMIT_BUDGET=` in an env file
  // would otherwise halt every automatic submission while looking configured —
  // exactly the class of silent stop this whole lane keeps getting bitten by.
  const text = String(raw ?? "").trim();
  if (!text) return DEFAULT_BUDGET;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_BUDGET;
  // An explicit 0 IS honoured: it halts automatic submission without touching
  // any approval flag, which is a safer kill switch than editing the gates.
  return Math.floor(value);
}

// Every attempt is counted, not every success. We are budgeting against
// Paraform's counter, and we cannot see it — a write that fails for our own
// reasons may still have consumed one of their slots, so counting attempts is
// the only conservative reading. Under-using the budget is harmless; over-
// running it is the silent loss this prevents.
export async function recordSubmitAttempt(
  jobId,
  { now = Date.now(), kvImpl } = {},
) {
  const member = `${now}:${String(jobId || "unknown")}`;
  await kvImpl(["ZADD", BUDGET_KEY, String(now), member]);
  await kvImpl(["ZREMRANGEBYSCORE", BUDGET_KEY, "-inf", String(now - WINDOW_MS)]);
  // The key must outlive the window even if nothing is submitted for a while.
  await kvImpl(["EXPIRE", BUDGET_KEY, String(Math.ceil((WINDOW_MS * 2) / 1000))]);
  return { recorded: true, at: now };
}

export async function submitBudgetState({
  now = Date.now(),
  limit = dailySubmitBudget(),
  kvImpl,
} = {}) {
  const floor = now - WINDOW_MS;
  const used = Number(await kvImpl(["ZCOUNT", BUDGET_KEY, String(floor), "+inf"])) || 0;
  const remaining = Math.max(0, limit - used);
  let nextFreeAt = null;
  if (remaining <= 0) {
    // The budget frees one slot at a time, as the oldest attempt ages out of
    // the window — so the next opportunity is the oldest attempt plus 24h, not
    // some arbitrary midnight.
    const oldest = await kvImpl(["ZRANGE", BUDGET_KEY, "0", "0", "WITHSCORES"]);
    const score = Array.isArray(oldest) ? Number(oldest[1]) : NaN;
    nextFreeAt = Number.isFinite(score) ? score + WINDOW_MS : now + 60 * 60_000;
  }
  return { limit, used, remaining, nextFreeAt, windowMs: WINDOW_MS };
}

// Returns null when the write may proceed, or a reschedule instruction when it
// may not. Deliberately shaped as a DEFERRAL rather than an error: the job is
// perfectly good and nothing about it needs review — it is simply waiting for
// a slot, and it must stay queued so the backlog drains on its own.
export async function submitBudgetGate({
  now = Date.now(),
  limit = dailySubmitBudget(),
  kvImpl,
} = {}) {
  const state = await submitBudgetState({ now, limit, kvImpl });
  if (state.remaining > 0) return null;
  const delayMs = Math.max(
    60_000,
    Math.min(6 * 60 * 60_000, (state.nextFreeAt ?? now + 60 * 60_000) - now),
  );
  return {
    action: "reschedule",
    delayMs,
    detail: `daily Talent Network submit budget spent (${state.used}/${state.limit} in the last 24h); deferred`,
    budget: state,
  };
}
