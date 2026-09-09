export const PAGED_DECISION_AUTHORITY_VERSION = 'applicant-paged-decision-authority-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA = /^[0-9a-f]{64}$/u;
const fail = field => Object.assign(new Error('APPLICANT_CORE_PAGED_DECISION_AUTHORITY_INVALID'),
  { code: 'APPLICANT_CORE_PAGED_DECISION_AUTHORITY_INVALID', field });

/** Optional only for the unchanged legacy publication transport. */
export function normalizePagedDecisionAuthority(value) {
  if (value == null) return null;
  if (value.version !== PAGED_DECISION_AUTHORITY_VERSION) throw fail('version');
  const result = { version: PAGED_DECISION_AUTHORITY_VERSION };
  for (const field of ['applicationId', 'rowVersionId', 'sourceObservationId',
    'profileBindingId', 'profileVersionId', 'resumeFactVersionId']) {
    const optional = ['profileBindingId', 'profileVersionId', 'resumeFactVersionId'].includes(field);
    const input = value[field];
    if (optional && input == null) { result[field] = null; continue; }
    if (typeof input !== 'string' || !UUID.test(input.toLowerCase())) throw fail(field);
    result[field] = input.toLowerCase();
  }
  if ((result.profileBindingId == null) !== (result.profileVersionId == null)) throw fail('profileBindingId');
  const rowRevision = Number(value.rowRevision);
  if (!Number.isSafeInteger(rowRevision) || rowRevision < 1) throw fail('rowRevision');
  result.rowRevision = rowRevision;
  for (const field of ['rowDigest', 'factSetDigest']) {
    if (typeof value[field] !== 'string' || !SHA.test(value[field])) throw fail(field);
    result[field] = value[field];
  }
  return Object.freeze(result);
}

export async function assertPagedDecisionAuthority(client, {
  applicationId, generationId, generationDigest, viewAuthority,
  monitorKey = null, inputRevision, readinessRevision, decisionRevision,
}) {
  const authority = normalizePagedDecisionAuthority(viewAuthority);
  if (!authority || authority.applicationId !== applicationId) throw fail('applicationId');
  await client.query(`SELECT applicant_core.assert_paged_decision_authority(
    $1::uuid,$2::uuid,$3::text,$4::jsonb,$5::text,$6::text,$7::text,$8::bigint)`,
  [applicationId, generationId, generationDigest, JSON.stringify(authority),
    monitorKey, inputRevision, readinessRevision ?? null, decisionRevision]);
  return authority;
}
