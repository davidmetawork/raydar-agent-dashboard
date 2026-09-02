import { createHash, createHmac } from "node:crypto";
import { normalizeCandidateRow, trpcGet } from "../../paraai/_lib/core.mjs";

const clean = (value, limit = 1_000) => String(value ?? "").trim().slice(0, limit);
const sourceShapeError = (code, message) => Object.assign(new Error(message), { code, retryable: true });
export const normalizeSearch = (value) => clean(value, 1_000)
  .normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function firstEmail(row) {
  const person = row?.candidate && typeof row.candidate === "object" ? row.candidate : {};
  const values = [row?.email, person.email, ...(Array.isArray(row?.emails) ? row.emails : []), ...(Array.isArray(person.emails) ? person.emails : [])];
  for (const value of values) {
    const email = clean(typeof value === "object" ? value?.email ?? value?.value : value, 320).toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return email;
  }
  return null;
}

function emailHmac(email, env = process.env) {
  const version = clean(env.SUBMISSIONS_V2_EMAIL_HMAC_VERSION || "", 100);
  const secret = clean(env.SUBMISSIONS_V2_EMAIL_HMAC_KEY || "", 2_000);
  if (!email || !version || secret.length < 32) return null;
  return { key_version: version, digest: createHmac("sha256", secret).update(email).digest("base64url") };
}

export function candidateIndexRow(raw, { env = process.env, confirmedAt = new Date().toISOString(), hasRecordedCall = null } = {}) {
  const row = normalizeCandidateRow(raw || {});
  const id = clean(row?.id || row?.candidate_user_id || row?.candidateUserId, 200);
  const name = clean(row?.name, 500);
  if (!id || !name) return null;
  const linkedin = clean(row?.linkedin_url || row?.linkedin || row?.linkedin_user, 1_000);
  const email = firstEmail(row);
  const hmac = emailHmac(email, env);
  return {
    candidate_user_id: id,
    candidate_id: clean(row?.candidate_id, 200) || null,
    display_name: name,
    search_key: normalizeSearch(name),
    paraform_url: `https://www.paraform.com/candidates?candidate=${encodeURIComponent(id)}`,
    linkedin_url: linkedin ? (linkedin.startsWith("http") ? linkedin : `https://www.linkedin.com/in/${encodeURIComponent(linkedin.replace(/^\/?in\//, ""))}`) : null,
    raydar_url: `/applicants?candidate=${encodeURIComponent(id)}`,
    owner_email: clean(row?.recruiter_email || row?.owner_email, 320).toLowerCase() || null,
    has_recorded_call: hasRecordedCall == null ? Boolean(row?.first_parascribe_call || row?.has_recorded_call) : Boolean(hasRecordedCall),
    email_hmac_version: hmac?.key_version || null,
    email_hmac: hmac?.digest || null,
    confirmed_at: confirmedAt,
    source_digest: createHash("sha256").update(JSON.stringify({ id, name, linkedin, owner: row?.recruiter_email || row?.owner_email || null })).digest("hex"),
  };
}

export function roleIndexRow(raw, { confirmedAt = new Date().toISOString() } = {}) {
  const id = clean(raw?.id || raw?.role_id || raw?.roleId, 200);
  const company = clean(raw?.company?.name || raw?.company_name || raw?.companyName || raw?.company, 500);
  const title = clean(raw?.title || raw?.name || raw?.role_name || raw?.roleName, 500);
  if (!id || !title) return null;
  const explicitlyInactive = raw?.active === false || raw?.is_active === false || ["inactive", "closed", "archived"].includes(clean(raw?.status, 100).toLowerCase());
  return {
    role_id: id,
    company_name: company || "Company unavailable",
    role_title: title,
    search_key: normalizeSearch(`${company} ${title}`),
    active: !explicitlyInactive,
    paraform_url: `https://www.paraform.com/browse?role=${encodeURIComponent(id)}`,
    owner_email: clean(raw?.recruiter?.email || raw?.recruiter_email || raw?.owner_email, 320).toLowerCase() || null,
    confirmed_at: confirmedAt,
    source_digest: createHash("sha256").update(JSON.stringify({ id, company, title, active: !explicitlyInactive })).digest("hex"),
  };
}

async function strictCandidatePage(cursor, limit, { trpcGetImpl = trpcGet, env = process.env } = {}) {
  const filters = { sort: { field: "updated_at", direction: "desc" } };
  const configured = clean(env.CRM_RECRUITER_IDS, 4_000).split(",").map((value) => value.trim()).filter(Boolean);
  if (configured.length) filters.recruiters = configured;
  const raw = await trpcGetImpl("candidateUser.getCRMExternalCandidates", { filters, limit, cursor });
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.items)
    || !Object.prototype.hasOwnProperty.call(raw, "next_cursor")) {
    throw sourceShapeError("candidate_index_shape_invalid", "Paraform candidate index returned an unrecognized success payload.");
  }
  if (raw.next_cursor !== null && !["string", "number"].includes(typeof raw.next_cursor)) {
    throw sourceShapeError("candidate_index_cursor_invalid", "Paraform candidate index returned an invalid continuation cursor.");
  }
  return { items: raw.items, nextCursor: raw.next_cursor };
}

