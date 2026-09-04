import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabase } from "../api/submissions-v2/_lib/db.mjs";
import { createRepository } from "../api/submissions-v2/_lib/repository.mjs";
import { roleInterestReplyEvents } from "../api/submissions-v2/_lib/gmail-interview-source.mjs";
import { decryptJson } from "../api/submissions-v2/_lib/private-data.mjs";
import { createBlobBrokerClient } from "./blob-broker-client.mjs";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (code) => Object.assign(new Error(code), { code });
const databaseUrl = (value) => /^postgres(?:ql)?:\/\//i.test(String(value || "").trim());
export const roleRepairPlanSignature = (digest, env = process.env) => {
  const key = String(env.SUBMISSIONS_V2_EMAIL_HMAC_KEY || "");
  if (key.length < 32) throw fail("repair_plan_signing_not_configured");
  return createHmac("sha256", key).update(`submissions-v2:role-repair-plan:v1\0${digest}`).digest("hex");
};
const equal = (left, right) => {
  const a = Buffer.from(String(left || "")); const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
};

export function roleRepairStoredPayload(blobRead, { env = process.env, eventId } = {}) {
  const bytes = blobRead?.bytes;
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw fail("repair_payload_read_invalid");
  let envelope;
  try { envelope = JSON.parse(Buffer.from(bytes).toString("utf8")); }
  catch { throw fail("repair_payload_invalid"); }
  return decryptJson(envelope, { env, context: `event:${eventId}` });
}

export function roleRepairBrokerRequest({ after, before, threadId }) {
  return { operation: "thread", scope: "interview_request_v1", after, before, threadId };
}

/** A repair may add exact roles, but cannot replace a message, sender, or authored reply. */
export function roleRepairEvidence({ source, storedPayload, event, candidate, roles = [] }) {
  const reject = (reason) => ({ signal_id: source.id, status: "review", reason });
  if (source.processing_state !== "needs_role" || source.provider !== "gmail") return reject("source_not_eligible");
  if (!source.encrypted_body_object_key) return reject("source_payload_missing");
  if (!event || !event.outbound_message_id || !event.offered_roles?.length) return reject("exact_outbound_role_missing");
  if (event.event_id !== source.event_id || event.provider_message_id !== source.provider_message_id
    || event.provider_thread_id !== source.provider_thread_id || event.outbound_message_id !== source.outbound_message_id
    || event.mailbox_id !== source.mailbox_id
    || Date.parse(event.received_at) !== Date.parse(source.received_at)) return reject("message_evidence_changed");
  if (event.sender_match_hmac?.digest !== source.sender_match_hmac_current
    || event.sender_match_hmac?.key_version !== source.sender_match_hmac_current_version) return reject("sender_evidence_changed");
  if (event.candidate_authored_text !== storedPayload?.candidate_authored_text) return reject("authored_reply_changed");
  if (event.sent_message_text !== storedPayload?.sent_message_text) return reject("outbound_content_changed");
  // The stored event reached Needs Review because its role parser found none.
  // Its digest must remain tied to that immutable reply/outbound pair, while the
  // replayed event separately proves the newly parsed exact role links.
  const storedContentDigest = hash({ candidateText: storedPayload.candidate_authored_text, sentText: storedPayload.sent_message_text, offered: [] });
  const replayContentDigest = hash({ candidateText: event.candidate_authored_text, sentText: event.sent_message_text, offered: event.offered_roles });
  if (source.content_digest !== storedContentDigest || event.content_digest !== replayContentDigest) return reject("content_evidence_changed");
  if (!candidate?.candidate_user_id || candidate.ambiguous) return reject("candidate_unresolved");
  const roleIds = [...new Set(event.offered_roles.map((role) => role.role_id))].sort();
  if (roleIds.length > 20 || roleIds.some((id) => !roles.some((role) => role.role_id === id && role.active))) return reject("role_unavailable");
  return {
    signal_id: source.id, status: "repairable", candidate_id: candidate.candidate_user_id,
    role_ids: roleIds, source_digest: source.content_digest,
    proof_digest: hash({ event_id: event.event_id, provider_message_id: event.provider_message_id,
      parent_message_id: event.outbound_message_id, received_at: event.received_at,
      candidate_text: event.candidate_authored_text, sent_text: event.sent_message_text, role_ids: roleIds }),
  };
}

export const roleRepairPlanDigest = (rows) => hash(rows);

