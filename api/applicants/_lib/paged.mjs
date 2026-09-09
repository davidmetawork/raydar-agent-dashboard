import postgres from 'postgres';
import { projectPinnedApplicantProfile } from './paged-core/paged-profile-contract.mjs';
import { hasUsableApplicantProfileV2 } from './paged-core/applicant-profile-contract.mjs';
import { PAGED_DECISION_AUTHORITY_VERSION } from './paged-core/paged-decision-authority.mjs';
import { readActivePagedViewManifest, readActivePagedViewPage, readPagedViewDetail,
  readActivePagedViewAuthority } from './paged-core/paged-view-read.mjs';

let connection;
export const pagedReadsEnabled = () => process.env.APPLICANT_CORE_PAGED_READS === 'true';
export function applicantReadPool() {
  const url = process.env.APPLICANT_CORE_READ_DATABASE_URL;
  if (!url) throw Object.assign(new Error('applicant_read_store_not_configured'), { code: 'applicant_read_store_not_configured' });
  connection ||= postgres(url, { max: 3, prepare: false, idle_timeout: 20, connect_timeout: 10,
    connection: { application_name: 'monitor-applicant-read', default_transaction_read_only: 'on' } });
  return { async connect() {
    const reserved = await connection.reserve();
    return { async query(statement, parameters = []) { return { rows: await reserved.unsafe(statement, parameters) }; },
      release() { return reserved.release(); } };
  } };
}

