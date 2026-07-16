// Engine for the Prep control plane (candidate interview-prep documents).
// A signed-in Raydar user enqueues a job via /api/prepdoc/enqueue; a separate
// Fly runner polls /api/prepdoc/queue with its shared runner key, generates
// the PDF and a Gmail draft, and reports progress back via /api/prepdoc/report.
// State lives in the existing Upstash/Vercel KV store. Nothing here touches
// the frozen screener/dashboard data-feed wiring.

import { createHash, timingSafeEqual } from "node:crypto";
import { authConfig, cors, hasCookie, requireAuth } from "../../seq/_lib/core.mjs";
import { kv, pipeline, storeConfigured } from "../../sourcing/_lib/store.mjs";
import { listSourcingRoles } from "../../sourcing/_lib/core.mjs";

export { cors, hasCookie, kv, pipeline, storeConfigured };

// ---------- auth: browser side ----------
// Same Google ID-token gate the Sequences/Enrich tabs use, but FAIL-CLOSED:
// prep jobs end in someone's mailbox, so an un-configured gate refuses
// (503) instead of silently allowing (sourcing double-gate style).
export async function requirePrepAuth(req, res) {
  if (!authConfig().authRequired) {
    res.status(503).json({ ok: false, error: "auth_not_configured" });
    return false;
  }
  return requireAuth(req, res); // sets req.authedEmail on success
}

// ---------- auth: runner side ----------
// Shared-secret header for the Fly poller. Fail-closed 503 when the env is
// unset, 401 on mismatch. The key value is never logged or echoed.
const RUNNER_KEY = process.env.PREPDOC_RUNNER_KEY || "";

function equalSecret(a, b) {
  const left = createHash("sha256").update(String(a || "")).digest();
  const right = createHash("sha256").update(String(b || "")).digest();
  return timingSafeEqual(left, right);
}

export function requireRunnerKey(req, res) {
  if (!RUNNER_KEY) {
    res.status(503).json({ ok: false, error: "runner_key_not_configured" });
    return false;
  }
  const key = req.headers["x-runner-key"] || "";
  if (!key || !equalSecret(key, RUNNER_KEY)) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return false;
  }
  return true;
}

// ---------- job store ----------
// prepdoc:job:<id>  JSON job record (no PDF payload ever lives here)
// prepdoc:index     JSON array of job ids, newest first, capped
// prepdoc:pdf:<id>  base64 PDF payload, 30-day TTL
const JOB_PREFIX = "prepdoc:job:";
const INDEX_KEY = "prepdoc:index";
const PDF_PREFIX = "prepdoc:pdf:";
export const PDF_TTL_SECONDS = 30 * 24 * 60 * 60;
const INDEX_CAP = 200;

export const JOB_ID_RE = /^[a-zA-Z0-9-]{8,64}$/;
export const JOB_STATUSES = [
  "queued", "claimed", "fetching", "generating", "verifying", "drafting", "done", "failed",
];

const parse = (value, fallback = null) => {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
};

export async function getJob(id) {
  return parse(await kv(["GET", JOB_PREFIX + id]), null);
}

export async function saveJob(job) {
  await kv(["SET", JOB_PREFIX + job.id, JSON.stringify(job)]);
  return job;
}

// Atomic newest-first insert with cap, so two parallel enqueues can't drop
// each other's id in a read-modify-write race.
export async function indexAdd(id) {
  const script = `
    local raw = redis.call('GET', KEYS[1])
    local ids = {}
    if raw then
      local decoded = cjson.decode(raw)
      if type(decoded) == 'table' then ids = decoded end
    end
    local out = { ARGV[1] }
    local cap = tonumber(ARGV[2])
    for _, v in ipairs(ids) do
      if v ~= ARGV[1] and #out < cap then table.insert(out, v) end
    end
    redis.call('SET', KEYS[1], cjson.encode(out))
    return #out
  `;
  await kv(["EVAL", script, 1, INDEX_KEY, id, String(INDEX_CAP)]);
}

export async function indexIds() {
  const ids = parse(await kv(["GET", INDEX_KEY]), []);
  return Array.isArray(ids) ? ids.filter((x) => typeof x === "string" && x) : [];
}

export async function loadJobs(ids) {
  if (!ids.length) return [];
  const values = await pipeline(ids.map((id) => ["GET", JOB_PREFIX + id]));
  return values.map((v) => parse(v, null)).filter(Boolean);
}

export async function storePdf(id, base64) {
  await kv(["SET", PDF_PREFIX + id, base64, "EX", PDF_TTL_SECONDS]);
}

export async function getPdf(id) {
  const v = await kv(["GET", PDF_PREFIX + id]);
  return typeof v === "string" && v ? v : null;
}

// ---------- roles (for the picker) ----------
// Reuses the sourcing lib's cached role read (activeRoles.getActiveRoles via
// the PARAFORM_COOKIE tRPC client, normalized defensively across response
// shapes, filtered to recruiter user_status APPROVED, and protected by the
// sanctioned 2-reads/minute global limiter), then wraps it in prepdoc's own
// 30-minute cache so the picker almost never touches Paraform.
const ROLES_CACHE_KEY = "prepdoc:roles-cache";
const ROLES_CACHE_TTL_SECONDS = 30 * 60;

export async function listPrepRoles() {
  const cached = parse(await kv(["GET", ROLES_CACHE_KEY]), null);
  if (Array.isArray(cached) && cached.length) return cached;
  const roles = (await listSourcingRoles())
    .map((r) => ({ role_id: r.id, title: r.title, company: r.company || "" }))
    .filter((r) => r.role_id);
  if (roles.length) {
    await kv(["SET", ROLES_CACHE_KEY, JSON.stringify(roles), "EX", ROLES_CACHE_TTL_SECONDS]);
  }
  return roles;
}
