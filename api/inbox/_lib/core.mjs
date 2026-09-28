// Cross-sequence reply inbox. Paraform remains the read-only message source;
// Raydar separately owns durable Archive/Complete triage state for the
// authenticated Monitor UI.

import { createHash, randomUUID } from "node:crypto";
import {
  BASE,
  authConfig,
  cors,
  ensureParaformSession,
  hasCookie,
  headers,
  notifyParaformSessionRejected,
  paraformCookieName,
  paraformCookieValue,
  paraformHealth,
  requireAuth,
} from "../../seq/_lib/core.mjs";
import {
  kv,
  pipeline,
  storeConfigured,
} from "../../sourcing/_lib/store.mjs";
import { OUTCOME_SEQUENCE_RULES } from "../../roster/_lib/outcome-sequences.mjs";
import { telemetryFetch } from "../../_lib/paraform-telemetry-context.mjs";

// headers() is synchronous and sends whatever ensureParaformSession() last
// resolved in this process, falling back to the static env seal (which
// WorkOS rotates away within hours) when nothing has been resolved yet. Every
// Inbox entrypoint that reaches Paraform must await ensureParaformSession()
// first. A 401 is not a verdict on its own (Paraform also answers 401 for
// burst throttling); see fallThroughDeadInboxSession below for how inboxTrpcGet
// moves off a stored session that is actually dead.
export {
  authConfig,
  cors,
  ensureParaformSession,
  hasCookie,
  paraformHealth,
  storeConfigured,
};

export function resolveInboxParaformSession() {
  return ensureParaformSession({ timeoutMs: INBOX_SESSION_TIMEOUT_MS });
}

export const INBOX_SESSION_HOOKS = Object.freeze({
  current: () => paraformCookieValue(),
  reject: () => notifyParaformSessionRejected(),
  resolve: () => resolveInboxParaformSession(),
});

const CURRENT_USER_PROBE_URL = `${BASE}/trpc/user.getCurrentUser?input=`
  + encodeURIComponent(JSON.stringify({ json: null, meta: { values: {}, v: 1 } }));
const INBOX_PROBE_DELAY_MS = 1_500;
const INBOX_PROBE_TIMEOUT_MS = 4_000;
const INBOX_DEAD_COOKIE_MEMORY = 16;
// Same window as the store's slot rejection: a verdict reached during a long
// account-wide throttle must not brand a live cookie dead for good.
const INBOX_DEAD_COOKIE_TTL_MS = 30 * 60 * 1_000;
let deadInboxCookies = new Map(); // cookie -> epoch ms the verdict expires
let inboxCookieProbes = new Map();

export function __resetInboxSessionProbesForTests() {
  deadInboxCookies = new Map();
  inboxCookieProbes = new Map();
}

function knownDeadInboxCookie(cookie, nowMs = Date.now()) {
  const until = deadInboxCookies.get(cookie);
  if (until === undefined) return false;
  if (until > nowMs) return true;
  deadInboxCookies.delete(cookie);
  return false;
}

// Two spaced serial probes of the exact refused cookie, shared by every read
// that got a 401 on it, so a burst of concurrent 401s costs one probe run and
// a throttle that clears within a few seconds keeps the slot. A cookie proven
// dead is remembered for 30 minutes so later 401s on it skip the probes.
function inboxCookieIsDead(cookie, observedFetch, sleepImpl, randomImpl) {
  if (knownDeadInboxCookie(cookie)) return Promise.resolve(true);
  let pending = inboxCookieProbes.get(cookie);
  if (!pending) {
    pending = (async () => {
      for (let round = 1; round <= 2; round += 1) {
        await sleepImpl(INBOX_PROBE_DELAY_MS * round + Math.floor(randomImpl() * 500));
        const probe = await observedFetch(CURRENT_USER_PROBE_URL, {
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            cookie: `${paraformCookieName(cookie)}=${cookie}`,
          },
          signal: AbortSignal.timeout(INBOX_PROBE_TIMEOUT_MS),
        }).catch(() => null);
        if (probe?.status !== 401) return false;
      }
      deadInboxCookies.delete(cookie);
      deadInboxCookies.set(cookie, Date.now() + INBOX_DEAD_COOKIE_TTL_MS);
      if (deadInboxCookies.size > INBOX_DEAD_COOKIE_MEMORY) {
        deadInboxCookies.delete(deadInboxCookies.keys().next().value);
      }
      return true;
    })().catch(() => false).finally(() => inboxCookieProbes.delete(cookie));
    inboxCookieProbes.set(cookie, pending);
  }
  return pending;
}

// The store resolves slots in order (shared, then the david account, then
// env) and only moves past one that was reported rejected. Measured
// 2026-09-28: the shared n8n slot was dead (last renewed Sep 25) while the
// david slot was live, so an Inbox that never reported a 401 retried the dead
// slot forever. Reporting every 401 is wrong too: a burst throttle would park
// a live slot for 30 minutes. So a 401 on the process's current session is
// confirmed by inboxCookieIsDead before the slot is parked and re-resolved;
// when another read already moved the process on, this just waits for that
// resolution. Returns "moved" when the next read will send a different
// session, so the caller can retry once on it.
export async function fallThroughDeadInboxSession(
  sentCookie,
  observedFetch,
  {
    sleepImpl = sleep,
    randomImpl = Math.random,
    session = INBOX_SESSION_HOOKS,
  } = {},
) {
  if (sentCookie && session.current() === sentCookie) {
    if (!(await inboxCookieIsDead(sentCookie, observedFetch, sleepImpl, randomImpl))) {
      return "kept";
    }
    // Re-check after the await: a concurrent read may already have parked
    // this slot and resolved the next one, which must not be parked too.
    if (session.current() === sentCookie) session.reject();
  }
  await Promise.resolve().then(() => session.resolve()).catch(() => {});
  return session.current() && session.current() !== sentCookie ? "moved" : "resolved";
}

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
// A hung n8n store must not eat the sync/manual-sync function budget (their
// build budgets start after this). On timeout this one request falls back to
// the env seal and the still-running store read warms the cache for the next.
export const INBOX_SESSION_TIMEOUT_MS = 8_000;
export const INBOX_SEQUENCE_STALE_MS = 15 * 60 * 1_000;
// campaigns.getRecentReplies measured 6.7s on 2026-09-28, over the 6s vendor
// timeout, so the recent window failed on every sync. It gets its own cap.
export const INBOX_RECENT_TIMEOUT_MS = 15_000;

