// Paraform sending-mailbox roster for the Health tab's email group.
//
// Paraform sends our sequence email from the primary david@ mailbox plus
// cold-outreach aliases across ten Raydar domains, and
// tracks a per-account gmail_status — some have already sat in ERROR while
// their sequences looked fine from our side. Paraform's roster is inventory
// only; authoritative provider status lives on a full campaign read. This
// endpoint joins those two views, and is the ONLY health endpoint that asks
// Paraform for either one.
//
// Load discipline: one bounded refresh batch per CACHE_FRESH_MS at most (the
// background-load-reduction concern is real). A refresh is the roster, the
// optimized campaign list, and one representative full campaign per owner;
// full reads run at concurrency two and fail closed above the owner guard.
// The KV cache key is owned by this endpoint alone, same single-writer pattern
// as beats and acks.
//
// Auth: HEALTH_BEAT_KEY bearer — the caller is the tick, not a browser, and
// the alias inventory should not be public (harvest bait).
import { timingSafeEqual } from "node:crypto";
import { hGet, hSet } from "./_lib/kv.mjs";
import { hasCookie, trpcGet } from "../seq/_lib/core.mjs";

const CACHE_KEY = "hlth:mailboxes:cache";
const CACHE_FRESH_MS = 25 * 60 * 1000;
const CACHE_TTL_SECONDS = 24 * 3600; // stale-but-present beats absent on a Paraform blip
const CACHE_SCHEMA_VERSION = 2;
const CAMPAIGN_READ_CONCURRENCY = 2;
const CAMPAIGN_OWNER_LIMIT = 12;
const PRIMARY_MAILBOX = "david@raydar.xyz";
const MONITORED_OUTREACH_DOMAINS = new Set([
  "heyraydar.com",
  "raydarcareers.com",
  "raydarmesh.com",
  "runraydar.com",
  "matchraydar.com",
  "raydarflow.com",
  "raydarwork.com",
  "raydarmatch.com",
  "chatraydar.com",
  "echoraydar.com",
]);
const MONITORED_OUTREACH_LOCALS = new Set([
  "david",
  "davidp",
  "david.phillips",
  "noah",
  "kyra",
]);

const normalizeEmail = (value) => String(value || "").trim().toLowerCase();
const normalizeStatus = (value) => String(value || "UNKNOWN").trim().toUpperCase() || "UNKNOWN";

/** The live roster now also contains the separate blocked persona fleet.
 * Keep this tile on the ten-domain sending fleet ratified in the cold-outreach
 * PRD, while discovering new accounts inside those domain/local families. */
export function monitoredParaformRoster(rows) {
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    const email = normalizeEmail(row?.email);
    if (email === PRIMARY_MAILBOX) return true;
    const [local, domain] = email.split("@");
    return MONITORED_OUTREACH_LOCALS.has(local)
      && MONITORED_OUTREACH_DOMAINS.has(domain);
  });
}

function statusPriority(status) {
  if (status === "ERROR") return 4;
  if (status === "ACTIVE") return 2;
  if (status === "UNKNOWN") return 0;
  // A provider-specific non-ACTIVE state must not be hidden by an ACTIVE row
  // from another campaign snapshot of the same account.
  return 3;
}

function preferAccountStatus(current, candidate) {
  if (!current) return candidate;
  return statusPriority(candidate.gmailStatus) > statusPriority(current.gmailStatus)
    ? candidate
    : current;
}

/** Pick one full campaign per Paraform owner. Prefer an enabled campaign, but
 * any campaign works: `campaign.user.accounts` is the owner's current account
 * view, not a historical copy baked into the sequence. */
export function representativeCampaigns(rows) {
  const byOwner = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = String(row?.id || "").trim();
    const owner = normalizeEmail(row?.user?.id || row?.user?.email);
    if (!id || !owner) continue;
    const current = byOwner.get(owner);
    if (!current || (row?.enabled === true && current?.enabled !== true)) {
      byOwner.set(owner, row);
    }
  }
  return [...byOwner.values()];
}

function fullCampaignAccountRows(campaign) {
  const selected = Array.isArray(campaign?.campaign_to_accounts)
    ? campaign.campaign_to_accounts.map((row) => row?.account || row)
    : [];
  const ownerAccounts = Array.isArray(campaign?.user?.accounts)
    ? campaign.user.accounts
    : [];
  return [...ownerAccounts, ...selected];
}

/** Join roster inventory to provider-specific status from full campaigns.
 * `outlook_status: ACTIVE` deliberately never rescues a Gmail row. */
export function deriveCampaignMailboxAccounts(rosterRows, fullCampaigns) {
  const statusByEmail = new Map();
  for (const campaign of Array.isArray(fullCampaigns) ? fullCampaigns : []) {
    for (const row of fullCampaignAccountRows(campaign)) {
      const email = normalizeEmail(row?.email || row?.account?.email);
      if (!email) continue;
      const candidate = {
        email,
        gmailStatus: normalizeStatus(row?.gmail_status || row?.gmailStatus),
        outlookStatus: normalizeStatus(row?.outlook_status || row?.outlookStatus || "") === "UNKNOWN"
          ? null
          : normalizeStatus(row?.outlook_status || row?.outlookStatus),
      };
      statusByEmail.set(email, preferAccountStatus(statusByEmail.get(email), candidate));
    }
  }

  return (Array.isArray(rosterRows) ? rosterRows : [])
    .map((row) => {
      const email = normalizeEmail(row?.email);
      const campaignStatus = statusByEmail.get(email);
      return {
        email,
        gmailStatus: campaignStatus?.gmailStatus || "UNKNOWN",
        outlookStatus: campaignStatus?.outlookStatus || null,
      };
    })
    .filter((row) => row.email);
}

