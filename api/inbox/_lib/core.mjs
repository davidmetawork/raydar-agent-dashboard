// Cross-sequence reply inbox. Paraform remains the read-only message source;
// Raydar separately owns durable Archive/Complete triage state for the
// authenticated Monitor UI.

import { randomUUID } from "node:crypto";
import {
  BASE,
  authConfig,
  cors,
  hasCookie,
  headers,
  paraformHealth,
  requireAuth,
} from "../../seq/_lib/core.mjs";
import {
  kv,
  pipeline,
  storeConfigured,
} from "../../sourcing/_lib/store.mjs";

export { authConfig, cors, hasCookie, paraformHealth, storeConfigured };

export const INBOX_TRIAGE_KEY = "inbox:v1:triage";
export const INBOX_SEQUENCE_SNAPSHOTS_KEY = "inbox:v3:sequences";
export const INBOX_CATALOG_KEY = "inbox:v3:catalog";
export const INBOX_RECENT_KEY = "inbox:v3:recent";
export const INBOX_REFRESH_META_KEY = "inbox:v3:refresh";
export const INBOX_SYNC_LOCK_KEY = "inbox:v3:sync:lock";
export const INBOX_FANOUT_CONCURRENCY = 3;
export const INBOX_VENDOR_TIMEOUT_MS = 6_000;
export const INBOX_BUILD_BUDGET_MS = 80_000;
export const INBOX_SYNC_BATCH_SIZE = 18;
export const INBOX_SEQUENCE_STALE_MS = 15 * 60 * 1_000;
export const INBOX_TRIAGE_STATUSES = Object.freeze(["archived", "complete"]);
export const INBOX_EXCLUDED_ADDRESSES = Object.freeze(["david@raydar.xyz"]);

const GMAIL_ID_RE = /^[a-zA-Z0-9._:-]{1,512}$/;
const EMAIL_TOKEN_RE = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const DELIVERY_SYSTEM_ADDRESS_RE = /^(?:mailer-daemon|mail-daemon|postmaster|bounce(?:s)?(?:[+._-].*)?)@/i;
const DELIVERY_NOTICE_SUBJECT_RE = /(?:delivery status notification|undeliverable|mail delivery (?:failed|failure|subsystem)|delivery (?:failure|failed|delayed|delay|incomplete)|returned mail|failure notice|message (?:not delivered|delivery failure))/i;
const DELIVERY_NOTICE_TEXT_RE = /(?:your message (?:wasn't|was not|couldn't|could not) (?:be )?delivered|address not found|recipient address rejected|user unknown|mailbox (?:unavailable|not found|full)|temporary delivery failure|permanent delivery failure|delivery to .{0,160} (?:failed|delayed)|(?:we'll|we will) keep trying to deliver)/i;

const stringValue = (value) => (
  typeof value === "string" ? value.trim() : ""
);

const arrayValue = (value) => (Array.isArray(value) ? value : []);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function addressParts(value) {
  if (Array.isArray(value)) return value.flatMap(addressParts);
  if (value && typeof value === "object") {
    return [
      value.email,
      value.address,
      value.value,
    ].flatMap(addressParts);
  }
  return typeof value === "string" ? [value] : [];
}

function addressFields(source) {
  if (!source || typeof source !== "object") return [];
  return [
    source.from,
    source.from_email,
    source.sender,
    source.sender_email,
    source.to,
    source.to_email,
    source.recipient,
    source.recipient_email,
    source.recipients,
    source.cc,
    source.bcc,
    source.reply_to,
    source.reply_to_email,
  ].flatMap(addressParts);
}

function campaignAccountRows(campaign) {
  return [
    ...arrayValue(campaign?.campaign_to_accounts),
    ...arrayValue(campaign?.send_from_accounts),
    ...arrayValue(campaign?.sender_accounts),
    ...arrayValue(campaign?.gmail_accounts),
    ...arrayValue(campaign?.accounts),
  ];
}

function campaignSenderAddresses(campaign) {
  return [
    ...addressFields(campaign),
    campaign?.send_from_email,
    campaign?.sender_email,
    ...campaignAccountRows(campaign).flatMap((row) => [
      ...addressFields(row),
      ...addressFields(row?.account),
      row?.email,
      row?.account?.email,
    ]),
  ];
}

function linkedOutreachId(campaign) {
  return stringValue(
    campaign?.project_id
    || campaign?.linked_project_id
    || campaign?.candidate_project_id
    || campaign?.project?.id
    || campaign?.role_id
    || campaign?.role_specific_id
    || campaign?.role?.id,
  );
}

function emailTokens(values) {
  return arrayValue(values).flatMap((value) => (
    String(value || "").toLowerCase().match(EMAIL_TOKEN_RE) || []
  ));
}

export function shouldExcludeInboxReply(reply, addressValues = []) {
  const subject = stringValue(reply?.subject || reply?.email_subject);
  const snippet = stringValue(reply?.snippet || reply?.email_snippet);
  const addresses = [
    reply?.candidate_email,
    ...arrayValue(addressValues),
  ];
  const tokens = emailTokens([
    ...addresses,
    subject,
    snippet,
  ]);
  if (tokens.some((token) => INBOX_EXCLUDED_ADDRESSES.includes(token))) {
    return true;
  }
  if (emailTokens(addresses).some((token) => (
    DELIVERY_SYSTEM_ADDRESS_RE.test(token)
  ))) {
    return true;
  }
  return DELIVERY_NOTICE_SUBJECT_RE.test(subject)
    || DELIVERY_NOTICE_TEXT_RE.test(`${subject}\n${snippet}`);
}

export function validInboxGmailId(value) {
  return GMAIL_ID_RE.test(stringValue(value));
}

export async function requireInboxAuth(req, res) {
  if (!authConfig().authRequired) {
    res.status(503).json({ ok: false, error: "auth_not_configured" });
    return false;
  }
  return requireAuth(req, res);
}

export async function inboxTrpcGet(
  procedure,
  json,
  tries = 1,
  timeoutMs = INBOX_VENDOR_TIMEOUT_MS,
  fetchImpl = fetch,
  sleepImpl = sleep,
  randomImpl = Math.random,
) {
  const input = {
    json,
    meta: { values: {}, v: 1 },
  };
  const url = `${BASE}/trpc/${procedure}?input=`
    + encodeURIComponent(JSON.stringify(input));
  const attempts = Math.max(1, Number(tries) || 1);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers: headers(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 401) {
        // Paraform also uses 401 as a burst-throttle signal. Treating it as a
        // session verdict is what made healthy Inbox runs silently lose most
        // sequences. The health endpoint owns session-expiry classification;
        // a feed read only retries and, if needed, retains the old shard.
        const error = new Error("PARAFORM_THROTTLED");
        error.code = "PARAFORM_THROTTLED";
        error.retryable = true;
        error.retryAfterMs = 600;
        throw error;
      }
      const body = await response.json();
      if (!response.ok || body?.error) {
        const error = new Error(
          body?.error?.json?.message || `Paraform HTTP ${response.status}`,
        );
        error.code = response.status === 429
          ? "PARAFORM_THROTTLED"
          : response.status >= 500
            ? "PARAFORM_UPSTREAM"
            : "PARAFORM_READ_FAILED";
        error.retryable = response.status === 429 || response.status >= 500;
        if (response.status === 429) {
          const retryAfter = Number(response.headers?.get?.("retry-after"));
          error.retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(5_000, retryAfter * 1_000)
            : 600;
        }
        throw error;
      }
      return body?.result?.data?.json;
    } catch (error) {
      if (error?.code === "AUTH_EXPIRED") throw error;
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        error.code = "PARAFORM_TIMEOUT";
        error.retryable = true;
      }
      if (
        !error?.code
        && (error instanceof TypeError || error instanceof SyntaxError)
      ) {
        error.code = "PARAFORM_NETWORK";
        error.retryable = true;
      }
      if (attempt >= attempts || error?.retryable !== true) throw error;
      const retryDelay = Number(error?.retryAfterMs)
        || (error?.code === "PARAFORM_THROTTLED" ? 600 : 200) * attempt;
      await sleepImpl(retryDelay + Math.floor(randomImpl() * 250));
    }
  }
  return undefined;
}