export function reviewedRoleRepairPlan(value, { applyDigest, env = process.env } = {}) {
  if (value?.schema_version !== 1 || value?.mode !== "dry_run" || !Array.isArray(value?.plan)) throw fail("repair_reviewed_plan_invalid");
  const digest = roleRepairPlanDigest(value.plan);
  if (!/^[a-f0-9]{64}$/u.test(String(value.digest || "")) || value.digest !== digest || applyDigest !== digest
    || !equal(value.plan_signature, roleRepairPlanSignature(digest, env))) throw fail("repair_reviewed_plan_invalid");
  for (const row of value.plan) {
    if (!/^[0-9a-f-]{36}$/iu.test(String(row?.signal_id || "")) || !["repairable", "review"].includes(row?.status)) throw fail("repair_reviewed_plan_invalid");
    const repairableInvalid = !String(row.candidate_id || "") || !/^[a-f0-9]{64}$/iu.test(String(row.source_digest || ""))
      || !/^[a-f0-9]{64}$/iu.test(String(row.proof_digest || "")) || !Array.isArray(row.role_ids)
      || row.role_ids.length < 1 || row.role_ids.length > 20 || row.role_ids.some((roleId) => !/^[A-Za-z0-9_-]{1,200}$/u.test(String(roleId)));
    if (row.status === "repairable" && repairableInvalid) {
      throw fail("repair_reviewed_plan_invalid");
    }
  }
  return value.plan;
}

export async function readReviewedRoleRepairPlan(pathname, { applyDigest, env = process.env } = {}) {
  if (!isAbsolute(String(pathname || ""))) throw fail("repair_reviewed_plan_path_invalid");
  let file;
  try { file = await stat(pathname); } catch { throw fail("repair_reviewed_plan_unavailable"); }
  if (!file.isFile() || (file.mode & 0o077) !== 0) throw fail("repair_reviewed_plan_path_invalid");
  let parsed;
  try { parsed = JSON.parse(await readFile(pathname, "utf8")); } catch { throw fail("repair_reviewed_plan_invalid"); }
  reviewedRoleRepairPlan(parsed, { applyDigest, env });
  return parsed;
}

async function assertApiApplyAuthorization(sql) {
  const rows = await sql`
    select has_table_privilege(current_user, 'submissions_v2.api_commands', 'INSERT') as can_insert,
           has_table_privilege(current_user, 'submissions_v2.api_commands', 'UPDATE') as can_update
  `;
  if (!rows[0]?.can_insert || !rows[0]?.can_update) throw fail("repair_api_apply_database_not_authorized");
}

async function revalidateReviewedPlan(plan, { sql, repository, activation }) {
  for (const row of plan.filter((item) => item.status === "repairable")) {
    const source = await sql.begin("read only", async (tx) => (await tx`
      select s.* from submissions_v2.source_events s
       where s.id=${row.signal_id} and s.provider='gmail' and s.mailbox_id='david-raydar-xyz'
         and s.processing_state='needs_role' and s.received_at>=${new Date(activation)}
         and s.content_digest=${row.source_digest} and s.encrypted_body_object_key is not null
         and not exists(select 1 from submissions_v2.source_offered_roles r where r.signal_id=s.id)
         and exists(select 1 from submissions_v2.review_items r where r.unresolved_signal_id=s.id and r.action_state='open' and r.reason_code='role_unclear')
    `)[0]);
    if (!source) throw fail("repair_reviewed_plan_changed");
    const match = await repository.candidateMatches({ sender_match_hmac: { digest: source.sender_match_hmac_current } });
    if (match?.ambiguous || match?.candidate?.candidate_user_id !== row.candidate_id) throw fail("repair_reviewed_plan_changed");
    const roles = await sql.begin("read only", (tx) => tx`
      select role_id,active from submissions_v2.role_index where role_id=any(${tx.array(row.role_ids, 25)})
    `);
    if (roles.length !== row.role_ids.length || roles.some((role) => !role.active)) throw fail("repair_reviewed_plan_changed");
  }
}