async function mapWithConcurrency(items, limit, fn) {
  const output = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, limit), Math.max(1, items.length)) },
    worker,
  ));
  return output;
}

export async function readParaformMailboxSnapshot({ get = trpcGet } = {}) {
  const rosterRows = (await get("gmail.getActiveUserGmailAccounts", {})) || [];
  const monitoredRows = monitoredParaformRoster(rosterRows);
  const campaigns = (await get("campaigns.getListOfCampaignsOptimized", {})) || [];
  const representatives = representativeCampaigns(campaigns);
  if (representatives.length > CAMPAIGN_OWNER_LIMIT) {
    const error = new Error("PARAFORM_MAILBOX_OWNER_LIMIT_EXCEEDED");
    error.code = "PARAFORM_MAILBOX_OWNER_LIMIT_EXCEEDED";
    throw error;
  }
  const fullCampaigns = await mapWithConcurrency(
    representatives,
    CAMPAIGN_READ_CONCURRENCY,
    (campaign) => get("campaigns.getCampaign", { campaign_id: campaign.id }),
  );
  return {
    version: CACHE_SCHEMA_VERSION,
    accounts: deriveCampaignMailboxAccounts(monitoredRows, fullCampaigns),
    paraformRosterCount: Array.isArray(rosterRows) ? rosterRows.length : 0,
    campaignCount: Array.isArray(campaigns) ? campaigns.length : 0,
    campaignOwnersRead: representatives.length,
  };
}

function authed(req) {
  const secret = process.env.HEALTH_BEAT_KEY || "";
  if (!secret) return false;
  const provided = req.headers?.authorization || "";
  const a = Buffer.from(provided);
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

function summarize(accounts, fetchedAt, source = {}) {
  const gmailActive = accounts.filter((a) => a.gmailStatus === "ACTIVE").length;
  const gmailErrorRows = accounts.filter((a) => a.gmailStatus === "ERROR");
  const david = accounts.find((a) => a.email === PRIMARY_MAILBOX);
  const errorDomains = [...new Set(
    gmailErrorRows.map((a) => String(a.email.split("@")[1] || "")).filter(Boolean),
  )];
  const ageMs = Date.now() - Date.parse(fetchedAt);
  return {
    ok: true,
    paraform: "live",
    fetchedAt,
    cacheAgeMin: Number.isFinite(ageMs) ? Math.max(0, Math.round(ageMs / 60000)) : null,
    counts: {
      total: accounts.length,
      gmailActive,
      gmailError: gmailErrorRows.length,
      other: accounts.length - gmailActive - gmailErrorRows.length,
    },
    statusSource: source.version === CACHE_SCHEMA_VERSION
      ? "full-campaign"
      : "legacy-roster",
    paraformRosterCount: source.paraformRosterCount ?? null,
    campaignCount: source.campaignCount ?? null,
    campaignOwnersRead: source.campaignOwnersRead ?? null,
    davidGmailStatus: david ? david.gmailStatus : "MISSING",
    errorDomains,
    // Full rows for the humans debugging a red tile; the evaluator only
    // lifts the counts. These are our own alias inboxes, not candidate data.
    mailboxes: accounts,
  };
}

export default async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "method" });
  if (!authed(req)) return res.status(401).json({ ok: false, error: "unauthorized" });

  const cached = await hGet(CACHE_KEY);
  const cachedFresh = cached?.version === CACHE_SCHEMA_VERSION
    && cached?.fetchedAt
    && Date.now() - Date.parse(cached.fetchedAt) < CACHE_FRESH_MS
    && Array.isArray(cached.accounts);
  if (cachedFresh) {
    return res.status(200).json(summarize(cached.accounts, cached.fetchedAt, cached));
  }

  if (!hasCookie()) {
    return res.status(200).json({ ok: false, paraform: "no_cookie", error: "no Paraform session configured" });
  }

  let snapshot;
  try {
    snapshot = await readParaformMailboxSnapshot();
  } catch (error) {
    // A dead cookie or throttle must not fabricate a roster verdict. Serve
    // the stale cache when one exists (age is visible to the evaluator);
    // otherwise say plainly that Paraform is unreadable.
    if (cached?.accounts) {
      return res.status(200).json(summarize(cached.accounts, cached.fetchedAt, cached));
    }
    const code = String(error?.code || error?.message || "unavailable").slice(0, 120);
    return res.status(200).json({ ok: false, paraform: "unavailable", error: code });
  }

  const fetchedAt = new Date().toISOString();
  const value = {
    version: CACHE_SCHEMA_VERSION,
    fetchedAt,
    accounts: snapshot.accounts,
    paraformRosterCount: snapshot.paraformRosterCount,
    campaignCount: snapshot.campaignCount,
    campaignOwnersRead: snapshot.campaignOwnersRead,
  };
  try {
    await hSet(CACHE_KEY, value, CACHE_TTL_SECONDS);
  } catch {
    // Cache write failure only costs the next caller a fresh read.
  }
  return res.status(200).json(summarize(snapshot.accounts, fetchedAt, snapshot));
}