export function normalizeReplyCategory(value) {
  const category = stringValue(value).toUpperCase();
  return ["INTERESTED", "NOT_INTERESTED", "UNCLEAR", "NA"].includes(category)
    ? category
    : "NA";
}

export function campaignInboxInput(campaign) {
  const input = { campaign_id: campaign.id };
  const kind = stringValue(campaign.kind || campaign.recipient_kind).toUpperCase();
  if (kind === "COMPANY") input.audience = "company";
  return input;
}

export function isInboxRoleOutreachCampaign(campaign) {
  if (!stringValue(campaign?.id) || !linkedOutreachId(campaign)) return false;
  const senderTokens = emailTokens(campaignSenderAddresses(campaign));
  return !senderTokens.some((token) => INBOX_EXCLUDED_ADDRESSES.includes(token));
}

export function campaignsToScan(campaigns) {
  // This is a role-outreach inbox, not an agency-wide Paraform mailbox. Only
  // sequences positively linked to a role or sourcing Project are admitted.
  // Generic/admin follow-ups have neither link and therefore fail closed.
  // Campaign-level sender metadata is checked too, so attaching the primary
  // Raydar inbox cannot opt a linked sequence back into Monitor ingestion.
  const valid = arrayValue(campaigns).filter(isInboxRoleOutreachCampaign);
  const hasReplyCounts = valid.length > 0 && valid.every((campaign) => (
    Object.prototype.hasOwnProperty.call(campaign, "email_replies")
    && Number.isFinite(Number(campaign.email_replies))
  ));
  if (!hasReplyCounts) return valid;
  // Disabled sequences still carry historical replies and must remain visible.
  return valid.filter((campaign) => Number(campaign.email_replies) > 0);
}

function candidateEmail(lead) {
  const direct = stringValue(lead?.candidate_email);
  if (direct) return direct;
  for (const entry of arrayValue(lead?.candidate_user?.emails)) {
    const value = stringValue(
      typeof entry === "string" ? entry : entry?.email || entry?.value,
    );
    if (value) return value;
  }
  return "";
}

function candidateOneLiner(candidate) {
  const experiences = arrayValue(candidate?.experiences);
  const current = experiences.find((experience) => (
    experience?.is_current || experience?.current
  )) || experiences[0];
  if (!current) return "";
  const title = stringValue(current.title || current.position);
  const company = stringValue(
    current.company_name || current.company?.name || current.company,
  );
  return [title, company].filter(Boolean).join(" at ");
}