const string = value => typeof value === 'string' && value.trim() ? value.trim() : null;
const PROFILE_RECONSTRUCTION_PROBLEMS = Object.freeze({
  APPLICANT_PAGED_PROFILE_REFERENCE_MISSING: Object.freeze({
    code: 'paged_profile_reference_missing',
    reason: 'Stored profile evidence is unavailable for this retained applicant row.',
    nextAction: 'Refresh this applicant’s stored profile from current retained source records.',
  }),
  APPLICANT_PAGED_PROFILE_REFERENCE_SCOPE_CHANGED: Object.freeze({
    code: 'paged_profile_reference_scope_changed',
    reason: 'Stored profile evidence no longer matches this retained applicant row.',
    nextAction: 'Refresh this applicant’s stored profile from current identity and source records.',
  }),
  APPLICANT_PAGED_PROFILE_PAYLOAD_UNAVAILABLE: Object.freeze({
    code: 'paged_profile_payload_unavailable',
    reason: 'Stored profile evidence cannot be read for this retained applicant row.',
    nextAction: 'Recover or replace the unavailable stored profile evidence.',
  }),
  APPLICANT_PAGED_PROFILE_APPLICATION_SOURCE_DIGEST_MISMATCH: Object.freeze({
    code: 'paged_profile_application_source_digest_mismatch',
    reason: 'The retained application source does not match its recorded digest.',
    nextAction: 'Investigate and recover the exact application source observation.',
  }),
  APPLICANT_PAGED_PROFILE_PINS_INVALID: Object.freeze({
    code: 'paged_profile_pins_invalid',
    reason: 'This retained row uses an unsupported profile reference.',
    nextAction: 'Refresh this applicant’s stored profile from current source records using the supported format.',
  }),
  APPLICANT_PAGED_PROFILE_DIGEST_MISMATCH: Object.freeze({
    code: 'paged_profile_digest_mismatch',
    reason: 'The retained profile facts do not match their recorded digest.',
    nextAction: 'Refresh this applicant’s stored profile from the exact current retained profile records.',
  }),
});
const retainedAge = (createdAt, now) => {
  const at = Date.parse(createdAt || '');
  const measured = now instanceof Date ? now.getTime() : Number(now);
  return Number.isFinite(at) && Number.isFinite(measured)
    ? Math.max(0, Math.floor((measured - at) / 1_000)) : null;
};
function containedPagedDocument(document, failure, now) {
  const raw = document.row;
  const index = raw.index_payload || {};
  const profileKey = `application:${raw.application_id}:${raw.id}`;
  const retainedAt = string(raw.created_at);
  const detail = PROFILE_RECONSTRUCTION_PROBLEMS[failure.code];
  const problem = Object.freeze({ ...detail, domain: 'profile', state: 'open', owner: 'Applicant Core',
    firstObservedAt: retainedAt, ageSeconds: retainedAge(retainedAt, now) });
  const viewStates = [...new Set([
    ...(Array.isArray(raw.view_states) ? raw.view_states : []).filter(state => state !== 'ready'),
    'preparing', 'problems',
  ])].sort();
  const row = {
    key: raw.monitor_key, applicationId: raw.application_id, rowVersionId: raw.id, profileKey,
    cuId: null, name: 'Applicant', roleId: raw.role_id, roleTitle: raw.role_title,
    sourceJobId: raw.source_job_id, company: raw.company,
    appliedAt: index.appliedAt || raw.application_date,
    appliedAtIso: /T\d{2}:\d{2}/.test(index.appliedAt || '') ? index.appliedAt : null,
    addedAt: raw.source_arrival_at, receivedAt: raw.source_arrival_at,
    sourceObservationId: raw.source_observation_id, sourceStatus: raw.source_status,
    state: 'profile_preparing', status: raw.invitation_state === 'externally_committed'
      ? 'emailed' : raw.source_status,
    inputRevision: null, readinessRevision: null,
    decisionRevision: Number(raw.decision_revision || 0),
    interviewAllowed: false, interviewWhenReadyAllowed: false, linkedin: null,
    tier: null, reason: problem.reason, owner: problem.owner,
    nextAction: problem.nextAction, problems: [problem, ...(raw.problems || [])],
    viewAuthority: null, viewStates, decisionAt: raw.decision_at,
    decisionAction: raw.decision_action, savedDecisionRequestId: index.decisionRequestId || null,
    rowDigest: raw.row_digest, retainedRowCreatedAt: retainedAt,
    profileUpdatePending: true, factsCurrent: false, rowCurrent: false,
  };
  const profile = { name: 'Applicant', title: null, location: null, imageSrc: null,
    linkedin: null, profileV2: null, application: { applicationId: row.applicationId },
    source: 'profile_reconstruction_pending' };
  return { row, profileV2: null, profile, photo: null,
    card: { name: 'Applicant', title: null, location: null, imageSrc: null, profileKey },
    decision: raw.decision_action ? { action: raw.decision_action, at: raw.decision_at,
      requestId: index.decisionRequestId || null, status: 'recorded',
      deliveryState: raw.invitation_state || null } : null };
}
export function projectPagedDocument(document, { now = Date.now() } = {}) {
  if (!document?.row) throw new Error('applicant_row_unavailable');
  const raw = document.row;
  const index = raw.index_payload || {};
  const source = document.source || {};
  const captured = document.captured || {};
  const current = document.current === true;
  let profileV2 = null;
  try {
    profileV2 = index.profilePins ? projectPinnedApplicantProfile({ pins: index.profilePins,
      source: document.source, paraform: document.profile, resume: document.resume,
      current, problems: raw.problems || [] }) : null;
  } catch (error) {
    if (PROFILE_RECONSTRUCTION_PROBLEMS[error?.code]) {
      return containedPagedDocument(document, error, now);
    }
    throw error;
  }
  const profileKey = `application:${raw.application_id}:${raw.id}`;
  const facts = profileV2?.profile?.facts;
  const reviewProfileUsable = hasUsableApplicantProfileV2(profileV2);
  const viewStates = [...new Set([
    ...(Array.isArray(raw.view_states) ? raw.view_states : []).filter((state) =>
      reviewProfileUsable || state !== 'ready'),
    ...(!reviewProfileUsable ? ['preparing'] : []),
  ])].sort();
  const name = string(facts?.name?.value) || string(source.name) || string(source.contact?.name)
    || string(source.context_snapshot?.candidate_detail?.name) || string(source.applicant?.name)
    || string(source.fullName)
    || string([source.firstName, source.lastName].filter(Boolean).join(' ')) || string(captured.candidateName);
  const actionability = profileV2?.actionability;
  const viewAuthority = raw.source_observation_id && raw.fact_set_digest ? {
    version: PAGED_DECISION_AUTHORITY_VERSION, applicationId: raw.application_id,
    rowVersionId: raw.id, rowRevision: Number(raw.row_revision), rowDigest: raw.row_digest,
    sourceObservationId: raw.source_observation_id, profileBindingId: raw.profile_binding_id,
    profileVersionId: raw.profile_version_id, resumeFactVersionId: raw.resume_fact_version_id,
    factSetDigest: raw.fact_set_digest,
  } : null;
  const row = {
    key: raw.monitor_key, applicationId: raw.application_id, profileKey,
    cuId: current ? document.connectionCandidateUserId || null : null,
    name, roleId: raw.role_id, roleTitle: raw.role_title, sourceJobId: raw.source_job_id, company: raw.company,
    appliedAt: index.appliedAt || raw.application_date,
    appliedAtIso: /T\d{2}:\d{2}/.test(index.appliedAt || '') ? index.appliedAt : null,
    addedAt: raw.source_arrival_at, receivedAt: raw.source_arrival_at,
    sourceObservationId: raw.source_observation_id, sourceStatus: raw.source_status,
    state: raw.partition === 'preparing' || !reviewProfileUsable ? 'profile_preparing' : raw.source_status,
    status: raw.invitation_state === 'externally_committed' ? 'emailed' : raw.source_status,
    inputRevision: raw.input_revision, readinessRevision: raw.readiness_revision,
    decisionRevision: Number(raw.decision_revision || 0),
    interviewAllowed: current && index.interviewAllowed === true && actionability?.eligibility === 'ready',
    interviewWhenReadyAllowed: current && index.interviewWhenReadyAllowed === true
      && actionability?.canCreateApproval === true,
    linkedin: facts?.linkedin?.value || null, tier: index.tier || null,
    reason: raw.problems?.[0]?.code || (!reviewProfileUsable
      ? 'profile_review_content_unavailable' : raw.partition === 'preparing' ? 'profile_preparing' : null),
    problems: raw.problems || [], viewAuthority, viewStates,
    decisionAt: raw.decision_at, decisionAction: raw.decision_action,
    savedDecisionRequestId: index.decisionRequestId || null,
    rowDigest: raw.row_digest,
    profileUpdatePending: !current,
    factsCurrent: profileV2?.factsCurrent === true,
    rowCurrent: current,
  };
  const profile = { name, title: facts?.title?.value || null, location: facts?.location?.value || null,
    imageSrc: profileV2?.profile?.photo || null, linkedin: row.linkedin, profileV2,
    application: profileV2?.application || { applicationId: row.applicationId },
    source: raw.source_observation_id ? 'stored_application' : 'source_details_pending_review' };
  return { row, profileV2, profile, photo: profile.imageSrc,
    card: { name, title: profile.title, location: profile.location, imageSrc: profile.imageSrc, profileKey },
    decision: raw.decision_action ? { action: raw.decision_action, at: raw.decision_at,
      requestId: index.decisionRequestId || profileV2?.invitation?.requestId || null, status: 'recorded',
      deliveryState: raw.invitation_state || null } : null };
}

