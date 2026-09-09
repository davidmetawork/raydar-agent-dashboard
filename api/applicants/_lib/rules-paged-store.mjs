const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

async function read(operation, parameters) {
  const { applicantReadPool } = await import("./paged.mjs");
  const client = await applicantReadPool().connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout='12s'");
    const result = await client.query(operation, parameters);
    await client.query("COMMIT");
    return result.rows;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function operationId(value) {
  const id = String(value || "").trim().toLowerCase();
  if (!UUID.test(id)) throw new Error("paged_rule_operation_id_invalid");
  return id;
}

export async function readPagedRuleOperationStatus(id) {
  const rows = await read(
    "SELECT applicant_core.read_graph_rule_operation_status($1::uuid) AS value",
    [operationId(id)],
  );
  return rows[0]?.value || null;
}

export async function readPagedApplicantManifest({ generationId, generationDigest } = {}) {
  const request = generationId ? { generationId, generationDigest } : {};
  const rows = await read(
    "SELECT applicant_core.read_applicant_view_manifest($1::jsonb) AS value",
    [JSON.stringify(request)],
  );
  return rows[0]?.value || null;
}

export async function readPagedRulePreviewResults(id, { after = 0, limit = 8 } = {}) {
  const position = Number(after);
  const size = Number(limit);
  if (!Number.isSafeInteger(position) || position < 0
    || !Number.isSafeInteger(size) || size < 1 || size > 200) {
    throw new Error("paged_rule_preview_results_invalid");
  }
  return read(`SELECT item_position AS position,application_id AS "applicationId",monitor_key AS "monitorKey",
      outcome,rule_id AS "ruleId",rule_version AS "ruleVersion",evidence,skip_reason AS "skipReason"
    FROM applicant_core.read_graph_rule_preview_results($1::uuid,$2::bigint,$3::integer)`,
  [operationId(id), position, size]);
}