// ---- Scheduled, change-driven refresh (mode "changed") ----
// The Inbox refreshes on a schedule (vercel.json, three times a day) instead of
// re-reading every sequence older than 15 minutes whenever a page is open.
// campaigns.getListOfCampaignsOptimized carries no reply counts, so each run
// asks campaigns.getMetricsForSequences (the call Paraform's own Sequences
// page makes; zod caps it at 10 ids) for every target's replies_count and
// interested_replies. Measured 2026-09-28, both count PEOPLE, not emails, so
// a second email from someone who already replied is found through the recent
// window instead. Only sequences with evidence of change are re-read.
export const INBOX_METRICS_BATCH_SIZE = 10;
export const INBOX_CHANGED_BATCH_SIZE = 150; // bounded in practice by the build budget
// A snapshot taken within this long of its newest reply is read once more
// later, so a classification Paraform finishes after our read is picked up.
export const INBOX_SETTLE_MS = 2 * 60 * 60 * 1_000;
// Only follow-ups from people who already replied can arrive without moving
// the counts, and the recent window is how they are found. When the window no
// longer reaches back to the last run that read it (meta.recent_watermark),
// every sequence with any stored reply is re-read. Measured 2026-09-28 the
// 20-item window spanned about 45 hours, so this is rare.
export const INBOX_SNAPSHOT_WRITE_CHUNK_BYTES = 512 * 1_024;
// A target whose counts could not be read is re-read once its snapshot is this old.
export const INBOX_UNMETERED_READ_AFTER_MS = 8 * 60 * 60 * 1_000;
// A few of the longest-unread snapshots are re-read every run as a drift check.
export const INBOX_ROTATION_PER_RUN = 3;
// The UI calls a sequence stale only when neither a read nor a verified run
// has confirmed it for longer than the longest gap between scheduled runs
// (overnight, about 14 hours) plus slack.
export const INBOX_SCHEDULED_STALE_MS = 16 * 60 * 60 * 1_000;
const RECENT_CLOCK_SKEW_MS = 5 * 60 * 1_000;
// getRecentReplies returns 20 items today. A shorter answer is the whole
// history (nothing was cut off); at 10 or more items it may be truncated, so
// it only proves coverage if it reaches back to the watermark. Each run
// records the window size in last_run in case Paraform changes it.
const RECENT_WINDOW_TRUNCATED_AT = 10;
// HGETALL can exceed the KV response cap once every Inbox shard is seeded.
// Keep each HSCAN page small and its complete read inside the broker's 38s KV
// allowance beneath the fixed 120s shared lock.
export const INBOX_SNAPSHOT_SCAN_COUNT = 8;
export const INBOX_SNAPSHOT_SCAN_MAX_PAGES = 64;
export const INBOX_SNAPSHOT_SCAN_BUDGET_MS = 12_000;
export const INBOX_SUBMISSIONS_PROJECTION_VERSION = 1;
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
    || campaign?.linked_outreach_id
    || campaign?.project?.id
    || campaign?.role_id
    || campaign?.role_specific_id
    || campaign?.role?.id,
  );
}

export function exactCampaignRoleId(campaign) {
  return stringValue(campaign?.role_id);
}

function cachedExactCampaignRoleId(campaign) {
  const direct = exactCampaignRoleId(campaign);
  if (direct) return direct;
  return campaign?.exact_role_source === "campaign.role_id"
    ? stringValue(campaign?.exact_role_id)
    : "";
}