export async function readApplicantPage(request = {}, { pool = applicantReadPool() } = {}) {
  const manifest = await readActivePagedViewManifest({ pool,
    ...(request.generationId ? { generationId: request.generationId, generationDigest: request.generationDigest } : {}) });
  const page = await readActivePagedViewPage({ ...request, pool,
    generationId: manifest.generationId, generationDigest: manifest.generationDigest });
  return { manifest, page, view: request.view || 'ready',
    applicants: page.documents.map(document => projectPagedDocument(document)) };
}
export async function readApplicantManifest(request = {}, { pool = applicantReadPool() } = {}) {
  return readActivePagedViewManifest({ pool, ...request });
}
export async function readApplicantAckBatch(request, { pool = applicantReadPool() } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout='12s'");
    const result = await client.query('SELECT applicant_core.read_applicant_ack_batch($1::jsonb) AS value', [JSON.stringify(request)]);
    await client.query('COMMIT');
    return result.rows[0]?.value;
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}
export async function readApplicantDetail(request, { pool = applicantReadPool() } = {}) {
  const result = await readPagedViewDetail({ pool, ...request });
  return { generation: result.generation, ...projectPagedDocument(result.document) };
}
export async function readApplicantAuthority(request, { pool = applicantReadPool() } = {}) {
  const result = await readActivePagedViewAuthority({ pool, ...request });
  return { generation: result.generation, ...projectPagedDocument(result.document) };
}

export function pagedFeedResponse({ manifest, page, applicants, view }, { decisions = {}, acks = {} } = {}) {
  const queue = [], stream = [], preparing = [], applicantRowsV2 = {}, cards = {}, photos = {}, problems = [];
  for (const applicant of applicants) {
    const { row, profileV2, profile, card, photo, decision } = applicant;
    if (row.viewStates?.includes('preparing')) preparing.push(row);
    else if (view === 'stream') stream.push(row);
    else queue.push(row);
    if (profileV2) applicantRowsV2[row.key] = profileV2;
    cards[row.profileKey] = card;
    if (photo) photos[row.profileKey] = photo;
    if (decision && !decisions[row.key]) decisions[row.key] = decision;
    for (const problem of row.problems) problems.push({ ...problem, key: row.key,
      applicationId: row.applicationId, name: row.name, roleTitle: row.roleTitle, company: row.company,
      observedAt: problem.firstObservedAt || null });
  }
  return { ok: true, paged: true, manifest, nextCursor: page.nextCursor,
    generation: { generationId: manifest.generationId, digest: manifest.generationDigest, publishedAt: manifest.publishedAt },
    snapshot: { queue, stream, generatedAt: manifest.publishedAt }, profilePreparingRows: preparing,
    profilePreparing: manifest.counts.preparing || 0, applicantRowsV2, cards, photos, problems,
    decisions, acks, counts: { current: manifest.counts, rowCount: manifest.rowCount } };
}
