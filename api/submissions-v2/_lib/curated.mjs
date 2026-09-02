const DECISIVE = Object.freeze({ APPLIED_TO_ROLE: "interested", NOT_INTERESTED: "not_interested" });

export function diffCuratedSnapshots(previous = new Map(), observations = [], { seed = false } = {}) {
  const transitions = [];
  const next = new Map(previous);
  for (const item of observations) {
    const key = `${item.candidate_user_id}:${item.role_id}`;
    const status = String(item.status || "").toUpperCase();
    const prior = previous.get(key) || null;
    next.set(key, { status, observed_at: item.observed_at, digest: item.digest || null });
    if (seed || !prior || prior.status === status || !DECISIVE[status]) continue;
    transitions.push({
      source: "curated_list",
      candidate_user_id: item.candidate_user_id,
      role_id: item.role_id,
      prior_status: prior.status,
      decisive_status: status,
      intent: DECISIVE[status],
      signal_at: item.observed_at,
      idempotency_key: `curated:${item.candidate_user_id}:${item.role_id}:${item.digest || status}`,
    });
  }
  return { next, transitions };
}

export function curatedBatchPlan(population, { cursor = 0, batchSize = 100, maxBatch = 120 } = {}) {
  if (!Array.isArray(population) || population.some((row) => !row || typeof row !== "object" || !String(row.candidateUserId || "").trim())) {
    throw Object.assign(new Error("Curated population data is not authoritative."), { code: "curated_population_shape_invalid", retryable: true });
  }
  const sorted = [...population].sort((a, b) => String(a.candidateUserId).localeCompare(String(b.candidateUserId)));
  const start = Math.max(0, Number(cursor) || 0);
  const size = Math.min(maxBatch, Math.max(1, Number(batchSize) || 100));
  const rows = sorted.slice(start, start + size);
  return { rows, cursor: start, next_cursor: start + rows.length < sorted.length ? start + rows.length : null, cycle_complete: start + rows.length >= sorted.length };
}

export const CURATED_DECISIVE = DECISIVE;