function cachedExactCampaignProjectId(campaign) {
  const direct = stringValue(campaign?.project_id);
  if (direct) return direct;
  return campaign?.exact_project_source === "campaign.project_id"
    ? stringValue(campaign?.exact_project_id)
    : "";
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

export function shouldExcludeSubmissionsInboxReply(reply) {
  const subject = stringValue(reply?.subject || reply?.email_subject);
  const snippet = stringValue(reply?.snippet || reply?.email_snippet);
  const senderTokens = emailTokens([
    reply?.candidate_email,
    reply?.from,
    reply?.from_email,
    reply?.sender,
    reply?.sender_email,
  ]);
  if (senderTokens.some((token) => /@(?:raydar\.xyz|heyraydar\.com)$/iu.test(token))) {
    return true;
  }
  if (senderTokens.some((token) => DELIVERY_SYSTEM_ADDRESS_RE.test(token))) {
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
  session = INBOX_SESSION_HOOKS,
) {
  const observedFetch = telemetryFetch(fetchImpl, "dashboard-inbox");
  const input = {
    json,
    meta: { values: {}, v: 1 },
  };
  const url = `${BASE}/trpc/${procedure}?input=`
    + encodeURIComponent(JSON.stringify(input));
  const attempts = Math.max(1, Number(tries) || 1);
  let retriedOnMovedSession = false;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const sentCookie = session.current();
      const response = await observedFetch(url, {
        headers: headers(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 401) {
        const outcome = await fallThroughDeadInboxSession(sentCookie, observedFetch, {
          sleepImpl,
          randomImpl,
          session,
        });
        // A dead stored session was replaced: retry once on the new one even
        // when the caller allowed a single try (the paced manual sweep).
        if (outcome === "moved" && !retriedOnMovedSession) {
          retriedOnMovedSession = true;
          attempt -= 1;
          continue;
        }
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
  // The campaign catalog's `email` is its owner, not a From address.  Sender
  // exclusion remains a message-level UI concern; submission admission checks
  // the complete provider message instead.
  return Boolean(stringValue(campaign?.id) && linkedOutreachId(campaign));
}

// The five post-call curated-list sequences intentionally have no role or
// Project link. Their pinned IDs remain admitted independently of reply counts.
export function isInboxCuratedListCampaign(campaign) {
  const id = stringValue(campaign?.id);
  return Boolean(id && OUTCOME_SEQUENCE_RULES.some((rule) => rule.id === id));
}

function isAdmittedInboxCampaign(campaign) {
  return isInboxRoleOutreachCampaign(campaign) || isInboxCuratedListCampaign(campaign);
}

function hasCandidateReplies(campaign, recentSequenceIds = new Set()) {
  const id = stringValue(campaign?.id);
  if (!id) return false;
  return Number(campaign?.email_replies) > 0 || recentSequenceIds.has(id);
}

export function campaignsToScan(campaigns, recentReplies = []) {
  // Keep the established role/project and curated-list scope, but also retain
  // any candidate-reply-bearing sequence. The latter must remain visible even
  // without an exact role; downstream intake routes it to Needs Review.
  // Campaign-level sender metadata still excludes the primary Raydar inbox.
  const recentSequenceIds = new Set(arrayValue(recentReplies)
    .map((reply) => stringValue(reply?.sequence_id)).filter(Boolean));
  const valid = arrayValue(campaigns).filter((campaign) => (
    isAdmittedInboxCampaign(campaign) || hasCandidateReplies(campaign, recentSequenceIds)
  ));
  const hasReplyCounts = valid.length > 0 && valid.every((campaign) => (
    Object.prototype.hasOwnProperty.call(campaign, "email_replies")
    && Number.isFinite(Number(campaign.email_replies))
  ));
  if (!hasReplyCounts) return valid;
  // Disabled sequences still carry historical replies and must remain visible.
  return valid.filter((campaign) => (
    Number(campaign.email_replies) > 0
    || recentSequenceIds.has(stringValue(campaign?.id))
  ));
}

function retainPreviousTargetsWhenRecentFails(campaigns, currentTargets, previousState) {
  const targetIds = new Set(arrayValue(currentTargets)
    .map((campaign) => stringValue(campaign?.id)).filter(Boolean));
  const liveById = new Map(arrayValue(campaigns)
    .map((campaign) => [stringValue(campaign?.id), campaign])
    .filter(([sequenceId]) => sequenceId));
  const retained = [...arrayValue(currentTargets)];
  for (const previous of arrayValue(previousState?.catalog?.targets)) {
    const sequenceId = stringValue(previous?.id);
    const live = liveById.get(sequenceId);
    if (!sequenceId || targetIds.has(sequenceId) || !live) continue;
    // The recent window is only a bounded discovery cross-check.  If it is
    // unavailable, do not let that one failed read prune a still-live target
    // (or its last-known-good replies) from the durable catalog.
    retained.push({ ...previous, ...live });
    targetIds.add(sequenceId);
  }
  return retained;
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
  return flattenCampaignInboxRows(
    campaign,
    inboxData,
    recentByGmail,
    shouldExcludeInboxReply,
    linkedOutreachId,
  );
}

export function flattenCampaignInboxForSubmissions(campaign, inboxData, recentByGmail = new Map()) {
  return flattenCampaignInboxRows(
    campaign,
    inboxData,
    recentByGmail,
    shouldExcludeSubmissionsInboxReply,
    exactCampaignRoleId,
  );
}

function flattenCampaignInboxRows(campaign, inboxData, recentByGmail, excluded, roleIdForCampaign) {
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

    const candidateUserId = stringValue(
        lead?.cu_id
        || lead?.candidate_user_id
        || lead?.candidateUserId
        || lead?.candidate_user?.id,
      );
    const roleId = roleIdForCampaign(campaign);
    const row = {
      ...(candidateUserId ? { candidate_user_id: candidateUserId } : {}),
      ...(roleId ? { role_id: roleId } : {}),
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
    if (!excluded(row, addresses)) rows.push(row);
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
  const candidateUserId = stringValue(
      recent?.cu_id
      || recent?.candidate_user_id
      || recent?.candidateUserId
      || recent?.candidate_user?.id,
    );
  const roleId = linkedOutreachId(campaign);
  return {
    ...(candidateUserId ? { candidate_user_id: candidateUserId } : {}),
    ...(roleId ? { role_id: roleId } : {}),
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
  const exactRoleId = cachedExactCampaignRoleId(campaign);
  const exactProjectId = cachedExactCampaignProjectId(campaign);
  const legacyLinkedOutreachId = linkedOutreachId(campaign);
  return {
    id: stringValue(campaign?.id),
    name: stringValue(campaign?.name) || "Untitled sequence",
    kind: stringValue(campaign?.kind || campaign?.recipient_kind),
    can_reply: Boolean(campaign?.can_reply),
    email_replies: Number.isFinite(emailReplies) ? emailReplies : null,
    linked_outreach_id: legacyLinkedOutreachId || null,
    ui_admitted: typeof campaign?.ui_admitted === "boolean"
      ? campaign.ui_admitted
      : isAdmittedInboxCampaign(campaign),
    exact_role_id: exactRoleId || null,
    exact_role_source: exactRoleId ? "campaign.role_id" : null,
    // Kept only in the Submissions cache contract. Legacy Inbox rows continue
    // to use linked_outreach_id and retain their existing public shape.
    exact_project_id: exactProjectId || null,
    exact_project_source: exactProjectId ? "campaign.project_id" : null,
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

function normalizeReplyMetrics(value) {
  if (!value || typeof value !== "object") return null;
  const replies = Number(value.replies_count);
  const interested = Number(value.interested_replies);
  if (!Number.isFinite(replies) || !Number.isFinite(interested)) return null;
  return { replies_count: replies, interested_replies: interested };
}

function sameReplyMetrics(a, b) {
  const left = normalizeReplyMetrics(a);
  const right = normalizeReplyMetrics(b);
  return Boolean(left && right
    && left.replies_count === right.replies_count
    && left.interested_replies === right.interested_replies);
}

// Every inbound email id a read saw, including bounces and David's mailbox
// rows that the display excludes, so the recent-window check never depends on
// a sender-set date and never loops on an excluded row.
function inboundGmailIds(inboxData) {
  const ids = new Set();
  for (const campaignEmail of arrayValue(inboxData?.campaign_emails)) {
    const email = campaignEmail?.email;
    if (!email || email.sent_from_paraform !== false) continue;
    const gmailId = stringValue(email.gmail_id);
    if (gmailId) ids.add(gmailId);
  }
  return [...ids].sort();
}

function normalizeSeenGmailIds(value) {
  if (!Array.isArray(value)) return null;
  return value.map(stringValue).filter(Boolean);
}

function createSequenceSnapshot(campaign, inboxData, recentByGmail, refreshedAt, replyMetrics = null) {
  const campaignId = stringValue(campaign?.id);
  const exactRoleId = exactCampaignRoleId(campaign);
  const exactProjectId = stringValue(campaign?.project_id);
  const recentLeadIds = new Set(
    [...recentByGmail.values()]
      .filter((reply) => stringValue(reply?.sequence_id) === campaignId)
      .map((reply) => stringValue(reply?.id))
      .filter(Boolean),
  );
  return {
    version: 3,
    submissions_projection_version: INBOX_SUBMISSIONS_PROJECTION_VERSION,
    sequence_id: campaignId,
    sequence_name: stringValue(campaign?.name) || "Untitled sequence",
    email_replies: Number.isFinite(Number(campaign?.email_replies))
      ? Number(campaign.email_replies)
      : null,
    exact_role_id: exactRoleId || null,
    exact_role_source: exactRoleId ? "campaign.role_id" : null,
    exact_project_id: exactProjectId || null,
    exact_project_source: exactProjectId ? "campaign.project_id" : null,
    refreshed_at: refreshedAt,
    // Paraform's per-sequence counts at read time: the baseline the next
    // scheduled run compares against. Null when this read had no counts.
    reply_metrics: normalizeReplyMetrics(replyMetrics),
    seen_gmail_ids: inboundGmailIds(inboxData),
    replies: isAdmittedInboxCampaign(campaign)
      ? flattenCampaignInbox(campaign, inboxData, recentByGmail)
      : [],
    submissions_replies: flattenCampaignInboxForSubmissions(
      campaign,
      inboxData,
      recentByGmail,
    ),
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
    forceRefreshAfterMs = 0,
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
    if (forceRefreshAfterMs > 0) {
      if (snapshot && snapshotTime(snapshot) >= forceRefreshAfterMs) continue;
      const lastAttempt = Date.parse(attempts[id] || "");
      eligible.push({
        campaign,
        priority: snapshot ? 1 : 0,
        attemptedAt: Number.isFinite(lastAttempt) ? lastAttempt : 0,
        snapshotAt: snapshotTime(snapshot),
      });
      continue;
    }
    const currentCount = Number(campaign?.email_replies);
    const storedCount = Number(snapshot?.email_replies);
    const countChanged = snapshot
      && Number.isFinite(currentCount)
      && (!Number.isFinite(storedCount) || currentCount !== storedCount);
    const projectionUnseeded = snapshot
      && snapshot.submissions_projection_version !== INBOX_SUBMISSIONS_PROJECTION_VERSION;
    const recent = recentSequenceIds.has(id);
    const stale = snapshot && nowMs - snapshotTime(snapshot) >= staleMs;
    let priority;
    if (!snapshot) priority = 0;
    // A legacy UI snapshot cannot feed Submissions safely. Upgrade it before
    // mutable reply-count/recent work so a busy catalog cannot starve the
    // projection-version migration indefinitely.
    else if (projectionUnseeded) priority = 1;
    else if (countChanged) priority = 2;
    else if (recent) priority = 3;
    else if (stale) priority = 4;
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

// Newest reply received no later than `notAfterMs`. A row dated after the
// read (a skewed sender clock) is ignored so it cannot hold a sequence in the
// settle rule on every run until that date passes.
function newestReplyTime(snapshot, notAfterMs = Infinity) {
  let newest = 0;
  for (const row of [...arrayValue(snapshot?.replies), ...arrayValue(snapshot?.submissions_replies)]) {
    const at = rowDate(row);
    if (at <= notAfterMs) newest = Math.max(newest, at);
  }
  return newest;
}

function displayedGmailIds(snapshot) {
  return new Set(
    [...arrayValue(snapshot?.replies), ...arrayValue(snapshot?.submissions_replies)]
      .map((row) => stringValue(row?.gmail_id))
      .filter(Boolean),
  );
}

// A recent-window email the snapshot's read did not see. Snapshots written
// before seen_gmail_ids existed fall back to their displayed rows plus a
// date check, so an excluded row cannot trigger a read on every run.
function snapshotMissesRecentEmail(snapshot, reply) {
  const gmailId = stringValue(reply?.gmail_id);
  if (!gmailId) return false;
  if (Array.isArray(snapshot?.seen_gmail_ids)) {
    return !snapshot.seen_gmail_ids.includes(gmailId);
  }
  return !displayedGmailIds(snapshot).has(gmailId)
    && recentReplyTime(reply) > snapshotTime(snapshot) - RECENT_CLOCK_SKEW_MS;
}

function hasStoredReplies(snapshot) {
  return arrayValue(snapshot?.seen_gmail_ids).length > 0
    || arrayValue(snapshot?.replies).length > 0
    || arrayValue(snapshot?.submissions_replies).length > 0;
}

function recentReplyTime(reply) {
  const parsed = Date.parse(reply?.email_date || reply?.date || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Per-sequence reply counts for every target, ten ids per call (Paraform's
 * limit). A failed batch leaves its ids out of the map; they are handled as
 * "unmetered" by the selection below rather than failing the run.
 */
export async function readInboxReplyMetrics(
  targets,
  call,
  { concurrency = INBOX_FANOUT_CONCURRENCY, batchSize = INBOX_METRICS_BATCH_SIZE } = {},
) {
  const byAudience = new Map();
  for (const campaign of arrayValue(targets)) {
    const id = stringValue(campaign?.id);
    if (!id) continue;
    const audience = campaignInboxInput(campaign).audience || "";
    if (!byAudience.has(audience)) byAudience.set(audience, []);
    byAudience.get(audience).push(id);
  }
  const batches = [];
  for (const [audience, ids] of byAudience) {
    for (let index = 0; index < ids.length; index += batchSize) {
      batches.push({ audience, ids: ids.slice(index, index + batchSize) });
    }
  }
  const metrics = new Map();
  let failedBatches = 0;
  await mapWithConcurrency(batches, concurrency, async ({ audience, ids }) => {
    try {
      const data = await call(
        "campaigns.getMetricsForSequences",
        audience ? { campaign_ids: ids, audience } : { campaign_ids: ids },
      );
      for (const id of ids) {
        const value = normalizeReplyMetrics(data?.[id]);
        if (value) metrics.set(id, value);
      }
    } catch {
      failedBatches += 1;
    }
  });
  return { metrics, batches: batches.length, failed_batches: failedBatches };
}

/**
 * Change-driven selection for scheduled runs. Returns the sequences to read
 * (most urgent first) and why, plus the targets that could not be confirmed.
 * Reasons, in order: missing snapshot, legacy projection, counts changed or
 * no baseline yet, a recent-window email the snapshot does not have, a
 * post-read settle check, the saturated-window fallback, unmetered and old,
 * then a small rotation of the longest-unread snapshots.
 */
export function selectChangedInboxCampaigns(
  campaigns,
  previousState,
  recentRepliesRaw,
  metricsById,
  {
    nowMs = Date.now(),
    batchSize = INBOX_CHANGED_BATCH_SIZE,
    rotation = INBOX_ROTATION_PER_RUN,
    recentAvailable = true,
  } = {},
) {
  const snapshots = previousState?.snapshots instanceof Map
    ? previousState.snapshots
    : new Map();
  const metrics = metricsById instanceof Map ? metricsById : new Map();
  const recentRaw = arrayValue(recentRepliesRaw);
  const retry = new Set(arrayValue(previousState?.meta?.retry_sequence_ids).map(stringValue));
  // recent_watermark: the start of the last run whose recent window was read.
  // Every email since then is in this window unless even its oldest item is
  // newer than the watermark.
  const watermarkMs = Date.parse(previousState?.meta?.recent_watermark || "");
  const recentTimes = recentRaw.map(recentReplyTime).filter((value) => value > 0);
  const oldestRecentMs = recentTimes.length ? Math.min(...recentTimes) : Infinity;
  // A failed recent read holds the watermark, so the next successful window
  // still covers everything since; only when the window has been unreadable
  // for the whole stale period does every replied sequence get re-read.
  const windowSaturated = !Number.isFinite(watermarkMs)
    || (recentAvailable
      ? recentRaw.length >= RECENT_WINDOW_TRUNCATED_AT && oldestRecentMs > watermarkMs
      : nowMs - watermarkMs >= INBOX_SCHEDULED_STALE_MS);
  const recentBySequence = new Map();
  for (const reply of recentRaw) {
    const id = stringValue(reply?.sequence_id);
    if (!id) continue;
    if (!recentBySequence.has(id)) recentBySequence.set(id, []);
    recentBySequence.get(id).push(reply);
  }

  const chosen = [];
  const rotationPool = [];
  for (const campaign of arrayValue(campaigns)) {
    const id = stringValue(campaign?.id);
    if (!id) continue;
    const snapshot = snapshots.get(id);
    const refreshedMs = snapshotTime(snapshot);
    const current = metrics.get(id) || null;
    let reason = null;
    if (!snapshot) reason = "missing";
    else if (snapshot.submissions_projection_version !== INBOX_SUBMISSIONS_PROJECTION_VERSION) {
      reason = "projection";
    } else if (current && !sameReplyMetrics(current, snapshot.reply_metrics)) {
      reason = snapshot.reply_metrics ? "counts_changed" : "no_baseline";
    } else if (retry.has(id)) {
      // Selected last run but not read (failed or cut off by the deadline).
      reason = "retry";
    } else if ((recentBySequence.get(id) || []).some((reply) => (
      snapshotMissesRecentEmail(snapshot, reply)
    ))) {
      reason = "recent_email";
    } else {
      const newest = newestReplyTime(snapshot, refreshedMs);
      if (newest > 0 && refreshedMs - newest < INBOX_SETTLE_MS && nowMs - refreshedMs >= INBOX_SETTLE_MS) {
        reason = "settle";
      } else if (windowSaturated && hasStoredReplies(snapshot)) {
        reason = "window_saturated";
      } else if (!current && nowMs - refreshedMs >= INBOX_UNMETERED_READ_AFTER_MS) {
        reason = "unmetered";
      }
    }
    if (reason) chosen.push({ campaign, reason, refreshedMs });
    else if (snapshot) rotationPool.push({ campaign, reason: "rotation", refreshedMs });
  }
  const order = [
    "missing", "projection", "counts_changed", "no_baseline", "retry",
    "recent_email", "settle", "window_saturated", "unmetered",
  ];
  chosen.sort((a, b) => (
    order.indexOf(a.reason) - order.indexOf(b.reason)
    || a.refreshedMs - b.refreshedMs
    || stringValue(a.campaign?.id).localeCompare(stringValue(b.campaign?.id))
  ));
  rotationPool.sort((a, b) => (
    a.refreshedMs - b.refreshedMs
    || stringValue(a.campaign?.id).localeCompare(stringValue(b.campaign?.id))
  ));
  const limit = Math.max(0, Math.floor(Number(batchSize) || 0));
  const needed = chosen.slice(0, limit);
  const deferred = chosen.slice(limit);
  const extra = rotationPool.slice(0, Math.max(0, Math.min(rotation, limit - needed.length)));
  const selected = [...needed, ...extra];
  const reasons = {};
  for (const item of selected) reasons[item.reason] = (reasons[item.reason] || 0) + 1;
  const unmetered = arrayValue(campaigns)
    .map((campaign) => stringValue(campaign?.id))
    .filter((id) => id && !metrics.has(id));
  return {
    selected: selected.map((item) => item.campaign),
    reasons,
    window_saturated: windowSaturated,
    deferred_sequence_ids: deferred.map((item) => stringValue(item.campaign?.id)),
    unmetered_sequence_ids: unmetered,
  };
}

export async function buildInboxRefresh({
  get = inboxTrpcGet,
  concurrency = INBOX_FANOUT_CONCURRENCY,
  now = () => new Date(),
  budgetMs = INBOX_BUILD_BUDGET_MS,
  batchSize = INBOX_SYNC_BATCH_SIZE,
  forceRefreshAfterMs = 0,
  previousState = emptyInboxSnapshotState(),
  // "stale" (default): re-read by age, used by manual sweeps and the
  // Submissions broker. "changed": the scheduled, change-driven run.
  mode = "stale",
} = {}) {
  const deadline = Date.now() + Math.max(1_000, budgetMs);
  const startedAt = now().toISOString();
  let providerRequests = 0;
  // Counts HTTP requests to Paraform (retries and session probes included)
  // when `get` is inboxTrpcGet; a custom getter that ignores fetchImpl
  // simply leaves the count at zero.
  const countingFetch = (...args) => {
    providerRequests += 1;
    return fetch(...args);
  };
  const call = (procedure, input, tries = 2, timeoutCapMs = INBOX_VENDOR_TIMEOUT_MS) => {
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
      Math.min(timeoutCapMs, Math.max(250, remaining)),
      countingFetch,
    );
  };
  const [campaignResult, recentResult] = await Promise.allSettled([
    call("campaigns.getListOfCampaignsOptimized", {}),
    call("campaigns.getRecentReplies", undefined, 2, INBOX_RECENT_TIMEOUT_MS),
  ]);
  if (campaignResult.status === "rejected") throw campaignResult.reason;
  const campaignsRaw = campaignResult.value;
  const campaigns = arrayValue(campaignsRaw);
  const recentError = recentResult.status === "rejected"
    ? recentResult.reason
    : null;
  const recentRepliesRaw = recentResult.status === "fulfilled"
    ? arrayValue(recentResult.value)
    : [];
  const currentTargets = campaignsToScan(campaigns, recentRepliesRaw);
  const targets = recentError
    ? retainPreviousTargetsWhenRecentFails(campaigns, currentTargets, previousState)
    : currentTargets;
  const uiTargets = targets.filter(isAdmittedInboxCampaign);
  const targetIds = new Set(
    targets.map((campaign) => stringValue(campaign?.id)).filter(Boolean),
  );
  const recentReplies = recentRepliesRaw.filter((reply) => (
    targetIds.has(stringValue(reply?.sequence_id))
  ));
  const uiTargetIds = new Set(
    uiTargets.map((campaign) => stringValue(campaign?.id)).filter(Boolean),
  );
  const uiRecentReplies = recentRepliesRaw.filter((reply) => (
    uiTargetIds.has(stringValue(reply?.sequence_id))
  ));
  const recentByGmail = new Map(
    recentReplies
      .filter((item) => stringValue(item?.gmail_id))
      .map((item) => [String(item.gmail_id), item]),
  );
  let selected;
  let changed = null;
  let metricsRead = null;
  if (mode === "changed") {
    metricsRead = await readInboxReplyMetrics(targets, call);
    changed = selectChangedInboxCampaigns(targets, previousState, recentRepliesRaw, metricsRead.metrics, {
      nowMs: Date.now(),
      batchSize,
      recentAvailable: !recentError,
    });
    selected = changed.selected;
  } else {
    selected = selectInboxCampaigns(targets, previousState, recentReplies, {
      nowMs: Date.now(),
      batchSize,
      forceRefreshAfterMs,
    });
  }

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
  const selectedUiIds = new Set(selected
    .filter(isAdmittedInboxCampaign)
    .map((campaign) => stringValue(campaign?.id)));
  const uiFailures = failures.filter((result) => (
    selectedUiIds.has(stringValue(result.campaign?.id))
  ));
  const generatedAt = now().toISOString();
  return {
    generated_at: generatedAt,
    catalog: {
      version: 3,
      submissions_projection_version: INBOX_SUBMISSIONS_PROJECTION_VERSION,
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
        // A read without counts keeps the previous baseline: an old baseline
        // can only cause one extra read later, never a missed one.
        metricsRead?.metrics.get(stringValue(result.campaign?.id))
          || previousState?.snapshots?.get?.(stringValue(result.campaign?.id))?.reply_metrics
          || null,
      )),
    recent: recentError
      ? null
      : {
          version: 3,
          refreshed_at: generatedAt,
          replies: recentReplies,
        },
    // Only a change-driven run can vouch for sequences it did not read: their
    // counts matched the stored baseline at `at`.
    verification: changed
      ? {
          at: startedAt,
          unverified_sequence_ids: [...new Set([
            ...failures.map((item) => stringValue(item.campaign?.id)),
            ...changed.deferred_sequence_ids,
            ...changed.unmetered_sequence_ids.filter((id) => (
              !results.some((result) => result.ok && stringValue(result.campaign?.id) === id)
            )),
          ])].filter(Boolean),
          // Selected but not read: read first next run, whatever the counts say.
          retry_sequence_ids: [...new Set([
            ...failures.map((item) => stringValue(item.campaign?.id)),
            ...changed.deferred_sequence_ids,
          ])].filter(Boolean),
          // Every email up to the start of this run is now either read or
          // queued for retry, provided the recent window itself was read.
          recent_watermark: recentError ? null : startedAt,
        }
      : null,
    scan: {
      mode: mode === "changed" ? "changed" : "stale",
      provider_requests: providerRequests,
      selection_reasons: changed ? changed.reasons : null,
      window_saturated: changed ? changed.window_saturated : null,
      metrics_batches: metricsRead ? metricsRead.batches : null,
      metrics_failed_batches: metricsRead ? metricsRead.failed_batches : null,
      unmetered: changed ? changed.unmetered_sequence_ids.length : null,
      recent_window_size: recentError ? null : recentRepliesRaw.length,
      campaigns_total: campaigns.length,
      campaigns_excluded: Math.max(0, campaigns.length - targets.length),
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
      ui: {
        campaigns_attempted: selectedUiIds.size,
        campaigns_deferred: Math.max(0, uiTargets.length - selectedUiIds.size),
        campaigns_succeeded: selectedUiIds.size - uiFailures.length,
        campaigns_failed: uiFailures.length,
        recent_count: uiRecentReplies.length,
        recent_excluded: recentRepliesRaw.length - uiRecentReplies.length,
        failures: uiFailures.map((item) => ({
          sequence_id: stringValue(item.campaign?.id),
          sequence_name: stringValue(item.campaign?.name) || "Untitled sequence",
          error: stringValue(item.error) || "read_failed",
        })),
      },
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
  const uiScan = refresh.scan.ui || refresh.scan;
  const partial = uiScan.campaigns_failed > 0
    || refresh.scan.recent_failed;
  return {
    generated_at: refresh.generated_at,
    partial,
    cacheable: !partial,
    replies: materialized.replies,
    counts: materialized.counts,
    scan: {
      campaigns_total: refresh.scan.campaigns_total,
      campaigns_excluded: Math.max(
        0,
        refresh.scan.campaigns_total
          - (refresh.catalog.targets.filter((campaign) => campaign.ui_admitted !== false).length),
      ),
      campaigns_attempted: uiScan.campaigns_attempted,
      campaigns_succeeded: uiScan.campaigns_succeeded,
      campaigns_failed: uiScan.campaigns_failed,
      recent_count: uiScan.recent_count,
      recent_excluded: uiScan.recent_excluded,
      recent_failed: refresh.scan.recent_failed,
      failures: uiScan.failures,
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
    submissions_projection_version: Number(snapshot.submissions_projection_version)
      === INBOX_SUBMISSIONS_PROJECTION_VERSION
      ? INBOX_SUBMISSIONS_PROJECTION_VERSION
      : null,
    sequence_id: sequenceId,
    sequence_name: stringValue(snapshot.sequence_name) || "Untitled sequence",
    email_replies: Number.isFinite(Number(snapshot.email_replies))
      ? Number(snapshot.email_replies)
      : null,
    exact_role_id: stringValue(snapshot.exact_role_id) || null,
    exact_role_source: snapshot.exact_role_source === "campaign.role_id"
      ? "campaign.role_id"
      : null,
    exact_project_id: stringValue(snapshot.exact_project_id) || null,
    exact_project_source: snapshot.exact_project_source === "campaign.project_id"
      ? "campaign.project_id"
      : null,
    refreshed_at: stringValue(snapshot.refreshed_at),
    reply_metrics: normalizeReplyMetrics(snapshot.reply_metrics),
    seen_gmail_ids: normalizeSeenGmailIds(snapshot.seen_gmail_ids),
    replies: snapshot.replies.filter((reply) => reply && typeof reply === "object"),
    submissions_replies: arrayValue(snapshot.submissions_replies)
      .filter((reply) => reply && typeof reply === "object"),
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
    return {
      version: 3,
      submissions_projection_version: null,
      refreshed_at: "",
      campaigns_total: 0,
      targets: [],
    };
  }
  if (catalog.version !== 3 || !Array.isArray(catalog.targets)) {
    const error = new Error("invalid persisted Inbox catalog");
    error.code = "INVALID_INBOX_CATALOG";
    throw error;
  }
  return {
    version: 3,
    submissions_projection_version: Number(catalog.submissions_projection_version)
      === INBOX_SUBMISSIONS_PROJECTION_VERSION
      ? INBOX_SUBMISSIONS_PROJECTION_VERSION
      : null,
    refreshed_at: stringValue(catalog.refreshed_at),
    campaigns_total: Math.max(0, Number(catalog.campaigns_total) || 0),
    targets: catalog.targets
      .map((campaign) => publicInboxCampaign({
        ...campaign,
        ui_admitted: typeof campaign?.ui_admitted === "boolean"
          ? campaign.ui_admitted
          : true,
      }))
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

function inboxSnapshotReadError(cause) {
  return { status: "error", cause, value: null };
}

function inboxPipelineCause(error) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") {
    return "pipeline_timeout";
  }
  if (error?.code === "STATE_STORE_RESPONSE_JSON_INVALID") return "pipeline_response_json_invalid";
  if (error?.code === "STATE_STORE_PIPELINE_RESPONSE_SHAPE_INVALID") return "pipeline_response_shape_invalid";
  const command = String(error?.code || "").match(/^STATE_STORE_PIPELINE_COMMAND_([0-3])_(QUOTA_LIMITED|SIZE_LIMITED|AUTH_DENIED|STORAGE_EXHAUSTED|COMMAND_UNSUPPORTED|RESPONSE_INVALID|COMMAND_REJECTED)$/u);
  if (command) return `pipeline_command_${command[1]}_${command[2].toLowerCase()}`;
  const message = String(error?.message || "");
  if (/\bWRONGTYPE\b/iu.test(message)) return "pipeline_wrongtype";
  const status = message.match(/^state store HTTP (\d{3})$/u)?.[1];
  if (status === "401" || status === "403") return "pipeline_http_auth_denied";
  if (status === "413" || status === "414") return "pipeline_http_size_limited";
  if (status === "429") return "pipeline_http_quota_limited";
  if (status) return `pipeline_http_${status}`;
  if (error instanceof TypeError) return "pipeline_network";
  return "pipeline_unavailable";
}

function inboxScanPage(value) {
  if (!Array.isArray(value) || value.length !== 2 || !Array.isArray(value[1])) return null;
  const cursor = String(value[0]);
  if (!/^\d+$/u.test(cursor) || value[1].length % 2 !== 0) return null;
  return { cursor, entries: value[1] };
}

async function readInboxSequenceSnapshots({
  pipelineImpl,
  now,
  scanCount,
  scanMaxPages,
  scanBudgetMs,
}) {
  const startedAt = now();
  const timedOut = () => now() - startedAt >= scanBudgetMs;
  const scan = async (cursor) => {
    if (timedOut()) return { error: "scan_budget_exhausted" };
    let values;
    try {
      values = await pipelineImpl([[
        "HSCAN", INBOX_SEQUENCE_SNAPSHOTS_KEY, cursor, "COUNT", String(scanCount),
      ]]);
    } catch (error) {
      return { error: `scan_${inboxPipelineCause(error)}` };
    }
    if (timedOut()) return { error: "scan_budget_exhausted" };
    if (!Array.isArray(values) || values.length !== 1) return { error: "scan_response_invalid" };
    const page = inboxScanPage(values[0]);
    return page ? { page } : { error: "scan_response_invalid" };
  };

  const entries = [];
  const seen = new Set(["0"]);
  let pages = 0;
  let cursor = "0";
  do {
    if (pages >= scanMaxPages) return { error: "scan_page_limit" };
    if (pages > 0 && seen.has(cursor)) return { error: "scan_cursor_loop" };
    seen.add(cursor);
    const result = await scan(cursor);
    if (result.error) return result;
    entries.push(...result.page.entries);
    cursor = result.page.cursor;
    pages += 1;
  } while (cursor !== "0");
  return { entries };
}

export async function readInboxSnapshotState({
  pipelineImpl = pipeline,
  configured = storeConfigured(),
  now = Date.now,
  scanCount = INBOX_SNAPSHOT_SCAN_COUNT,
  scanMaxPages = INBOX_SNAPSHOT_SCAN_MAX_PAGES,
  scanBudgetMs = INBOX_SNAPSHOT_SCAN_BUDGET_MS,
} = {}) {
  if (!configured) return { status: "unavailable", value: null };
  let values;
  try {
    values = await pipelineImpl([
      ["GET", INBOX_CATALOG_KEY],
      ["GET", INBOX_RECENT_KEY],
      ["GET", INBOX_REFRESH_META_KEY],
    ]);
  } catch (error) { return inboxSnapshotReadError(inboxPipelineCause(error)); }
  if (!Array.isArray(values) || values.length !== 3) {
    return inboxSnapshotReadError("pipeline_response_invalid");
  }
  const scanned = await readInboxSequenceSnapshots({
    pipelineImpl, now, scanCount, scanMaxPages, scanBudgetMs,
  });
  if (scanned.error) return inboxSnapshotReadError(scanned.error);
  let snapshots;
  try { snapshots = parseInboxSequenceSnapshots(scanned.entries); }
  catch { return inboxSnapshotReadError("snapshot_invalid"); }
  let catalog;
  try { catalog = normalizeInboxCatalog(values[0]); }
  catch { return inboxSnapshotReadError("catalog_invalid"); }
  let recent;
  try { recent = normalizeInboxRecent(values[1]); }
  catch { return inboxSnapshotReadError("recent_invalid"); }
  let meta;
  try { meta = normalizeInboxRefreshMeta(values[2]); }
  catch { return inboxSnapshotReadError("refresh_meta_invalid"); }
  return {
    status: "ready",
    cause: null,
    value: { snapshots, catalog, recent, meta },
  };
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
  const uiTargets = new Set(catalog.targets
    .filter((campaign) => campaign.ui_admitted !== false)
    .map((campaign) => campaign.id));
  const uiSeeded = [...uiTargets].filter((sequenceId) => snapshots.has(sequenceId));
  const uiStaleCount = uiSeeded.filter((sequenceId) => (
    currentMs - snapshotTime(snapshots.get(sequenceId)) >= INBOX_SEQUENCE_STALE_MS
  )).length;
  const uiScan = refresh?.scan?.ui || null;
  // Verification: a change-driven run vouches for every target it did not
  // list as unverified. Any other refresh keeps the previous verdict, minus
  // the sequences it has just read successfully.
  const readOk = new Set(arrayValue(refresh?.snapshots)
    .map((snapshot) => stringValue(snapshot?.sequence_id)).filter(Boolean));
  const verification = refresh?.verification && typeof refresh.verification === "object"
    ? refresh.verification
    : null;
  const verifiedAt = verification
    ? stringValue(verification.at)
    : stringValue(previous.meta?.verified_at);
  const unverifiedIds = (verification
    ? arrayValue(verification.unverified_sequence_ids)
    : arrayValue(previous.meta?.unverified_sequence_ids).filter((id) => !readOk.has(id)))
    .map(stringValue)
    .filter((id) => id && targetIds.has(id));
  const retryIds = (verification
    ? arrayValue(verification.retry_sequence_ids)
    : arrayValue(previous.meta?.retry_sequence_ids).filter((id) => !readOk.has(id)))
    .map(stringValue)
    .filter((id) => id && targetIds.has(id));
  const recentWatermark = stringValue(verification?.recent_watermark)
    || stringValue(previous.meta?.recent_watermark);
  const uiFailures = uiScan ? arrayValue(uiScan.failures) : failures
    .filter((failure) => uiTargets.has(stringValue(failure?.sequence_id)));
  const uiCoverageComplete = Boolean(catalog.refreshed_at)
    && uiSeeded.length === uiTargets.size
    && uiFailures.length === 0
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
    ui_last_complete_at: uiCoverageComplete
      ? stringValue(refresh?.generated_at)
      : stringValue(previous.meta?.ui_last_complete_at || previous.meta?.last_complete_at),
    ui_campaigns_targeted: uiTargets.size,
    ui_campaigns_attempted: Number(uiScan?.campaigns_attempted) || 0,
    ui_campaigns_deferred: Number(uiScan?.campaigns_deferred) || 0,
    ui_campaigns_succeeded: Number(uiScan?.campaigns_succeeded) || 0,
    ui_campaigns_failed: uiFailures.length,
    ui_campaigns_seeded: uiSeeded.length,
    ui_campaigns_missing: Math.max(0, uiTargets.size - uiSeeded.length),
    ui_campaigns_stale: uiStaleCount,
    ui_recent_count: Number(uiScan?.recent_count) || 0,
    ui_recent_excluded: Number(uiScan?.recent_excluded) || 0,
    ui_failure_error_counts: failureErrorCounts(uiFailures),
    sequence_attempts: sequenceAttempts,
    verified_at: verifiedAt,
    unverified_sequence_ids: unverifiedIds,
    retry_sequence_ids: retryIds,
    recent_watermark: recentWatermark,
    // The last change-driven (scheduled or Refresh now) run; stale-mode
    // refreshes by the Submissions broker or a paused sweep leave it alone.
    last_run: verification
      ? {
          at: stringValue(refresh?.generated_at),
          mode: "changed",
          provider_requests: Number(refresh?.scan?.provider_requests) || 0,
          sequences_read: arrayValue(refresh?.selected_sequence_ids).length,
          sequences_failed: arrayValue(refresh?.scan?.failures).length,
          selection_reasons: refresh?.scan?.selection_reasons || null,
          window_saturated: refresh?.scan?.window_saturated ?? null,
          metrics_failed_batches: refresh?.scan?.metrics_failed_batches ?? null,
          unmetered: refresh?.scan?.unmetered ?? null,
          recent_window_size: refresh?.scan?.recent_window_size ?? null,
          recent_failed: Boolean(refresh?.scan?.recent_failed),
        }
      : previous.meta?.last_run || null,
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
  const targetIds = new Set(arrayValue(refresh?.target_sequence_ids));
  const snapshotPairs = arrayValue(refresh?.snapshots)
    .map((snapshot) => normalizeSequenceSnapshot(
      snapshot,
      snapshot?.sequence_id,
    ))
    .filter((snapshot) => snapshot && targetIds.has(snapshot.sequence_id))
    .map((snapshot) => [stringValue(snapshot.sequence_id), JSON.stringify(snapshot)]);
  // A change-driven run can read every sequence at once (first run, a
  // saturated window), far more than fits one KV request. Snapshots go in
  // byte-bounded HSET chunks; the last chunk rides with the catalog, recent
  // window and metadata, so a write that fits one request is unchanged and
  // the metadata is always written last. A failed chunk throws before the
  // metadata moves; the chunks already written are correct, complete reads.
  const chunks = [];
  let chunk = [];
  let chunkBytes = 0;
  for (const [sequenceId, serialized] of snapshotPairs) {
    const bytes = sequenceId.length + serialized.length;
    if (chunk.length && chunkBytes + bytes > INBOX_SNAPSHOT_WRITE_CHUNK_BYTES) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    }
    chunk.push(sequenceId, serialized);
    chunkBytes += bytes;
  }
  if (chunk.length) chunks.push(chunk);
  for (const earlier of chunks.slice(0, -1)) {
    await pipelineImpl([["HSET", INBOX_SEQUENCE_SNAPSHOTS_KEY, ...earlier]]);
  }
  const commands = [];
  if (chunks.length) {
    commands.push(["HSET", INBOX_SEQUENCE_SNAPSHOTS_KEY, ...chunks[chunks.length - 1]]);
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
  const uiTargets = targets.filter((campaign) => campaign?.ui_admitted !== false);
  const targetIds = new Set(uiTargets.map((campaign) => stringValue(campaign?.id)));
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
    uiTargets,
    categoryByLead,
  );
  const currentMs = now().getTime();
  const seededCount = [...targetIds]
    .filter((sequenceId) => snapshotState.snapshots?.has(sequenceId)).length;
  // The Inbox refreshes on a schedule, so a sequence is stale only when
  // neither its last read nor the last verified run (whose counts matched it)
  // is within the scheduled window. Submissions keeps its own 15-minute rule
  // in inboxSubmissionsProjectionCoverage.
  const verifiedMs = Date.parse(snapshotState.meta?.verified_at || "");
  const unverified = new Set(arrayValue(snapshotState.meta?.unverified_sequence_ids));
  const staleCount = [...targetIds].filter((sequenceId) => {
    const snapshot = snapshotState.snapshots?.get(sequenceId);
    if (!snapshot) return false;
    const confirmedMs = Math.max(
      snapshotTime(snapshot),
      !unverified.has(sequenceId) && Number.isFinite(verifiedMs) ? verifiedMs : 0,
    );
    return currentMs - confirmedMs >= INBOX_SCHEDULED_STALE_MS;
  }).length;
  const catalogReady = Boolean(snapshotState.catalog?.refreshed_at);
  const missingCount = Math.max(0, targetIds.size - seededCount);
  const latestFailures = Number(
    snapshotState.meta?.ui_campaigns_failed
      ?? snapshotState.meta?.campaigns_failed,
  ) || 0;
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
      last_complete_at: stringValue(
        snapshotState.meta?.ui_last_complete_at
        || snapshotState.meta?.last_complete_at,
      ),
      campaigns_targeted: targetIds.size,
      campaigns_seeded: seededCount,
      campaigns_missing: missingCount,
      campaigns_stale: staleCount,
      latest_failures: latestFailures,
      verified_at: stringValue(snapshotState.meta?.verified_at),
      campaigns_unverified: [...targetIds].filter((id) => unverified.has(id)).length,
    },
    scan: {
      campaigns_total: Number(snapshotState.catalog?.campaigns_total) || 0,
      campaigns_targeted: targetIds.size,
      campaigns_attempted: Number(
        snapshotState.meta?.ui_campaigns_attempted
          ?? snapshotState.meta?.campaigns_attempted,
      ) || 0,
      campaigns_deferred: Number(
        snapshotState.meta?.ui_campaigns_deferred
          ?? snapshotState.meta?.campaigns_deferred,
      ) || 0,
      campaigns_succeeded: Number(
        snapshotState.meta?.ui_campaigns_succeeded
          ?? snapshotState.meta?.campaigns_succeeded,
      ) || 0,
      campaigns_failed: latestFailures,
      campaigns_seeded: seededCount,
      campaigns_missing: missingCount,
      campaigns_stale: staleCount,
      recent_count: Number(
        snapshotState.meta?.ui_recent_count
          ?? snapshotState.recent?.replies?.length,
      ) || 0,
      recent_excluded: Number(
        snapshotState.meta?.ui_recent_excluded
          ?? snapshotState.meta?.recent_excluded,
      ) || 0,
      recent_failed: Boolean(snapshotState.meta?.recent_failed),
      failure_error_counts: snapshotState.meta?.ui_failure_error_counts
        || snapshotState.meta?.failure_error_counts
        || {},
    },
  };
}

/** Coverage for the Submissions-only projection across every cached target. */
export function inboxSubmissionsProjectionCoverage(
  state,
  { now = () => new Date() } = {},
) {
  const snapshotState = state || emptyInboxSnapshotState();
  const targetIds = new Set(arrayValue(snapshotState.catalog?.targets)
    .map((campaign) => stringValue(campaign?.id)).filter(Boolean));
  const currentMs = now().getTime();
  const snapshots = snapshotState.snapshots || new Map();
  const seededIds = [...targetIds].filter((sequenceId) => snapshots.has(sequenceId));
  const staleCount = seededIds.filter((sequenceId) => (
    currentMs - snapshotTime(snapshots.get(sequenceId)) >= INBOX_SEQUENCE_STALE_MS
  )).length;
  const refreshedTimes = seededIds
    .map((sequenceId) => snapshotTime(snapshots.get(sequenceId)))
    .filter((value) => value > 0);
  const catalogReady = Boolean(snapshotState.catalog?.refreshed_at);
  const missingCount = Math.max(0, targetIds.size - seededIds.length);
  const latestFailures = Number(snapshotState.meta?.campaigns_failed) || 0;
  // A cursor is valid only for this exact target set and immutable role
  // evidence.  Do not let a newly discovered sequence inherit a cursor that
  // could be later than one of its historical replies.
  const catalogDigest = createHash("sha256").update(JSON.stringify(
    [...targetIds].sort().map((sequenceId) => {
      const campaign = arrayValue(snapshotState.catalog?.targets)
        .find((item) => stringValue(item?.id) === sequenceId) || {};
      return [
        sequenceId,
        stringValue(campaign.exact_role_id),
        stringValue(campaign.exact_role_source),
        stringValue(campaign.exact_project_id),
        stringValue(campaign.exact_project_source),
      ];
    }),
  )).digest("hex");
  return {
    state: !catalogReady
      ? "unseeded"
      : missingCount > 0
        ? "seeding"
        : latestFailures > 0 || staleCount > 0
          ? "degraded"
          : "ready",
    coverage_complete: catalogReady && targetIds.size > 0 && missingCount === 0,
    last_refresh_at: stringValue(snapshotState.meta?.last_refresh_at),
    last_complete_at: stringValue(snapshotState.meta?.last_complete_at),
    confirmed_through: targetIds.size > 0 && refreshedTimes.length === targetIds.size
      ? new Date(Math.min(...refreshedTimes)).toISOString()
      : null,
    campaigns_targeted: targetIds.size,
    campaigns_seeded: seededIds.length,
    campaigns_missing: missingCount,
    campaigns_stale: staleCount,
    latest_failures: latestFailures,
    catalog_digest: catalogDigest,
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
    // Preserve provider direction as tri-state. A missing value must never be
    // converted into a candidate-authored (`false`) message downstream.
    sent_from_paraform: typeof info.sent_from_paraform === "boolean"
      ? info.sent_from_paraform
      : null,
    attachment_count: attachments.length,
  };
}