export async function readCandidateIndexPage(cursor = 0, limit = 100, { crmPageImpl = null, trpcGetImpl = trpcGet, env = process.env } = {}) {
  const pageLimit = Math.min(120, Math.max(1, Number(limit) || 100));
  const result = crmPageImpl
    ? await crmPageImpl(cursor, pageLimit)
    : await strictCandidatePage(cursor, pageLimit, { trpcGetImpl, env });
  if (!result || typeof result !== "object" || !Array.isArray(result.items)
    || !Object.prototype.hasOwnProperty.call(result, "nextCursor")) {
    throw sourceShapeError("candidate_index_shape_invalid", "Paraform candidate index returned an unrecognized normalized payload.");
  }
  const confirmedAt = new Date().toISOString();
  const rows = result.items.map((row) => candidateIndexRow(row, { env, confirmedAt }));
  if (rows.some((row) => row === null)) {
    throw sourceShapeError("candidate_index_row_invalid", "Paraform candidate index returned a row without its required identity.");
  }
  return { rows, next_cursor: result.nextCursor, confirmed_at: confirmedAt };
}

export async function readActiveRoleIndex({ trpcGetImpl = trpcGet } = {}) {
  const values = await trpcGetImpl("activeRoles.getActiveRoles", {});
  const rows = Array.isArray(values) ? values
    : values && typeof values === "object" && Array.isArray(values.items) ? values.items
      : values && typeof values === "object" && Array.isArray(values.roles) ? values.roles
        : null;
  if (!rows) throw sourceShapeError("role_index_shape_invalid", "Paraform active roles returned an unrecognized success payload.");
  const confirmedAt = new Date().toISOString();
  const normalized = rows.map((row) => roleIndexRow(row, { confirmedAt }));
  if (normalized.some((row) => row === null)) {
    throw sourceShapeError("role_index_row_invalid", "Paraform active roles returned a row without its required identity.");
  }
  return { rows: normalized.filter((row) => row.active), confirmed_at: confirmedAt };
}

export async function readCuratedPopulation({ listImpl = null, trpcGetImpl = trpcGet } = {}) {
  if (listImpl) {
    const normalized = await listImpl();
    if (!Array.isArray(normalized) || normalized.some((row) => !row || typeof row !== "object" || !clean(row.candidateUserId, 200))) {
      throw sourceShapeError("curated_population_shape_invalid", "Paraform curated candidates returned an unrecognized normalized payload.");
    }
    return normalized;
  }
  const raw = await trpcGetImpl("curatedRoleList.getCandidates", {});
  if (!Array.isArray(raw) || raw.some((row) => !row || typeof row !== "object" || Array.isArray(row)
    || !clean(row.id, 200) || !Array.isArray(row.recruiter_role_list_ids))) {
    throw sourceShapeError("curated_population_shape_invalid", "Paraform curated candidates returned an unrecognized success payload.");
  }
  return raw.filter((row) => row.recruiter_role_list_ids.length > 0).map((row) => ({
    candidateUserId: clean(row.id, 200),
    candidateId: clean(row.candidate_id, 200) || null,
    name: clean(row.name, 500) || null,
    email: clean(row.email, 320) || null,
    listIds: row.recruiter_role_list_ids.map((value) => clean(value, 200)).filter(Boolean),
  }));
}

export async function readCuratedCandidate(candidateUserId, { statusImpl = null, trpcGetImpl = trpcGet } = {}) {
  let statuses;
  if (statusImpl) {
    statuses = await statusImpl(candidateUserId);
    if (!statuses || typeof statuses !== "object" || Array.isArray(statuses)) {
      throw sourceShapeError("curated_status_shape_invalid", "Paraform curated statuses returned an unrecognized normalized payload.");
    }
  } else {
    const raw = await trpcGetImpl("applicantInterest.getCuratedListRoleStatuses", { candidate_user_id: candidateUserId });
    if (!Array.isArray(raw) || raw.some((row) => !row || typeof row !== "object" || Array.isArray(row)
      || !clean(row.role_id, 200) || !clean(row.status, 100))) {
      throw sourceShapeError("curated_status_shape_invalid", "Paraform curated statuses returned an unrecognized success payload.");
    }
    statuses = Object.fromEntries(raw.map((row) => [clean(row.role_id, 200), clean(row.status, 100)]));
  }
  const rows = Object.entries(statuses).map(([role_id, status]) => ({ role_id: clean(role_id, 200), status: clean(status, 100).toUpperCase() }));
  if (rows.some((row) => !row.role_id || !row.status)) throw sourceShapeError("curated_status_row_invalid", "Paraform curated statuses returned a row without its required identity.");
  return rows;
}

export async function readSelectableMeetings(candidateUserId, { trpcGetImpl = trpcGet } = {}) {
  const result = await trpcGetImpl("candidateUserMeeting.getSelectableMeetingsForCandidateUserId", { candidate_user_id: candidateUserId });
  return (Array.isArray(result) ? result : result?.items || []).filter((row) => row?.id || row?.call_id || row?.meeting_id);
}