/** Default is read-only; --apply must name the exact digest from the inspected dry run. */
export async function repairRoleEvidence({ env = process.env, limit = 50, applyDigest = null, reviewedPlan = null, fetchImpl = fetch } = {}) {
  const activation = Date.parse(env.SUBMISSIONS_V2_GMAIL_ACTIVATED_AT || "");
  if (!Number.isFinite(activation)) throw fail("gmail_activation_required");
  const applying = Boolean(applyDigest);
  const plan = applying ? reviewedRoleRepairPlan(reviewedPlan, { applyDigest, env }) : null;
  const selectedDatabaseUrl = applying ? env.SUBMISSIONS_V2_DATABASE_URL : env.SUBMISSIONS_V2_WORKER_DATABASE_URL;
  if (!databaseUrl(selectedDatabaseUrl)) throw fail(applying ? "repair_api_apply_database_required" : "repair_worker_database_required");
  const sql = createDatabase({ databaseUrl: selectedDatabaseUrl, max: 1 });
  const repository = createRepository({ sql, env });
  try {
    if (applying) {
      await assertApiApplyAuthorization(sql);
      const controls = await repository.runtimeControls();
      if (!controls?.ui_enabled || !controls.ingestion_enabled || !controls.master_inbox_enabled) throw fail("repair_intake_disabled");
      await revalidateReviewedPlan(plan, { sql, repository, activation });
      const result = { schema_version: 1, mode: "apply", digest: applyDigest, inspected: plan.length,
        repairable: plan.filter((row) => row.status === "repairable").length, plan, applied: [] };
      for (const row of plan.filter((item) => item.status === "repairable")) {
        try {
          const applied = await repository.bindUnresolvedSignal({
            actorEmail: "submissions-source-repair@raydar.internal",
            idempotencyKey: `source-role-repair-v1:${row.signal_id}:${row.proof_digest}`,
            signalId: row.signal_id, candidateId: row.candidate_id, roleIds: row.role_ids,
            note: `Automatic recovery from exact original Gmail parent and verified Paraform role links; proof ${row.proof_digest}; source digest ${row.source_digest}.`,
          });
          result.applied.push({ signal_id: row.signal_id, job_id: applied.job_id, status: "queued" });
        } catch (error) {
          if (!["first_response_already_recorded", "first_response_pending", "source_not_unresolved", "source_already_bound"].includes(error.code)) throw error;
          result.applied.push({ signal_id: row.signal_id, status: "review", reason: error.code });
        }
      }
      return result;
    }
    const key = String(env.SUBMISSIONS_V2_MASTER_INBOX_WORKER_KEY || "");
    if (key.length < 32) throw fail("gmail_read_broker_not_configured");
    const blobs = createBlobBrokerClient({ env });
    const sources = await sql.begin("read only", (tx) => tx`
      select s.* from submissions_v2.source_events s
       where s.provider='gmail' and s.mailbox_id='david-raydar-xyz' and s.processing_state='needs_role'
         and s.received_at>=${new Date(activation)}
         and not exists(select 1 from submissions_v2.source_offered_roles r where r.signal_id=s.id)
         and exists(select 1 from submissions_v2.review_items r where r.unresolved_signal_id=s.id and r.action_state='open' and r.reason_code='role_unclear')
       order by s.received_at,s.provider_message_id limit ${Math.max(1, Math.min(50, Number(limit) || 50))}
    `);
    const plan = [];
    for (const source of sources) {
      const at = Date.parse(source.received_at);
      const after = Math.max(activation, at - 1000);
      const before = Math.min(Date.now(), at + 1000);
      const response = await fetchImpl("https://raydar-master-inbox.vercel.app/api/worker/submissions-gmail", {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(45_000),
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(roleRepairBrokerRequest({ after, before, threadId: source.provider_thread_id })),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.ok !== true) throw fail(/^[-_a-z0-9]{1,100}$/u.test(body?.error || "") ? body.error : "repair_broker_failed");
      if (body.result?.id !== source.provider_thread_id) throw fail("repair_thread_identity_mismatch");
      const event = roleInterestReplyEvents(body.result, { after, before, env }).find((value) => value.provider_message_id === source.provider_message_id);
      const blobRead = await blobs.readPrivateObject(source.encrypted_body_object_key);
      const payload = roleRepairStoredPayload(blobRead, { env, eventId: source.event_id });
      const match = event ? await repository.candidateMatches(event) : null;
      const roleIds = event?.offered_roles?.map((role) => role.role_id) || [];
      const roles = roleIds.length ? await sql.begin("read only", (tx) => tx`
        select role_id,active from submissions_v2.role_index where role_id=any(${tx.array(roleIds, 25)})
      `) : [];
      plan.push(roleRepairEvidence({ source, storedPayload: payload, event,
        candidate: { candidate_user_id: match?.candidate?.candidate_user_id, ambiguous: match?.ambiguous }, roles }));
      await new Promise((done) => setTimeout(done, 1000));
    }
    const digest = roleRepairPlanDigest(plan);
    const result = { schema_version: 1, mode: "dry_run", digest, plan_signature: roleRepairPlanSignature(digest, env), inspected: plan.length,
      repairable: plan.filter((row) => row.status === "repairable").length, plan };
    return result;
  } finally { await sql.end({ timeout: 5 }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((value) => !/^--(?:limit=\d{1,2}|apply=[a-f0-9]{64}|plan=.+)$/u.test(value))) throw fail("repair_argument_invalid");
  const applyDigest = args.find((value) => value.startsWith("--apply="))?.slice(8) || null;
  const planPath = args.find((value) => value.startsWith("--plan="))?.slice(7) || null;
  if (applyDigest && !planPath) throw fail("repair_reviewed_plan_required");
  if (!applyDigest && planPath) throw fail("repair_argument_invalid");
  (async () => repairRoleEvidence({ limit: Number(args.find((value) => value.startsWith("--limit="))?.slice(8) || 50), applyDigest,
    reviewedPlan: applyDigest ? await readReviewedRoleRepairPlan(planPath, { applyDigest }) : null }))()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => { process.stderr.write(`${error.code || "repair_failed"}\n`); process.exitCode = 1; });
}
