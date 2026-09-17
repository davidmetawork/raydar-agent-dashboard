import { createHash, timingSafeEqual } from "node:crypto";

import { canonicalBackgroundPauseRecord } from "../../_lib/paraform-background-pause.mjs";
import { beginCommand, completeCommand } from "./command-store.mjs";
import { database } from "./db.mjs";

export const SUBMISSIONS_V2_BACKGROUND_PAUSE_SCOPE = "submissionsV2Worker";

const OWNER = "paraform-background-pause@raydar.xyz";
const PAUSE_ACTION = "submissions_v2_background_pause";
const RESUME_ACTION = "submissions_v2_background_resume";
const PAUSE_REASON_PREFIX = `paraform_background_pause:${SUBMISSIONS_V2_BACKGROUND_PAUSE_SCOPE}:`;
const RESUME_REASON_PREFIX = `paraform_background_resume:${SUBMISSIONS_V2_BACKGROUND_PAUSE_SCOPE}:`;
const FLAG_FIELDS = Object.freeze({
  ui: "ui_enabled",
  ingestion: "ingestion_enabled",
  generation: "generation_enabled",
  masterInbox: "master_inbox_enabled",
  curated: "curated_enabled",
});
function problem(code, message, status) {
  return Object.assign(new Error(message), { code, status });
}

function equalSecret(left, right) {
  if (!left || !right) return false;
  const a = createHash("sha256").update(String(left)).digest();
  const b = createHash("sha256").update(String(right)).digest();
  return a.length === b.length && timingSafeEqual(a, b);
}

function runnerAuthorized(req, env) {
  const token = String(req?.headers?.authorization || "").replace(/^Bearer\s+/iu, "");
  return equalSecret(token, env.PARAAI_AUTOMATION_RUNNER_KEY);
}

function bodyOf(req) {
  if (typeof req?.body === "string") {
    try { return JSON.parse(req.body || "{}"); }
    catch { return null; }
  }
  return req?.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
}

function validPauseId(value) {
  if (typeof value !== "string") return false;
  return canonicalBackgroundPauseRecord(value) !== null;
}

function flags(row) {
  return Object.fromEntries(Object.entries(FLAG_FIELDS).map(([name, field]) => [name, row?.[field] === true]));
}

function sameFlags(left, right) {
  return Object.keys(FLAG_FIELDS).every((name) => left?.[name] === right?.[name]);
}

function exactFlags(value) {
  return value && Object.keys(FLAG_FIELDS).every((name) => typeof value[name] === "boolean");
}

function pausedFlags(before) {
  return {
    ui: before.ui,
    ingestion: false,
    generation: false,
    masterInbox: before.masterInbox,
    curated: before.curated,
  };
}

function pauseReason(pauseId) {
  return `${PAUSE_REASON_PREFIX}${pauseId}`;
}

function resumeReason(pauseId) {
  return `${RESUME_REASON_PREFIX}${pauseId}`;
}

function pauseKey(pauseId) {
  return `background-pause:${SUBMISSIONS_V2_BACKGROUND_PAUSE_SCOPE}:${pauseId}`;
}

function resumeKey(pauseId) {
  return `background-resume:${SUBMISSIONS_V2_BACKGROUND_PAUSE_SCOPE}:${pauseId}`;
}

function pauseResultOwnsCurrent(result, current) {
  return result?.scope === SUBMISSIONS_V2_BACKGROUND_PAUSE_SCOPE
    && validPauseId(result?.pause_id)
    && Number.isInteger(Number(result?.paused_control_epoch))
    && Number(result.paused_control_epoch) === Number(current?.control_epoch)
    && result.paused_reason === pauseReason(result.pause_id)
    && result.paused_reason === current?.reason
    && current?.actor_email === OWNER
    && exactFlags(result?.before)
    && exactFlags(result?.paused)
    && sameFlags(result.paused, pausedFlags(result.before))
    && sameFlags(result.paused, flags(current));
}

