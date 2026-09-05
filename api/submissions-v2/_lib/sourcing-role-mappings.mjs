import { createHash } from "node:crypto";

import { database } from "./db.mjs";

const PREFIX = "sourcing:v1:role:";
const EXACT_STATE_KEY = /^sourcing:v1:role:([^:]{1,200})$/u;
const ID = /^[A-Za-z0-9_-]{1,500}$/u;
const MAX_SCAN_PAGES = 8;
// MATCH filters the response, but SCAN still walks the shared KV keyspace. A
// large server-side work hint makes completing that walk inside eight bounded
// pages realistic without returning non-matching keys to this process.
const SCAN_COUNT = 10_000;
const MAX_STATE_KEYS = 500;
const LOOKUP_BUDGET_MS = 4_500;
const UNAVAILABLE_DIGEST = createHash("sha256")
  .update("sourcing-sequence-role-mappings:v1:unavailable")
  .digest("hex");

const hash = (value) => createHash("sha256").update(String(value)).digest("hex");
const text = (value, limit = 500) => String(value ?? "").trim().slice(0, limit);
const canonical = (rows) => JSON.stringify([...rows].sort((left, right) => (
  left.sequence_id.localeCompare(right.sequence_id)
    || left.role_id.localeCompare(right.role_id)
    || left.evidence_locator.localeCompare(right.evidence_locator)
)));

function unavailable(reason = "sourcing_role_mapping_unavailable") {
  return { status: "unavailable", diagnostic: reason, mappings: [], digest: UNAVAILABLE_DIGEST };
}

async function beforeDeadline(promise, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("sourcing_role_mapping_budget_exhausted");
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("sourcing_role_mapping_budget_exhausted")), remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function normalizeSourcingRoleMappingRecord(record, activeRoleIds = new Set()) {
  const key = text(record?.key, 500);
  const keyMatch = key.match(EXACT_STATE_KEY);
  const sequenceId = text(record?.sequenceId, 500);
  if (!keyMatch || !sequenceId || !ID.test(sequenceId)) return null;
  const keyRoleId = keyMatch[1];
  const stateRoleId = text(record?.stateRoleId, 200);
  const mappingRoleId = text(record?.mappingRoleId, 200);
  const projectId = text(record?.reviewProjectId, 500);
  const preparedAt = text(record?.preparedAt, 100);
  const preparedMs = Date.parse(preparedAt);
  const sequenceCreated = record?.sequenceCreated === true;
  const valid = ID.test(keyRoleId)
    && stateRoleId === keyRoleId
    && mappingRoleId === keyRoleId
    && ID.test(projectId)
    && Number.isFinite(preparedMs)
    && sequenceCreated
    && activeRoleIds.has(keyRoleId);
  const material = {
    key,
    sequence_id: sequenceId,
    role_id: mappingRoleId || keyRoleId,
    project_id: projectId,
    attested_at: Number.isFinite(preparedMs) ? new Date(preparedMs).toISOString() : null,
    sequence_created: sequenceCreated,
    active: activeRoleIds.has(keyRoleId),
    valid,
  };
  return {
    ...material,
    evidence_locator: `${key}#${hash(JSON.stringify(material))}`,
  };
}

async function defaultActiveRoleIds() {
  const sql = database();
  return sql.begin("read only", async (tx) => {
    await tx.unsafe("set local statement_timeout = '1500ms'");
    const rows = await tx`select role_id from submissions_v2.role_index where active order by role_id`;
    return new Set(rows.map((row) => text(row.role_id, 200)).filter(Boolean));
  });
}

async function restCommand(args, { env, fetchImpl, deadline }) {
  const url = String(env.KV_REST_API_URL || "").replace(/\/+$/u, "");
  const token = String(env.KV_REST_API_TOKEN || "");
  const remaining = deadline - Date.now();
  if (!url || !token || remaining <= 0) throw new Error("sourcing_role_mapping_unavailable");
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(Math.max(1, remaining)),
  });
  const body = await response.json();
  if (!response.ok || body?.error) throw new Error("sourcing_role_mapping_unavailable");
  return body?.result;
}

