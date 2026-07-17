// Read-only cross-sequence reply inbox. Paraform remains the source of truth;
// this module only assembles and briefly caches a normalized feed for the
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
  storeConfigured,
} from "../../sourcing/_lib/store.mjs";

export { authConfig, cors, hasCookie, paraformHealth, storeConfigured };

export const INBOX_CACHE_KEY = "inbox:v1:feed";
export const INBOX_BUILD_LOCK_KEY = "inbox:v1:feed:lock";
export const INBOX_CACHE_TTL_SECONDS = 90;
export const INBOX_FANOUT_CONCURRENCY = 6;
export const INBOX_VENDOR_TIMEOUT_MS = 6_000;
export const INBOX_BUILD_BUDGET_MS = 80_000;

const stringValue = (value) => (
  typeof value === "string" ? value.trim() : ""
);

const arrayValue = (value) => (Array.isArray(value) ? value : []);

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
  _tries = 1,
  timeoutMs = INBOX_VENDOR_TIMEOUT_MS,
) {
  const input = {
    json,
    meta: { values: {}, v: 1 },
  };
  const url = `${BASE}/trpc/${procedure}?input=`
    + encodeURIComponent(JSON.stringify(input));
  const response = await fetch(url, {
    headers: headers(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 401) {
    const error = new Error("AUTH_EXPIRED");
    error.code = "AUTH_EXPIRED";
    throw error;
  }
  const body = await response.json();
  if (!response.ok || body?.error) {
    throw new Error(
      body?.error?.json?.message || `Paraform HTTP ${response.status}`,
    );
  }
  return body?.result?.data?.json;
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

export function campaignsToScan(campaigns) {
  const valid = arrayValue(campaigns).filter((campaign) => stringValue(campaign?.id));
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

    rows.push({
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
    });
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
    const key = rowKey(row);
    if (key) merged.set(key, row);
  }
  for (const recent of arrayValue(recentReplies)) {
    const row = recentFallbackRow(recent, campaignById, categoryByLead);
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

export async function buildInboxFeed({
  get = inboxTrpcGet,
  concurrency = INBOX_FANOUT_CONCURRENCY,
  now = () => new Date(),
  budgetMs = INBOX_BUILD_BUDGET_MS,
} = {}) {
  const deadline = Date.now() + Math.max(1_000, budgetMs);
  const call = (procedure, input) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const error = new Error("INBOX_BUILD_DEADLINE");
      error.code = "INBOX_BUILD_DEADLINE";
      throw error;
    }
    return get(
      procedure,
      input,
      1,
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
  const targets = campaignsToScan(campaigns);

  const recentError = recentResult.status === "rejected"
    ? recentResult.reason
    : null;
  const recentReplies = recentResult.status === "fulfilled"
    ? arrayValue(recentResult.value)
    : [];
  const recentByGmail = new Map(
    recentReplies
      .filter((item) => stringValue(item?.gmail_id))
      .map((item) => [String(item.gmail_id), item]),
  );

  const results = await mapWithConcurrency(targets, concurrency, async (campaign) => {
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
  const categoryByLead = new Map();
  const rows = [];
  for (const result of results.filter((item) => item.ok)) {
    for (const lead of arrayValue(result.data?.campaign_to_candidate_users)) {
      categoryByLead.set(
        `${result.campaign.id}:${lead?.id || ""}`,
        {
          reply_category: lead?.reply_category,
          tracking_status: lead?.tracking_status,
          is_archived: lead?.is_archived,
        },
      );
    }
    rows.push(...flattenCampaignInbox(result.campaign, result.data, recentByGmail));
  }

  const replies = mergeAndSortReplies(
    rows,
    recentReplies,
    campaigns,
    categoryByLead,
  );
  const partial = failures.length > 0 || Boolean(recentError);
  const generatedAt = now().toISOString();
  return {
    generated_at: generatedAt,
    partial,
    cacheable: !partial,
    replies,
    counts: {
      total: replies.length,
      interested: replies.filter((item) => (
        !item.is_archived && item.reply_category === "INTERESTED"
      )).length,
      needs_review: replies.filter((item) => (
        !item.is_archived && item.reply_category === "UNCLEAR"
      )).length,
      not_interested: replies.filter((item) => (
        !item.is_archived && item.reply_category === "NOT_INTERESTED"
      )).length,
      archived: replies.filter((item) => item.is_archived).length,
    },
    scan: {
      campaigns_total: campaigns.length,
      campaigns_attempted: targets.length,
      campaigns_succeeded: targets.length - failures.length,
      campaigns_failed: failures.length,
      recent_count: recentReplies.length,
      recent_failed: Boolean(recentError),
      failures: failures.map((item) => ({
        sequence_id: stringValue(item.campaign?.id),
        sequence_name: stringValue(item.campaign?.name) || "Untitled sequence",
        error: stringValue(item.error) || "read_failed",
      })),
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

export async function readInboxCache() {
  if (!storeConfigured()) return { status: "unavailable", value: null };
  try {
    const value = parseJson(await kv(["GET", INBOX_CACHE_KEY]));
    return { status: value ? "hit" : "miss", value };
  } catch {
    return { status: "error", value: null };
  }
}

export async function writeInboxCache(feed) {
  if (!storeConfigured() || !feed?.cacheable) return false;
  await kv([
    "SET",
    INBOX_CACHE_KEY,
    JSON.stringify(feed),
    "EX",
    INBOX_CACHE_TTL_SECONDS,
  ]);
  return true;
}

export async function acquireInboxBuildLock() {
  if (!storeConfigured()) {
    return { status: "unavailable", token: null };
  }
  const token = randomUUID();
  try {
    const result = await kv([
      "SET",
      INBOX_BUILD_LOCK_KEY,
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

export async function releaseInboxBuildLock(token) {
  if (!token || !storeConfigured()) return false;
  const script = `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      return redis.call('DEL', KEYS[1])
    end
    return 0
  `;
  try {
    return Number(await kv([
      "EVAL",
      script,
      1,
      INBOX_BUILD_LOCK_KEY,
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
