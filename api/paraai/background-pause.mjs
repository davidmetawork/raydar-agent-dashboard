import {
  PARAFORM_BACKGROUND_PAUSE_KEYS,
  backgroundPauseKvCommand,
  backgroundPauseStatusFromRaw,
  canonicalBackgroundPauseRecord,
} from "../_lib/paraform-background-pause.mjs";
import { runnerAuthorized } from "../_lib/runner-key-auth.mjs";

const DEFAULT_SCOPE = "paraaiWorker";

const PAUSE_SCRIPT = `
  local inserted = redis.call('SET', KEYS[1], ARGV[1], 'NX')
  if inserted then return 1 end
  local existing = redis.call('GET', KEYS[1])
  if existing == ARGV[1] then return 2 end
  return 3
`;

const RESUME_SCRIPT = `
  local existing = redis.call('GET', KEYS[1])
  if not existing then return 1 end
  if existing == ARGV[1] then
    redis.call('DEL', KEYS[1])
    return 2
  end
  return 3
`;

function bodyOf(req) {
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body || "{}"); } catch { return {}; }
  }
  return req.body && typeof req.body === "object" ? req.body : {};
}

function requestedScope(req, body = null) {
  const raw = req.method === "GET" ? req.query?.scope : body?.scope;
  const scope = typeof raw === "string" && raw ? raw : DEFAULT_SCOPE;
  return Object.prototype.hasOwnProperty.call(PARAFORM_BACKGROUND_PAUSE_KEYS, scope)
    ? scope
    : null;
}

function statusPayload(raw) {
  const state = backgroundPauseStatusFromRaw(raw);
  if (state.state === "absent") {
    return { paused: false, controlState: "absent", pauseId: null };
  }
  if (state.state === "configured") {
    return { paused: true, controlState: "paused", pauseId: state.pauseId };
  }
  return { paused: true, controlState: "invalid", pauseId: null };
}

async function control(command, options) {
  return backgroundPauseKvCommand(command, options);
}

export async function handleBackgroundPause(req, res, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  controlImpl = control,
} = {}) {
  res.setHeader("Cache-Control", "no-store");
  // Deliberately only the dedicated runner key; CRON_SECRET cannot operate this
  // control plane, and no request reaches KV before this check.
  if (!runnerAuthorized(req, env)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  if (req.method === "GET") {
    const scope = requestedScope(req);
    if (!scope) return res.status(400).json({ ok: false, error: "invalid_scope" });
    try {
      const raw = await controlImpl([
        "GET",
        PARAFORM_BACKGROUND_PAUSE_KEYS[scope],
      ], { env, fetchImpl });
      return res.status(200).json({ ok: true, ...statusPayload(raw) });
    } catch {
      return res.status(503).json({ ok: false, error: "pause_control_unavailable" });
    }
  }
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "GET_or_POST_only" });
  }
  const body = bodyOf(req);
  const scope = requestedScope(req, body);
  if (!scope) return res.status(400).json({ ok: false, error: "invalid_scope" });
  const action = body.action;
  const expected = canonicalBackgroundPauseRecord(body.pauseId);
  if (!expected || !["pause", "resume"].includes(action)) {
    return res.status(400).json({ ok: false, error: "action_and_pauseId_required" });
  }
  const script = action === "pause" ? PAUSE_SCRIPT : RESUME_SCRIPT;
  try {
    const result = Number(await controlImpl([
      "EVAL",
      script,
      1,
      PARAFORM_BACKGROUND_PAUSE_KEYS[scope],
      expected,
    ], { env, fetchImpl }));
    if (result === 3 || ![1, 2].includes(result)) {
      return res.status(409).json({ ok: false, error: "pause_state_conflict" });
    }
    if (action === "pause") {
      return res.status(200).json({
        ok: true,
        action,
        paused: true,
        controlState: "paused",
        pauseId: body.pauseId,
        alreadyPaused: result === 2,
      });
    }
    return res.status(200).json({
      ok: true,
      action,
      paused: false,
      controlState: "absent",
      pauseId: null,
      alreadyResumed: result === 1,
    });
  } catch {
    return res.status(503).json({ ok: false, error: "pause_control_unavailable" });
  }
}

export default async function handler(req, res) {
  return handleBackgroundPause(req, res);
}