function publicStatus(current, record) {
  if (!record || !pauseResultOwnsCurrent(record, current)) {
    if (current?.actor_email === OWNER && String(current?.reason || "").startsWith(PAUSE_REASON_PREFIX)) {
      return { paused: true, controlState: "invalid", pauseId: null, controlEpoch: Number(current.control_epoch) };
    }
    return { paused: false, controlState: "absent", pauseId: null };
  }
  return {
    paused: true,
    controlState: "paused",
    pauseId: record.pause_id,
    controlEpoch: Number(current.control_epoch),
    restore: {
      scope: record.scope,
      pauseId: record.pause_id,
      before: { ...record.before },
      pausedControlEpoch: Number(record.paused_control_epoch),
      pausedReason: record.paused_reason,
    },
  };
}

async function lockControls(tx) {
  const rows = await tx`select * from submissions_v2.lock_runtime_controls()`;
  const current = rows[0];
  if (!current) throw problem("submissions_v2_controls_unavailable", "Submissions V2 controls are unavailable.", 503);
  return current;
}

async function activePauseRecord(tx, current) {
  const rows = await tx`
    select result
      from submissions_v2.api_commands
     where actor_email=${OWNER}
       and action=${PAUSE_ACTION}
       and status='succeeded'
       and result->>'scope'=${SUBMISSIONS_V2_BACKGROUND_PAUSE_SCOPE}
       and result->>'paused_control_epoch'=${String(current.control_epoch)}
       and result->>'paused_reason'=${String(current.reason || "")}
     order by completed_at desc
     limit 1
  `;
  const result = rows[0]?.result || null;
  return pauseResultOwnsCurrent(result, current) ? result : null;
}

async function pauseRecord(tx, pauseId) {
  const rows = await tx`
    select result
      from submissions_v2.api_commands
     where actor_email=${OWNER}
       and action=${PAUSE_ACTION}
       and idempotency_key=${pauseKey(pauseId)}
       and status='succeeded'
     for update
  `;
  const result = rows[0]?.result || null;
  if (
    result?.scope !== SUBMISSIONS_V2_BACKGROUND_PAUSE_SCOPE
    || result?.pause_id !== pauseId
    || !exactFlags(result?.before)
    || !exactFlags(result?.paused)
    || !sameFlags(result.paused, pausedFlags(result.before))
  ) return null;
  return result;
}

async function setControls(tx, { reason, values }) {
  const rows = await tx`
    select * from submissions_v2.set_runtime_controls(
      ${OWNER}, ${reason}, ${values.ui}, ${values.ingestion}, ${values.generation},
      ${values.masterInbox}, ${values.curated}
    )
  `;
  const updated = rows[0];
  if (!updated) throw problem("submissions_v2_controls_unavailable", "Submissions V2 controls are unavailable.", 503);
  return updated;
}

async function readStatus(tx) {
  const current = await lockControls(tx);
  return publicStatus(current, await activePauseRecord(tx, current));
}

async function applyPause(tx, pauseId) {
  const current = await lockControls(tx);
  const started = await beginCommand(tx, {
    actorEmail: OWNER,
    action: PAUSE_ACTION,
    idempotencyKey: pauseKey(pauseId),
    input: { scope: SUBMISSIONS_V2_BACKGROUND_PAUSE_SCOPE, pauseId },
  });
  if (started.replay) {
    if (!pauseResultOwnsCurrent(started.result, current)) {
      throw problem("pause_state_conflict", "This pause id was already consumed and no longer owns the current controls.", 409);
    }
    return { ...publicStatus(current, started.result), action: "pause", alreadyPaused: true };
  }

  const active = await activePauseRecord(tx, current);
  if (active) throw problem("pause_state_conflict", "Another owned pause currently controls Submissions V2.", 409);
  if (current?.actor_email === OWNER && String(current?.reason || "").startsWith(PAUSE_REASON_PREFIX)) {
    throw problem("pause_state_conflict", "The current controls contain an invalid owned pause state.", 409);
  }

  const before = flags(current);
  const paused = pausedFlags(before);
  const reason = pauseReason(pauseId);
  const updated = await setControls(tx, { reason, values: paused });
  const result = {
    scope: SUBMISSIONS_V2_BACKGROUND_PAUSE_SCOPE,
    pause_id: pauseId,
    before,
    paused,
    paused_control_epoch: Number(updated.control_epoch),
    paused_reason: reason,
  };
  if (!pauseResultOwnsCurrent(result, updated)) {
    throw problem("pause_state_conflict", "The pause did not acquire the exact runtime-control state.", 409);
  }
  await completeCommand(tx, started.command.id, result);
  return { ...publicStatus(updated, result), action: "pause", alreadyPaused: false };
}

