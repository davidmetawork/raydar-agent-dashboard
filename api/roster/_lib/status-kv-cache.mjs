// Durable, cross-instance snapshot store for the Candidates tab's Para AI
// status read (api/roster/paraai-status.mjs).
//
// WHY THIS EXISTS (2026-09-26 Paraform read-cut pass): the scan behind this
// endpoint (a 25-page CRM walk plus five sequence-lead walks) was previously
// guarded only by an in-memory, per-instance 5-minute TTL
// (createCrmSnapshotLoader / createOutcomeSequenceSnapshotLoader). Vercel
// does not guarantee instance reuse, and the front-end polled this endpoint
// every 60 seconds while the Candidates tab stayed open, with no ceiling —
// "up to ~36k Paraform reads a day per always-open tab" per
// docs/research/paraform-quota-plan-2026-09-25.md. A per-process cache
// cannot brake that; a shared store can.
//
// CONTRACT: an ordinary (non-refresh) request never touches Paraform. It
// reads the last computed snapshot from KV and labels its age. Only a
// request carrying `?refresh=1` (the operator's explicit "Refresh now"
// click) may trigger a live scan, and even that is paced by a shared lock
// so a double-click or two open tabs cannot fan out into two scans.
//
// Same Upstash REST KV as every other *-kv-cache module in this repo
// (api/health/_lib/kv.mjs, api/revenue/_lib/store.mjs) — a small,
// single-purpose module owning its own key namespace (`roster:v1:*`)
// rather than importing another feature's KV client.
const KV_URL = String(process.env.KV_REST_API_URL || "").replace(/\/+$/, "");
const KV_TOKEN = process.env.KV_REST_API_TOKEN || "";

export const kvConfigured = () => Boolean(KV_URL && KV_TOKEN);

async function kv(command) {
  if (!kvConfigured()) return null;
  const r = await fetch(KV_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${KV_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`kv ${r.status}`);
  const body = await r.json().catch(() => null);
  return body?.result ?? null;
}

// Stale-but-present beats absent: a KV blip or a long weekend without a
// refresh should still let the tab show its last known answer, labeled old,
// rather than an empty table.
const SNAPSHOT_TTL_SECONDS = 7 * 24 * 60 * 60;

// Paces the *live-scan* path only (an explicit `?refresh=1`). Ordinary reads
// are unaffected by this window — they always serve whatever is in KV.
export const REFRESH_MIN_INTERVAL_MS = 2 * 60 * 1000;

const snapshotKey = (mode) => `roster:v1:paraai-status:snapshot:${mode}`;
const refreshLockKey = (mode) => `roster:v1:paraai-status:refresh-lock:${mode}`;

/** Reads never throw: a KV blip must not blank the tab. */
export async function readStatusSnapshot(mode) {
  try {
    const raw = await kv(["GET", snapshotKey(mode)]);
    if (raw == null) return null;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== "object" || !parsed.fetchedAt) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeStatusSnapshot(mode, payload) {
  try {
    const record = { ...payload, fetchedAt: new Date().toISOString() };
    await kv(["SET", snapshotKey(mode), JSON.stringify(record), "EX", String(SNAPSHOT_TTL_SECONDS)]);
    return record;
  } catch {
    // A write failure only costs the next reader a rebuild; it must never
    // fail the request that already has a good result to answer with.
    return { ...payload, fetchedAt: new Date().toISOString() };
  }
}

/**
 * Attempts to claim the right to run a live scan right now. Returns true
 * only for the caller that wins the lock — except when KV is not configured
 * or not reachable at all, which fails OPEN on pacing alone (the snapshot
 * store, not this lock, is what keeps steady-state traffic off Paraform;
 * this only stops a rapid double-click or two open tabs from both scanning
 * at once, and it cannot do that job without a store to coordinate through).
 */
export async function claimRefreshWindow(mode, { minIntervalMs = REFRESH_MIN_INTERVAL_MS } = {}) {
  if (!kvConfigured()) return true;
  try {
    const seconds = Math.max(1, Math.ceil(minIntervalMs / 1000));
    const won = await kv(["SET", refreshLockKey(mode), String(Date.now()), "NX", "EX", String(seconds)]);
    return won === "OK";
  } catch {
    return true;
  }
}

export function snapshotAgeMs(snapshot, now = Date.now()) {
  if (!snapshot?.fetchedAt) return null;
  const at = Date.parse(snapshot.fetchedAt);
  return Number.isFinite(at) ? Math.max(0, now - at) : null;
}