function attachmentCount(email, recent) {
  if (Array.isArray(email?.attachments)) return email.attachments.length;
  const count = Number(recent?.attachment_count);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function rowKey(row) {
  return row.gmail_id || [
    row.sequence_id,
    row.ccu_id,
    row.date,
    row.subject,
  ].join(":");
}

function rowDate(row) {
  const parsed = Date.parse(row?.date || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

export function flattenCampaignInbox(campaign, inboxData, recentByGmail = new Map()) {
  const leads = arrayValue(inboxData?.campaign_to_candidate_users);
  const leadById = new Map(leads.map((lead) => [String(lead?.id || ""), lead]));
  const rows = [];

  for (const campaignEmail of arrayValue(inboxData?.campaign_emails)) {
    const email = campaignEmail?.email;
    if (!email || email.sent_from_paraform !== false) continue;
    const ccuId = stringValue(campaignEmail.campaign_to_candidate_user_id);
    const lead = leadById.get(ccuId) || {};
    const candidate = lead?.candidate_user?.candidate || {};
    const gmailId = stringValue(email.gmail_id);
    const recent = recentByGmail.get(gmailId) || {};

    const row = {
      candidate_name: stringValue(recent.candidate_name || candidate.name) || "Unknown candidate",
      candidate_email: stringValue(recent.candidate_email) || candidateEmail(lead),
      candidate_image: stringValue(recent.candidate_image || candidate.image_src),
      candidate_linkedin_url: stringValue(
        recent.candidate_linkedin_url || candidate.linkedin_user,
      ),
      candidate_one_liner: stringValue(recent.candidate_one_liner)
        || candidateOneLiner(candidate),
      sequence_name: stringValue(campaign.name || recent.sequence_name) || "Untitled sequence",
      sequence_id: stringValue(campaign.id || recent.sequence_id),
      subject: stringValue(email.subject || recent.email_subject) || "(no subject)",
      snippet: stringValue(email.snippet || recent.email_snippet),
      date: stringValue(email.email_date || recent.email_date),
      gmail_id: gmailId,
      thread_id: stringValue(email.thread_id || recent.thread_id),
      ccu_id: ccuId || stringValue(recent.id),
      reply_category: normalizeReplyCategory(lead.reply_category),
      tracking_status: normalizeTrackingStatus(lead.tracking_status),
      is_archived: Boolean(lead.is_archived),
      can_reply: Boolean(recent.can_reply ?? campaign.can_reply),
      attachment_count: attachmentCount(email, recent),
    };
    const addresses = [
      ...addressFields(campaignEmail),
      ...addressFields(email),
      ...addressFields(email.email_info),
      ...addressFields(recent),
      ...addressFields(lead),
    ];
    if (!shouldExcludeInboxReply(row, addresses)) rows.push(row);
  }
  return rows;
}

export function normalizeTrackingStatus(value) {
  const status = stringValue(value).toUpperCase();
  return ["CLICKED", "OPENED", "UNOPENED", "NA"].includes(status)
    ? status
    : "NA";
}

function recentFallbackRow(recent, campaignById, categoryByLead) {
  const sequenceId = stringValue(recent?.sequence_id);
  const ccuId = stringValue(recent?.id);
  const categoryKey = `${sequenceId}:${ccuId}`;
  const lead = categoryByLead.get(categoryKey) || {};
  const campaign = campaignById.get(sequenceId) || {};
  return {
    candidate_name: stringValue(recent?.candidate_name) || "Unknown candidate",
    candidate_email: stringValue(recent?.candidate_email),
    candidate_image: stringValue(recent?.candidate_image),
    candidate_linkedin_url: stringValue(recent?.candidate_linkedin_url),
    candidate_one_liner: stringValue(recent?.candidate_one_liner),
    sequence_name: stringValue(recent?.sequence_name || campaign.name) || "Untitled sequence",
    sequence_id: sequenceId,
    subject: stringValue(recent?.email_subject) || "(no subject)",
    snippet: stringValue(recent?.email_snippet),
    date: stringValue(recent?.email_date),
    gmail_id: stringValue(recent?.gmail_id),
    thread_id: stringValue(recent?.thread_id),
    ccu_id: ccuId,
    reply_category: normalizeReplyCategory(lead.reply_category),
    tracking_status: normalizeTrackingStatus(lead.tracking_status),
    is_archived: Boolean(lead.is_archived),
    can_reply: Boolean(recent?.can_reply ?? campaign.can_reply),
    attachment_count: attachmentCount(null, recent),
  };
}

export function mergeAndSortReplies(rows, recentReplies, campaigns, categoryByLead) {
  const campaignById = new Map(
    arrayValue(campaigns).map((campaign) => [String(campaign?.id || ""), campaign]),
  );
  const merged = new Map();
  for (const row of arrayValue(rows)) {
    if (shouldExcludeInboxReply(row)) continue;
    const key = rowKey(row);
    if (key) merged.set(key, row);
  }
  for (const recent of arrayValue(recentReplies)) {
    const sequenceId = stringValue(recent?.sequence_id);
    if (!campaignById.has(sequenceId)) continue;
    const row = recentFallbackRow(recent, campaignById, categoryByLead);
    if (shouldExcludeInboxReply(row, addressFields(recent))) continue;
    const key = rowKey(row);
    if (key && !merged.has(key)) merged.set(key, row);
  }
  return [...merged.values()].sort((a, b) => rowDate(b) - rowDate(a));
}

export async function mapWithConcurrency(items, limit, worker) {
  const values = arrayValue(items);
  const out = new Array(values.length);
  let cursor = 0;
  async function run() {
    while (cursor < values.length) {
      const index = cursor++;
      out[index] = await worker(values[index], index);
    }
  }
  const workers = Array.from(
    { length: Math.min(Math.max(1, limit), Math.max(1, values.length)) },
    () => run(),
  );
  await Promise.all(workers);
  return out;
}

function publicInboxCampaign(campaign) {
  const emailReplies = Number(campaign?.email_replies);
  return {
    id: stringValue(campaign?.id),
    name: stringValue(campaign?.name) || "Untitled sequence",
    kind: stringValue(campaign?.kind || campaign?.recipient_kind),
    can_reply: Boolean(campaign?.can_reply),
    email_replies: Number.isFinite(emailReplies) ? emailReplies : null,
  };
}

function leadCategories(inboxData, relevantLeadIds = new Set()) {
  const categories = {};
  for (const lead of arrayValue(inboxData?.campaign_to_candidate_users)) {
    const id = stringValue(lead?.id);
    if (!id || !relevantLeadIds.has(id)) continue;
    categories[id] = {
      reply_category: normalizeReplyCategory(lead?.reply_category),
      tracking_status: normalizeTrackingStatus(lead?.tracking_status),
      is_archived: Boolean(lead?.is_archived),
    };
  }
  return categories;
}

function createSequenceSnapshot(campaign, inboxData, recentByGmail, refreshedAt) {
  const campaignId = stringValue(campaign?.id);
  const recentLeadIds = new Set(
    [...recentByGmail.values()]
      .filter((reply) => stringValue(reply?.sequence_id) === campaignId)
      .map((reply) => stringValue(reply?.id))
      .filter(Boolean),
  );
  return {
    version: 3,
    sequence_id: campaignId,
    sequence_name: stringValue(campaign?.name) || "Untitled sequence",
    email_replies: Number.isFinite(Number(campaign?.email_replies))
      ? Number(campaign.email_replies)
      : null,
    refreshed_at: refreshedAt,
    replies: flattenCampaignInbox(campaign, inboxData, recentByGmail),
    // Reply rows already carry their category. Keep only lead metadata needed
    // to enrich the bounded recent-reply fallback, not every sequence member.
    lead_categories: leadCategories(inboxData, recentLeadIds),
  };
}

function snapshotTime(snapshot) {
  const value = Date.parse(snapshot?.refreshed_at || "");
  return Number.isFinite(value) ? value : 0;
}

export function selectInboxCampaigns(
  campaigns,
  previousState,
  recentReplies,
  {
    nowMs = Date.now(),
    batchSize = INBOX_SYNC_BATCH_SIZE,
    staleMs = INBOX_SEQUENCE_STALE_MS,
  } = {},
) {
  const snapshots = previousState?.snapshots instanceof Map
    ? previousState.snapshots
    : new Map();
  const attempts = previousState?.meta?.sequence_attempts || {};
  const recentSequenceIds = new Set(
    arrayValue(recentReplies)
      .map((reply) => stringValue(reply?.sequence_id))
      .filter(Boolean),
  );
  const eligible = [];
  for (const campaign of arrayValue(campaigns)) {
    const id = stringValue(campaign?.id);
    const snapshot = snapshots.get(id);
    const currentCount = Number(campaign?.email_replies);
    const storedCount = Number(snapshot?.email_replies);
    const countChanged = snapshot
      && Number.isFinite(currentCount)
      && (!Number.isFinite(storedCount) || currentCount !== storedCount);
    const recent = recentSequenceIds.has(id);
    const stale = snapshot && nowMs - snapshotTime(snapshot) >= staleMs;
    let priority;
    if (!snapshot) priority = 0;
    else if (countChanged) priority = 1;
    else if (recent) priority = 2;
    else if (stale) priority = 3;
    else continue;
    const lastAttempt = Date.parse(attempts[id] || "");
    eligible.push({
      campaign,
      priority,
      attemptedAt: Number.isFinite(lastAttempt) ? lastAttempt : 0,
      snapshotAt: snapshotTime(snapshot),
    });
  }
  eligible.sort((a, b) => (
    a.priority - b.priority
    || a.attemptedAt - b.attemptedAt
    || a.snapshotAt - b.snapshotAt
    || stringValue(a.campaign?.id).localeCompare(stringValue(b.campaign?.id))
  ));
  const limit = Number.isFinite(batchSize)
    ? Math.max(0, Math.floor(batchSize))
    : eligible.length;
  return eligible.slice(0, limit).map(({ campaign }) => campaign);
}

export async function buildInboxRefresh({
  get = inboxTrpcGet,
  concurrency = INBOX_FANOUT_CONCURRENCY,
  now = () => new Date(),
  budgetMs = INBOX_BUILD_BUDGET_MS,
  batchSize = INBOX_SYNC_BATCH_SIZE,
  previousState = emptyInboxSnapshotState(),
} = {}) {
  const deadline = Date.now() + Math.max(1_000, budgetMs);
  const call = (procedure, input, tries = 2) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const error = new Error("INBOX_BUILD_DEADLINE");
      error.code = "INBOX_BUILD_DEADLINE";
      throw error;
    }
    return get(
      procedure,
      input,
      tries,
      Math.min(INBOX_VENDOR_TIMEOUT_MS, Math.max(250, remaining)),
    );
  };
  const [campaignResult, recentResult] = await Promise.allSettled([
    call("campaigns.getListOfCampaignsOptimized", {}),
    call("campaigns.getRecentReplies", undefined),
  ]);
  if (campaignResult.status === "rejected") throw campaignResult.reason;
  const campaignsRaw = campaignResult.value;
  const campaigns = arrayValue(campaignsRaw);
  const eligibleCampaigns = campaigns.filter(isInboxRoleOutreachCampaign);
  const targets = campaignsToScan(campaigns);
  const targetIds = new Set(
    targets.map((campaign) => stringValue(campaign?.id)).filter(Boolean),
  );

  const recentError = recentResult.status === "rejected"
    ? recentResult.reason
    : null;
  const recentRepliesRaw = recentResult.status === "fulfilled"
    ? arrayValue(recentResult.value)
    : [];
  const recentReplies = recentRepliesRaw.filter((reply) => (
    targetIds.has(stringValue(reply?.sequence_id))
  ));
  const recentByGmail = new Map(
    recentReplies
      .filter((item) => stringValue(item?.gmail_id))
      .map((item) => [String(item.gmail_id), item]),
  );
  const selected = selectInboxCampaigns(targets, previousState, recentReplies, {
    nowMs: Date.now(),
    batchSize,
  });

  const results = await mapWithConcurrency(selected, concurrency, async (campaign) => {
    try {
      const data = await call(
        "campaigns.getCampaignInboxData",
        campaignInboxInput(campaign),
      );
      return { ok: true, campaign, data };
    } catch (error) {
      return {
        ok: false,
        campaign,
        error: error?.code || stringValue(error?.message) || "read_failed",
      };
    }
  });

  const failures = results.filter((result) => !result.ok);
  const generatedAt = now().toISOString();
  return {
    generated_at: generatedAt,
    catalog: {
      version: 3,
      refreshed_at: generatedAt,
      campaigns_total: campaigns.length,
      targets: targets.map(publicInboxCampaign),
    },
    target_sequence_ids: targets.map((campaign) => stringValue(campaign?.id)),
    selected_sequence_ids: selected.map((campaign) => stringValue(campaign?.id)),
    snapshots: results
      .filter((result) => result.ok)
      .map((result) => createSequenceSnapshot(
        result.campaign,
        result.data,
        recentByGmail,
        generatedAt,
      )),
    recent: recentError
      ? null
      : {
          version: 3,
          refreshed_at: generatedAt,
          replies: recentReplies,
        },
    scan: {
      campaigns_total: campaigns.length,
      campaigns_excluded: campaigns.length - eligibleCampaigns.length,
      campaigns_targeted: targets.length,
      campaigns_attempted: selected.length,
      campaigns_deferred: Math.max(0, targets.length - selected.length),
      campaigns_succeeded: selected.length - failures.length,
      campaigns_failed: failures.length,
      recent_count: recentReplies.length,
      recent_excluded: recentRepliesRaw.length - recentReplies.length,
      recent_failed: Boolean(recentError),
      failures: failures.map((item) => ({
        sequence_id: stringValue(item.campaign?.id),
        sequence_name: stringValue(item.campaign?.name) || "Untitled sequence",
        error: stringValue(item.error) || "read_failed",
      })),
    },
  };
}

// Backward-compatible one-shot builder retained for focused contract tests and
// diagnostics. Production serves the durable v3 materialized state below.
export async function buildInboxFeed(options = {}) {
  const refresh = await buildInboxRefresh({
    ...options,
    batchSize: Number.POSITIVE_INFINITY,
    previousState: emptyInboxSnapshotState(),
  });
  const state = mergeInboxRefreshState(emptyInboxSnapshotState(), refresh);
  const materialized = assembleInboxSnapshotFeed(state, {
    now: options.now || (() => new Date()),
  });
  const partial = refresh.scan.campaigns_failed > 0
    || refresh.scan.recent_failed;
  return {
    generated_at: refresh.generated_at,
    partial,
    cacheable: !partial,
    replies: materialized.replies,
    counts: materialized.counts,
    scan: {
      campaigns_total: refresh.scan.campaigns_total,
      campaigns_excluded: refresh.scan.campaigns_excluded,
      campaigns_attempted: refresh.scan.campaigns_targeted,
      campaigns_succeeded: refresh.scan.campaigns_succeeded,
      campaigns_failed: refresh.scan.campaigns_failed,
      recent_count: refresh.scan.recent_count,
      recent_excluded: refresh.scan.recent_excluded,
      recent_failed: refresh.scan.recent_failed,
      failures: refresh.scan.failures,
    },
  };
}

const parseJson = (value) => {
  try {
    return typeof value === "string" && value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
};

function storedObject(value) {
  return typeof value === "string" ? parseJson(value) : value;
}

function storedHashEntries(value) {
  if (Array.isArray(value)) {
    const entries = [];
    for (let index = 0; index + 1 < value.length; index += 2) {
      entries.push([value[index], value[index + 1]]);
    }
    return entries;
  }
  return value && typeof value === "object" ? Object.entries(value) : [];
}

function normalizeSequenceSnapshot(value, fieldId) {
  const snapshot = storedObject(value);
  const sequenceId = stringValue(snapshot?.sequence_id || fieldId);
  if (
    !snapshot
    || typeof snapshot !== "object"
    || snapshot.version !== 3
    || !sequenceId
    || sequenceId !== stringValue(fieldId)
    || !Array.isArray(snapshot.replies)
    || !snapshot.lead_categories
    || typeof snapshot.lead_categories !== "object"
  ) {
    return null;
  }
  return {
    version: 3,
    sequence_id: sequenceId,
    sequence_name: stringValue(snapshot.sequence_name) || "Untitled sequence",
    email_replies: Number.isFinite(Number(snapshot.email_replies))
      ? Number(snapshot.email_replies)
      : null,
    refreshed_at: stringValue(snapshot.refreshed_at),
    replies: snapshot.replies.filter((reply) => reply && typeof reply === "object"),
    lead_categories: snapshot.lead_categories,
  };
}

export function parseInboxSequenceSnapshots(value, { strict = true } = {}) {
  const snapshots = new Map();
  for (const [fieldIdRaw, snapshotRaw] of storedHashEntries(value)) {
    const fieldId = stringValue(fieldIdRaw);
    if (!fieldId) continue;
    const snapshot = normalizeSequenceSnapshot(snapshotRaw, fieldId);
    if (!snapshot) {
      if (strict) {
        const error = new Error("invalid persisted Inbox sequence snapshot");
        error.code = "INVALID_INBOX_SNAPSHOT";
        throw error;
      }
      continue;
    }
    snapshots.set(fieldId, snapshot);
  }
  return snapshots;
}

function normalizeInboxCatalog(value) {
  const catalog = storedObject(value);
  if (!catalog) {
    return { version: 3, refreshed_at: "", campaigns_total: 0, targets: [] };
  }
  if (catalog.version !== 3 || !Array.isArray(catalog.targets)) {
    const error = new Error("invalid persisted Inbox catalog");
    error.code = "INVALID_INBOX_CATALOG";
    throw error;
  }
  return {
    version: 3,
    refreshed_at: stringValue(catalog.refreshed_at),
    campaigns_total: Math.max(0, Number(catalog.campaigns_total) || 0),
    targets: catalog.targets
      .map(publicInboxCampaign)
      .filter((campaign) => campaign.id),
  };
}

function normalizeInboxRecent(value) {
  const recent = storedObject(value);
  if (!recent) return { version: 3, refreshed_at: "", replies: [] };
  if (recent.version !== 3 || !Array.isArray(recent.replies)) {
    const error = new Error("invalid persisted Inbox recent-reply snapshot");
    error.code = "INVALID_INBOX_RECENT";
    throw error;
  }
  return {
    version: 3,
    refreshed_at: stringValue(recent.refreshed_at),
    replies: recent.replies.filter((reply) => reply && typeof reply === "object"),
  };
}

function normalizeInboxRefreshMeta(value) {
  const meta = storedObject(value);
  if (!meta) return { version: 3, sequence_attempts: {}, failures: [] };
  if (meta.version !== 3 || typeof meta !== "object") {
    const error = new Error("invalid persisted Inbox refresh metadata");
    error.code = "INVALID_INBOX_REFRESH_META";
    throw error;
  }
  return {
    ...meta,
    version: 3,
    sequence_attempts: meta.sequence_attempts
      && typeof meta.sequence_attempts === "object"
      ? meta.sequence_attempts
      : {},
    failures: arrayValue(meta.failures),
  };
}

export function emptyInboxSnapshotState() {
  return {
    snapshots: new Map(),
    catalog: normalizeInboxCatalog(null),
    recent: normalizeInboxRecent(null),
    meta: normalizeInboxRefreshMeta(null),
  };
}

export async function readInboxSnapshotState({
  pipelineImpl = pipeline,
  configured = storeConfigured(),
} = {}) {
  if (!configured) return { status: "unavailable", value: null };
  try {
    const values = await pipelineImpl([
      ["HGETALL", INBOX_SEQUENCE_SNAPSHOTS_KEY],
      ["GET", INBOX_CATALOG_KEY],
      ["GET", INBOX_RECENT_KEY],
      ["GET", INBOX_REFRESH_META_KEY],
    ]);
    if (!Array.isArray(values) || values.length !== 4) {
      throw new Error("Inbox snapshot read returned an invalid response");
    }
    return {
      status: "ready",
      value: {
        snapshots: parseInboxSequenceSnapshots(values[0]),
        catalog: normalizeInboxCatalog(values[1]),
        recent: normalizeInboxRecent(values[2]),
        meta: normalizeInboxRefreshMeta(values[3]),
      },
    };
  } catch {
    return { status: "error", value: null };
  }
}

function failureErrorCounts(failures) {
  const counts = {};
  for (const failure of arrayValue(failures)) {
    const error = stringValue(failure?.error) || "read_failed";
    counts[error] = (counts[error] || 0) + 1;
  }
  return counts;
}

export function mergeInboxRefreshState(previousState, refresh) {
  const previous = previousState || emptyInboxSnapshotState();
  const targetIds = new Set(arrayValue(refresh?.target_sequence_ids));
  const snapshots = new Map(
    [...(previous.snapshots || new Map()).entries()]
      .filter(([sequenceId]) => targetIds.has(sequenceId)),
  );
  for (const snapshot of arrayValue(refresh?.snapshots)) {
    const normalized = normalizeSequenceSnapshot(snapshot, snapshot?.sequence_id);
    if (!normalized || !targetIds.has(normalized.sequence_id)) continue;
    snapshots.set(normalized.sequence_id, normalized);
  }
  const catalog = normalizeInboxCatalog(refresh?.catalog);
  const recent = refresh?.recent
    ? normalizeInboxRecent(refresh.recent)
    : previous.recent || normalizeInboxRecent(null);
  const sequenceAttempts = {};
  for (const [sequenceId, attemptedAt] of Object.entries(
    previous.meta?.sequence_attempts || {},
  )) {
    if (targetIds.has(sequenceId)) sequenceAttempts[sequenceId] = attemptedAt;
  }
  for (const sequenceId of arrayValue(refresh?.selected_sequence_ids)) {
    if (targetIds.has(sequenceId)) {
      sequenceAttempts[sequenceId] = refresh.generated_at;
    }
  }
  const seeded = [...targetIds].filter((sequenceId) => snapshots.has(sequenceId));
  const generatedMs = Date.parse(refresh?.generated_at || "");
  const currentMs = Number.isFinite(generatedMs) ? generatedMs : Date.now();
  const staleCount = seeded.filter((sequenceId) => (
    currentMs - snapshotTime(snapshots.get(sequenceId)) >= INBOX_SEQUENCE_STALE_MS
  )).length;
  const failures = arrayValue(refresh?.scan?.failures);
  const coverageComplete = Boolean(catalog.refreshed_at)
    && seeded.length === targetIds.size
    && failures.length === 0
    && !refresh?.scan?.recent_failed;
  const meta = {
    version: 3,
    last_refresh_at: stringValue(refresh?.generated_at),
    last_complete_at: coverageComplete
      ? stringValue(refresh?.generated_at)
      : stringValue(previous.meta?.last_complete_at),
    campaigns_total: catalog.campaigns_total,
    campaigns_targeted: targetIds.size,
    campaigns_attempted: Number(refresh?.scan?.campaigns_attempted) || 0,
    campaigns_deferred: Number(refresh?.scan?.campaigns_deferred) || 0,
    campaigns_succeeded: Number(refresh?.scan?.campaigns_succeeded) || 0,
    campaigns_failed: Number(refresh?.scan?.campaigns_failed) || 0,
    campaigns_seeded: seeded.length,
    campaigns_missing: Math.max(0, targetIds.size - seeded.length),
    campaigns_stale: staleCount,
    recent_count: Number(refresh?.scan?.recent_count) || recent.replies.length,
    recent_excluded: Number(refresh?.scan?.recent_excluded) || 0,
    recent_failed: Boolean(refresh?.scan?.recent_failed),
    failure_error_counts: failureErrorCounts(failures),
    failures,
    sequence_attempts: sequenceAttempts,
  };
  return { snapshots, catalog, recent, meta };
}

export async function writeInboxRefreshState(
  previousState,
  refresh,
  {
    pipelineImpl = pipeline,
    configured = storeConfigured(),
  } = {},
) {
  if (!configured) {
    const error = new Error("Inbox state store not configured");
    error.code = "INBOX_STORE_NOT_CONFIGURED";
    throw error;
  }
  const merged = mergeInboxRefreshState(previousState, refresh);
  const commands = [];
  const targetIds = new Set(arrayValue(refresh?.target_sequence_ids));
  const snapshotArgs = arrayValue(refresh?.snapshots)
    .map((snapshot) => normalizeSequenceSnapshot(
      snapshot,
      snapshot?.sequence_id,
    ))
    .filter((snapshot) => snapshot && targetIds.has(snapshot.sequence_id))
    .flatMap((snapshot) => [
      stringValue(snapshot.sequence_id),
      JSON.stringify(snapshot),
    ]);
  if (snapshotArgs.length) {
    commands.push(["HSET", INBOX_SEQUENCE_SNAPSHOTS_KEY, ...snapshotArgs]);
  }
  const retainedIds = new Set(merged.snapshots.keys());
  const prunedIds = [...(previousState?.snapshots || new Map()).keys()]
    .filter((sequenceId) => !retainedIds.has(sequenceId));
  if (prunedIds.length) {
    commands.push(["HDEL", INBOX_SEQUENCE_SNAPSHOTS_KEY, ...prunedIds]);
  }
  commands.push(["SET", INBOX_CATALOG_KEY, JSON.stringify(merged.catalog)]);
  if (refresh?.recent) {
    commands.push(["SET", INBOX_RECENT_KEY, JSON.stringify(merged.recent)]);
  }
  commands.push(["SET", INBOX_REFRESH_META_KEY, JSON.stringify(merged.meta)]);
  await pipelineImpl(commands);
  return merged;
}

export function assembleInboxSnapshotFeed(
  state,
  { now = () => new Date() } = {},
) {
  const snapshotState = state || emptyInboxSnapshotState();
  const targets = arrayValue(snapshotState.catalog?.targets);
  const targetIds = new Set(targets.map((campaign) => stringValue(campaign?.id)));
  const rows = [];
  const categoryByLead = new Map();
  for (const [sequenceId, snapshot] of snapshotState.snapshots || new Map()) {
    if (!targetIds.has(sequenceId)) continue;
    rows.push(...arrayValue(snapshot?.replies));
    for (const [leadId, category] of Object.entries(
      snapshot?.lead_categories || {},
    )) {
      categoryByLead.set(`${sequenceId}:${leadId}`, category);
    }
  }
  const replies = mergeAndSortReplies(
    rows,
    snapshotState.recent?.replies,
    targets,
    categoryByLead,
  );
  const currentMs = now().getTime();
  const seededCount = [...targetIds]
    .filter((sequenceId) => snapshotState.snapshots?.has(sequenceId)).length;
  const staleCount = [...targetIds].filter((sequenceId) => {
    const snapshot = snapshotState.snapshots?.get(sequenceId);
    return snapshot
      && currentMs - snapshotTime(snapshot) >= INBOX_SEQUENCE_STALE_MS;
  }).length;
  const catalogReady = Boolean(snapshotState.catalog?.refreshed_at);
  const missingCount = Math.max(0, targetIds.size - seededCount);
  const latestFailures = Number(snapshotState.meta?.campaigns_failed) || 0;
  const stateName = !catalogReady
    ? "unseeded"
    : missingCount > 0
      ? "seeding"
      : latestFailures > 0 || staleCount > 0
        ? "degraded"
        : "ready";
  return {
    generated_at: stringValue(
      snapshotState.meta?.last_refresh_at
      || snapshotState.catalog?.refreshed_at
      || snapshotState.recent?.refreshed_at,
    ),
    partial: false,
    cacheable: true,
    replies,
    counts: countInboxReplies(replies),
    freshness: {
      state: stateName,
      coverage_complete: catalogReady && missingCount === 0,
      last_refresh_at: stringValue(snapshotState.meta?.last_refresh_at),
      last_complete_at: stringValue(snapshotState.meta?.last_complete_at),
      campaigns_targeted: targetIds.size,
      campaigns_seeded: seededCount,
      campaigns_missing: missingCount,
      campaigns_stale: staleCount,
      latest_failures: latestFailures,
    },
    scan: {
      campaigns_total: Number(snapshotState.catalog?.campaigns_total) || 0,
      campaigns_targeted: targetIds.size,
      campaigns_attempted: Number(snapshotState.meta?.campaigns_attempted) || 0,
      campaigns_deferred: Number(snapshotState.meta?.campaigns_deferred) || 0,
      campaigns_succeeded: Number(snapshotState.meta?.campaigns_succeeded) || 0,
      campaigns_failed: latestFailures,
      campaigns_seeded: seededCount,
      campaigns_missing: missingCount,
      campaigns_stale: staleCount,
      recent_count: snapshotState.recent?.replies?.length || 0,
      recent_excluded: Number(snapshotState.meta?.recent_excluded) || 0,
      recent_failed: Boolean(snapshotState.meta?.recent_failed),
      failure_error_counts: snapshotState.meta?.failure_error_counts || {},
    },
  };
}

function normalizeInboxTriageRecord(value) {
  const record = typeof value === "string" ? parseJson(value) : value;
  if (!record || typeof record !== "object") return null;
  const status = stringValue(record.status).toLowerCase();
  if (!INBOX_TRIAGE_STATUSES.includes(status)) return null;
  return {
    status,
    updated_at: stringValue(record.updated_at),
  };
}

export function parseInboxTriage(value, { strict = true } = {}) {
  const entries = [];
  if (Array.isArray(value)) {
    for (let index = 0; index + 1 < value.length; index += 2) {
      entries.push([value[index], value[index + 1]]);
    }
  } else if (value && typeof value === "object") {
    entries.push(...Object.entries(value));
  }

  const triage = new Map();
  for (const [gmailIdRaw, recordRaw] of entries) {
    const gmailId = stringValue(gmailIdRaw);
    const record = normalizeInboxTriageRecord(recordRaw);
    if (!validInboxGmailId(gmailId)) continue;
    if (!record) {
      if (strict) {
        const error = new Error("invalid persisted Inbox triage record");
        error.code = "INVALID_TRIAGE_RECORD";
        throw error;
      }
      continue;
    }
    triage.set(gmailId, record);
  }
  return triage;
}

export function inboxReplyBucket(reply) {
  if (reply?.triage_status === "complete") return "complete";
  if (reply?.triage_status === "archived" || reply?.is_archived) {
    return "archived";
  }
  return "active";
}

export function countInboxReplies(repliesRaw) {
  const replies = arrayValue(repliesRaw);
  const active = replies.filter((reply) => inboxReplyBucket(reply) === "active");
  return {
    total: replies.length,
    interested: active.filter((reply) => (
      reply.reply_category === "INTERESTED"
    )).length,
    needs_review: active.filter((reply) => (
      reply.reply_category === "UNCLEAR"
    )).length,
    not_interested: active.filter((reply) => (
      reply.reply_category === "NOT_INTERESTED"
    )).length,
    archived: replies.filter((reply) => (
      inboxReplyBucket(reply) === "archived"
    )).length,
    complete: replies.filter((reply) => (
      inboxReplyBucket(reply) === "complete"
    )).length,
  };
}

export function applyInboxTriage(feed, triageRaw) {
  const triage = triageRaw instanceof Map
    ? triageRaw
    : parseInboxTriage(triageRaw);
  const replies = arrayValue(feed?.replies)
    .filter((reply) => !shouldExcludeInboxReply(reply))
    .map((reply) => {
      const record = validInboxGmailId(reply?.gmail_id)
        ? triage.get(reply.gmail_id)
        : null;
      return {
        ...reply,
        triage_status: record?.status || null,
        triage_updated_at: record?.updated_at || "",
      };
    });
  return {
    ...feed,
    replies,
    counts: countInboxReplies(replies),
  };
}

export async function readInboxTriage({
  kvImpl = kv,
  configured = storeConfigured(),
} = {}) {
  if (!configured) return { status: "unavailable", value: null };
  try {
    const value = parseInboxTriage(await kvImpl(["HGETALL", INBOX_TRIAGE_KEY]));
    return { status: "ready", value };
  } catch {
    return { status: "error", value: null };
  }
}

export async function writeInboxTriage(
  gmailIdRaw,
  statusRaw,
  {
    kvImpl = kv,
    now = () => new Date(),
  } = {},
) {
  const gmailId = stringValue(gmailIdRaw);
  const status = statusRaw === null
    ? null
    : stringValue(statusRaw).toLowerCase();
  if (!validInboxGmailId(gmailId)) {
    const error = new Error("invalid Gmail ID");
    error.code = "INVALID_GMAIL_ID";
    throw error;
  }
  if (status !== null && !INBOX_TRIAGE_STATUSES.includes(status)) {
    const error = new Error("invalid triage status");
    error.code = "INVALID_TRIAGE_STATUS";
    throw error;
  }

  if (status === null) {
    const script = `
      redis.call('HDEL', KEYS[1], ARGV[1])
      return redis.call('HEXISTS', KEYS[1], ARGV[1])
    `;
    const confirmed = await kvImpl([
      "EVAL",
      script,
      1,
      INBOX_TRIAGE_KEY,
      gmailId,
    ]);
    if (Number(confirmed) !== 0) {
      const error = new Error("triage restore was not confirmed");
      error.code = "TRIAGE_WRITE_NOT_CONFIRMED";
      throw error;
    }
    return { gmail_id: gmailId, status: null, updated_at: null };
  }

  const record = {
    status,
    updated_at: now().toISOString(),
  };
  const script = `
    redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
    return redis.call('HGET', KEYS[1], ARGV[1])
  `;
  const confirmed = normalizeInboxTriageRecord(await kvImpl([
    "EVAL",
    script,
    1,
    INBOX_TRIAGE_KEY,
    gmailId,
    JSON.stringify(record),
  ]));
  if (
    confirmed?.status !== record.status
    || confirmed?.updated_at !== record.updated_at
  ) {
    const error = new Error("triage write was not confirmed");
    error.code = "TRIAGE_WRITE_NOT_CONFIRMED";
    throw error;
  }
  return { gmail_id: gmailId, ...record };
}

export async function acquireInboxSyncLock({
  kvImpl = kv,
  configured = storeConfigured(),
} = {}) {
  if (!configured) {
    return { status: "unavailable", token: null };
  }
  const token = randomUUID();
  try {
    const result = await kvImpl([
      "SET",
      INBOX_SYNC_LOCK_KEY,
      token,
      "NX",
      "EX",
      120,
    ]);
    return result === "OK"
      ? { status: "acquired", token }
      : { status: "busy", token: null };
  } catch {
    return { status: "error", token: null };
  }
}

export async function releaseInboxSyncLock(
  token,
  {
    kvImpl = kv,
    configured = storeConfigured(),
  } = {},
) {
  if (!token || !configured) return false;
  const script = `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      return redis.call('DEL', KEYS[1])
    end
    return 0
  `;
  try {
    return Number(await kvImpl([
      "EVAL",
      script,
      1,
      INBOX_SYNC_LOCK_KEY,
      token,
    ])) === 1;
  } catch {
    return false;
  }
}

export function requestQuery(req) {
  if (req?.query && typeof req.query === "object") return req.query;
  if (typeof req?.url !== "string") return {};
  return Object.fromEntries(new URL(req.url, "http://localhost").searchParams);
}

export function publicMessage(messageRaw) {
  const info = messageRaw?.email_info || {};
  const attachments = arrayValue(messageRaw?.thread_attachments);
  return {
    body: typeof messageRaw?.email_body === "string" ? messageRaw.email_body : "",
    from: stringValue(info.from),
    from_name: stringValue(info.from_name),
    to: arrayValue(info.to).map(stringValue).filter(Boolean),
    cc: arrayValue(info.cc).map(stringValue).filter(Boolean),
    subject: stringValue(info.subject) || "(no subject)",
    date: stringValue(info.email_date || info.created_at),
    sent_from_paraform: Boolean(info.sent_from_paraform),
    attachment_count: attachments.length,
  };
}
