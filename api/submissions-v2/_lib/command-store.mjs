import { createHash } from "node:crypto";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

export function requestDigest(action, input) {
  return createHash("sha256").update(JSON.stringify(canonical({ action, input }))).digest("hex");
}

export async function beginCommand(sql, { actorEmail, action, idempotencyKey, expectedVersion = null, pairId = null, input = {} }) {
  const digest = requestDigest(action, input);
  const inserted = await sql`
    insert into submissions_v2.api_commands(actor_email, action, idempotency_key, request_digest, expected_version, pair_id)
    values (${actorEmail}, ${action}, ${idempotencyKey}, ${digest}, ${expectedVersion}, ${pairId})
    on conflict (actor_email, idempotency_key) do nothing
    returning *
  `;
  if (inserted.length) return { command: inserted[0], replay: false };
  const rows = await sql`select * from submissions_v2.api_commands where actor_email=${actorEmail} and idempotency_key=${idempotencyKey} for update`;
  const existing = rows[0];
  if (!existing || existing.request_digest !== digest || existing.action !== action) throw Object.assign(new Error("This idempotency key was already used for a different request."), { code: "idempotency_conflict", status: 409 });
  if (existing.status === "succeeded") return { command: existing, replay: true, result: existing.result };
  if (existing.status === "failed") throw Object.assign(new Error("The original command failed; start a new deliberate request."), { code: existing.safe_error_code || "command_failed", status: 409 });
  throw Object.assign(new Error("The original command is still running."), { code: "command_in_progress", status: 409 });
}

export async function completeCommand(sql, commandId, result = {}, pairId = null) {
  const boundPairId = /^[0-9a-f-]{36}$/iu.test(String(pairId || "")) ? String(pairId) : null;
  const rows = await sql`
    update submissions_v2.api_commands
       set status='succeeded', result=${sql.json(result)}, completed_at=clock_timestamp(),
           pair_id=coalesce(pair_id, ${boundPairId}::uuid)
     where id=${commandId} and status='started' returning *
  `;
  if (!rows.length) throw Object.assign(new Error("Command completion lost its fence."), { code: "command_fence_lost", status: 409 });
  return rows[0];
}

export async function failCommand(sql, commandId, errorCode) {
  const rows = await sql`update submissions_v2.api_commands set status='failed', safe_error_code=${String(errorCode || "command_failed")}, completed_at=clock_timestamp() where id=${commandId} and status='started' returning *`;
  return rows[0] || null;
}
