// Durable snapshot store for the Sequences page's campaign dropdown
// (api/seq/sequences.mjs).
//
// WHY (2026-09-26 Paraform read-cut pass): GET /api/seq/sequences used to
// call listSequences() — a live Paraform campaigns read — on every page
// load, with no cache at all. That is exactly the kind of always-open-tab,
// no-brake read flagged in
// docs/research/paraform-quota-plan-2026-09-25.md ("Put a brake or cache on
// the unbraked readers" -> "Sequences list: serve it from the stored
// snapshot").
//
// CONTRACT: an ordinary page load reads this snapshot only — zero Paraform
// traffic. The list of campaigns changes on the order of days (a new
// sequence, a rename), never mid-session, so a snapshot that is minutes or
// hours old is exactly as useful to an operator picking a target sequence
// as a live read would be. A live read happens only behind the page's
// explicit "Refresh list" action, and even that is paced by a shared lock.
//
// Same small single-purpose Upstash REST KV client shape as every other
// *-kv-cache module in this repo (api/health/_lib/kv.mjs,
// api/revenue/_lib/store.mjs, api/roster/_lib/status-kv-cache.mjs), owning
// its own `seq:v1:sequences-snapshot*` keys.
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

const SNAPSHOT_KEY = "seq:v1:sequences-snapshot";
const REFRESH_LOCK_KEY = "seq:v1:sequences-refresh-lock";
// Stale-but-present beats absent: a KV blip or a quiet weekend should still
// show the operator the last known list, labeled old, not an empty dropdown.
const SNAPSHOT_TTL_SECONDS = 14 * 24 * 60 * 60;
// Paces the *live* refresh action only; ordinary page loads never wait on
// this at all.
export const REFRESH_MIN_INTERVAL_MS = 2 * 60 * 1000;

/** Reads never throw: a KV blip must not blank the dropdown. */
export async function readSequencesSnapshot() {
  try {
    const raw = await kv(["GET", SNAPSHOT_KEY]);
    if (raw == null) return null;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.sequences) || !parsed.fetchedAt) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeSequencesSnapshot(sequences) {
  const record = { sequences, fetchedAt: new Date().toISOString() };
  try {
    await kv(["SET", SNAPSHOT_KEY, JSON.stringify(record), "EX", String(SNAPSHOT_TTL_SECONDS)]);
  } catch {
    // A write failure only costs the next reader a rebuild.
  }
  return record;
}

/**
 * Claims the right to run a live refresh right now. Fails OPEN when KV is
 * not configured or unreachable (never block an operator's explicit click
 * on control-plane plumbing) — the snapshot-serving default above is what
 * actually keeps steady-state page loads off Paraform; this only stops a
 * rapid double-click or two open tabs from both refreshing at once.
 */
export async function claimSequencesRefreshWindow({ minIntervalMs = REFRESH_MIN_INTERVAL_MS } = {}) {
  if (!kvConfigured()) return true;
  try {
    const seconds = Math.max(1, Math.ceil(minIntervalMs / 1000));
    const won = await kv(["SET", REFRESH_LOCK_KEY, String(Date.now()), "NX", "EX", String(seconds)]);
    return won === "OK";
  } catch {
    return true;
  }
}

export function sequencesSnapshotAgeMs(snapshot, now = Date.now()) {
  if (!snapshot?.fetchedAt) return null;
  const at = Date.parse(snapshot.fetchedAt);
  return Number.isFinite(at) ? Math.max(0, now - at) : null;
}