async function scanExactKeys(command, deadline) {
  const found = new Set();
  const seenCursors = new Set();
  let cursor = "0";
  for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
    if (Date.now() >= deadline) throw new Error("sourcing_role_mapping_budget_exhausted");
    const result = await command(["SCAN", cursor, "MATCH", `${PREFIX}*`, "COUNT", SCAN_COUNT]);
    if (!Array.isArray(result) || result.length !== 2 || !Array.isArray(result[1])) {
      throw new Error("sourcing_role_mapping_scan_invalid");
    }
    cursor = String(result[0]);
    for (const key of result[1]) {
      const value = text(key, 500);
      if (EXACT_STATE_KEY.test(value)) found.add(value);
      if (found.size > MAX_STATE_KEYS) throw new Error("sourcing_role_mapping_inventory_too_large");
    }
    if (cursor === "0") return [...found].sort();
    if (seenCursors.has(cursor)) throw new Error("sourcing_role_mapping_scan_repeated");
    seenCursors.add(cursor);
  }
  throw new Error("sourcing_role_mapping_scan_incomplete");
}

const COMPACT_MAPPING_SCRIPT = `
local out = {}
for _, key in ipairs(KEYS) do
  local raw = redis.call('GET', key)
  if raw then
    local ok, state = pcall(cjson.decode, raw)
    if ok and type(state) == 'table' and type(state.mapping) == 'table' then
      local mapping = state.mapping
      table.insert(out, cjson.encode({
        key = key,
        stateRoleId = state.roleId,
        mappingRoleId = mapping.roleId,
        sequenceId = mapping.sequenceId,
        reviewProjectId = mapping.reviewProjectId,
        preparedAt = mapping.preparedAt,
        sequenceCreated = mapping.sequenceCreated == true
      }))
    end
  end
end
table.sort(out)
return out
`;

async function compactRecords(keys, command) {
  if (!keys.length) return [];
  const values = await command(["EVAL", COMPACT_MAPPING_SCRIPT, keys.length, ...keys]);
  if (!Array.isArray(values)) throw new Error("sourcing_role_mapping_state_invalid");
  return values.map((value) => {
    try { return JSON.parse(value); } catch { throw new Error("sourcing_role_mapping_state_invalid"); }
  });
}

/** Optional, bounded read of existing Sourcing role state; never returns a partial mapping set. */
export async function readSourcingSequenceRoleMappings({
  env = process.env,
  fetchImpl = fetch,
  activeRoleIds = defaultActiveRoleIds,
  budgetMs = LOOKUP_BUDGET_MS,
  command: commandImpl = null,
} = {}) {
  if (!commandImpl && (!String(env.KV_REST_API_URL || "").trim()
    || !String(env.KV_REST_API_TOKEN || "").trim())) return unavailable();
  const deadline = Date.now() + Math.max(100, Math.min(LOOKUP_BUDGET_MS, Number(budgetMs) || LOOKUP_BUDGET_MS));
  const command = commandImpl || ((args) => restCommand(args, { env, fetchImpl, deadline }));
  try {
    const [active, firstKeys] = await Promise.all([
      beforeDeadline(Promise.resolve().then(() => activeRoleIds()), deadline),
      scanExactKeys(command, deadline),
    ]);
    const firstRecords = await compactRecords(firstKeys, command);
    const secondKeys = await scanExactKeys(command, deadline);
    if (JSON.stringify(firstKeys) !== JSON.stringify(secondKeys)) throw new Error("sourcing_role_mapping_changed");
    const secondRecords = await compactRecords(secondKeys, command);
    if (JSON.stringify(firstRecords) !== JSON.stringify(secondRecords)) throw new Error("sourcing_role_mapping_changed");
    if (!(active instanceof Set) || Date.now() >= deadline) throw new Error("sourcing_role_mapping_unavailable");
    const mappings = secondRecords
      .map((record) => normalizeSourcingRoleMappingRecord(record, active))
      .filter(Boolean);
    return {
      status: "ready",
      diagnostic: null,
      mappings,
      digest: hash(`sourcing-sequence-role-mappings:v1:${canonical(mappings)}`),
    };
  } catch {
    return unavailable();
  }
}

export const sourcingRoleMappingInternals = Object.freeze({
  EXACT_STATE_KEY,
  LOOKUP_BUDGET_MS,
  MAX_SCAN_PAGES,
  MAX_STATE_KEYS,
  SCAN_COUNT,
  UNAVAILABLE_DIGEST,
});