async function applyResume(tx, pauseId) {
  const current = await lockControls(tx);
  const started = await beginCommand(tx, {
    actorEmail: OWNER,
    action: RESUME_ACTION,
    idempotencyKey: resumeKey(pauseId),
    input: { scope: SUBMISSIONS_V2_BACKGROUND_PAUSE_SCOPE, pauseId },
  });
  if (started.replay) return { ...started.result, action: "resume", alreadyResumed: true };

  const owned = await pauseRecord(tx, pauseId);
  if (!owned || !pauseResultOwnsCurrent(owned, current)) {
    throw problem("pause_state_conflict", "The current controls are not the exact state owned by this pause id.", 409);
  }

  const reason = resumeReason(pauseId);
  const updated = await setControls(tx, { reason, values: owned.before });
  const restored = flags(updated);
  if (!sameFlags(restored, owned.before) || Number(updated.control_epoch) !== Number(owned.paused_control_epoch) + 1
    || updated.reason !== reason || updated.actor_email !== OWNER) {
    throw problem("pause_state_conflict", "The original runtime-control state was not restored exactly.", 409);
  }
  const result = {
    paused: false,
    controlState: "absent",
    pauseId: null,
    restoredControlEpoch: Number(updated.control_epoch),
  };
  await completeCommand(tx, started.command.id, result);
  return { ...result, action: "resume", alreadyResumed: false };
}

export function createSubmissionsV2BackgroundPauseControl({ sql = database() } = {}) {
  return {
    status: () => sql.begin((tx) => readStatus(tx)),
    apply: ({ action, pauseId }) => sql.begin((tx) => action === "pause" ? applyPause(tx, pauseId) : applyResume(tx, pauseId)),
  };
}

export async function handleSubmissionsV2BackgroundPause(req, res, {
  env = process.env,
  control = null,
} = {}) {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Vary", "Authorization");
  if (!runnerAuthorized(req, env)) return res.status(401).json({ ok: false, error: "unauthorized" });

  if (req.method === "GET") {
    if (req.query?.scope !== SUBMISSIONS_V2_BACKGROUND_PAUSE_SCOPE) {
      return res.status(400).json({ ok: false, error: "invalid_scope" });
    }
    const durable = control || createSubmissionsV2BackgroundPauseControl();
    return res.status(200).json({ ok: true, ...(await durable.status()) });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  const body = bodyOf(req);
  if (!body || body.scope !== SUBMISSIONS_V2_BACKGROUND_PAUSE_SCOPE) {
    return res.status(400).json({ ok: false, error: "invalid_scope" });
  }
  if (!["pause", "resume"].includes(body.action) || !validPauseId(body.pauseId)) {
    return res.status(400).json({ ok: false, error: "action_and_pauseId_required" });
  }
  const durable = control || createSubmissionsV2BackgroundPauseControl();
  return res.status(200).json({ ok: true, ...(await durable.apply({ action: body.action, pauseId: body.pauseId })) });
}

export const submissionsV2BackgroundPauseInternals = Object.freeze({
  OWNER,
  PAUSE_ACTION,
  RESUME_ACTION,
  flags,
  pausedFlags,
  pauseKey,
  resumeKey,
  pauseReason,
  resumeReason,
  pauseResultOwnsCurrent,
  publicStatus,
  readStatus,
  applyPause,
  applyResume,
  runnerAuthorized,
});
