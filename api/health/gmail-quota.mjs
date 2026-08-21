// How much of david@raydar.xyz's daily Gmail allowance is gone, and how long
// the mailbox has been unusable today.
//
// WHY THIS EXISTS: Google publishes no API that reports quota consumption.
// You cannot ask "how many units have I spent?" — the only number obtainable
// from Gmail itself is how many messages are in Sent today, and the only
// witness to a lockout is a lane that already hit one. Everything here is
// built from those two facts and nothing is inferred.
//
// THE PROBE RULE, AND THE ONE EXCEPTION. The Health tab's standing rule is
// never to probe Gmail actively: during a lockout every call re-quotes the
// now+15min penalty, so a monitor polling through an outage would hold the
// lock open — the failure mode documented on 2026-08-10, where nothing on the
// mailbox was ever quiet for 15 minutes so no lane observed the window clear.
//
// This endpoint makes ONE search per CHECK_FRESH_MS, and suppresses it
// entirely whenever a 429 witness is live. That inverts the harm: the probe
// goes silent exactly when the rule cares, and only runs while the mailbox is
// already known-healthy. Cost is 5 quota units per page, one page for any
// realistic day's volume — well under a tenth of a percent of the estate.
//
// SINGLE WRITER: this endpoint owns `hlth:gmailquota:*` and writes nothing
// else. Lockout minutes are READ from `hlth:samples:email-inbox-david`, which
// the tick owns; this file never writes there.
import { timingSafeEqual } from "node:crypto";

import { hGet, hSet } from "./_lib/kv.mjs";
import { delegatedGoogleAccessToken } from "../paraai/_lib/outreach-gmail.mjs";

const MAILBOX = "david@raydar.xyz";
const DAILY_SEND_CAP = 2000;          // Workspace per-user, per-24h
const CHECK_FRESH_MS = 15 * 60 * 1000;
const DAY_TTL_SECONDS = 9 * 24 * 3600; // a week of history plus slack
const PAGE_CAP = 5;                    // 5 x 500 = 2,500, above any real day
const SAMPLE_MINUTES = 2;              // the tick's cadence
const BACKOFF_KEY = "paraai:outreach:gmail-backoff";
const SAMPLES_KEY = "hlth:samples:email-inbox-david";
const dayKey = (day) => `hlth:gmailquota:${day}`;

const GMAIL_LIST = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

function authed(req) {
  const secret = process.env.HEALTH_BEAT_KEY || "";
  if (!secret) return false;
  const a = Buffer.from(String(req.headers?.authorization || ""));
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Calendar day in Pacific time — the boundary Workspace resets sends on. */
export function pacificDay(now = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(now));
}

/** Epoch SECONDS for 00:00 Pacific on the given day — Gmail's `after:` form. */
export function pacificMidnightEpoch(day, now = Date.now()) {
  // Resolve the offset by asking the formatter what UTC time renders as
  // midnight there; this stays correct across the DST changeover, which a
  // fixed -7/-8 would not.
  const guess = Date.parse(`${day}T00:00:00Z`);
  for (const offsetHours of [7, 8]) {
    const candidate = guess + offsetHours * 3600 * 1000;
    if (pacificDay(candidate) === day && pacificDay(candidate - 1000) !== day) {
      return Math.floor(candidate / 1000);
    }
  }
  return Math.floor(guess / 1000);
}

const futureIso = (value) => {
  const t = Date.parse(String(value || ""));
  return Number.isFinite(t) && t > Date.now();
};

/**
 * Minutes today the mailbox tile was NOT healthy, from the tick's own samples.
 * DEGRADED and DOWN both start with "D"; both mean automations could not rely
 * on the mailbox, which is the number a human actually wants. "U" (UNKNOWN) is
 * counted separately — being blind is not the same as being down.
 */
export function lockoutFromSamples(samples, { now = Date.now() } = {}) {
  const list = Array.isArray(samples) ? samples : [];
  if (!list.length) return { lockedMinutes: null, blindMinutes: null, samples: 0 };
  const startMinute = Math.floor(pacificMidnightEpoch(pacificDay(now), now) / 60);
  const today = list.filter((s) => Number(s?.t) >= startMinute);
  let locked = 0;
  let blind = 0;
  for (const s of today) {
    const code = String(s?.s || "").toUpperCase();
    if (code === "D") locked += SAMPLE_MINUTES;
    else if (code === "U") blind += SAMPLE_MINUTES;
  }
  return { lockedMinutes: locked, blindMinutes: blind, samples: today.length };
}

/** One Sent count for the day. Exact up to PAGE_CAP pages; flagged if capped. */
async function countSentToday(day, { fetchImpl = fetch, tokenImpl = delegatedGoogleAccessToken } = {}) {
  const token = await tokenImpl(MAILBOX, { scopes: SCOPES });
  const q = encodeURIComponent(`in:sent after:${pacificMidnightEpoch(day)}`);
  let pageToken = null;
  let sends = 0;
  let pages = 0;
  do {
    const url = `${GMAIL_LIST}?q=${q}&maxResults=500${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
    if (res.status === 429) {
      const error = new Error("gmail 429");
      error.code = "GMAIL_429";
      throw error;
    }
    if (!res.ok) {
      const error = new Error(`gmail ${res.status}`);
      error.code = `GMAIL_${res.status}`;
      throw error;
    }
    const body = await res.json();
    sends += (body.messages || []).length;
    pageToken = body.nextPageToken || null;
    pages += 1;
  } while (pageToken && pages < PAGE_CAP);
  return { sends, exact: !pageToken, pages };
}

export function summarize(record, lockout) {
  const sends = Number.isFinite(Number(record?.sends)) ? Number(record.sends) : null;
  return {
    ok: true,
    mailbox: MAILBOX,
    day: record?.day ?? null,
    sends,
    cap: DAILY_SEND_CAP,
    pct: sends == null ? null : Math.round((sends / DAILY_SEND_CAP) * 1000) / 10,
    exact: record?.exact ?? null,
    checkedAt: record?.checkedAt ?? null,
    suppressed: Boolean(record?.suppressed),
    suppressedReason: record?.suppressedReason ?? null,
    four29Today: Number(record?.four29 || 0),
    lockedMinutesToday: lockout?.lockedMinutes ?? null,
    blindMinutesToday: lockout?.blindMinutes ?? null,
  };
}

export function createHandler({
  fetchImpl = fetch,
  tokenImpl = delegatedGoogleAccessToken,
  now = () => Date.now(),
} = {}) {
  return async function handler(req, res) {
    res.setHeader("cache-control", "no-store");
    if (req.method !== "GET") return res.status(405).json({ ok: false, error: "method" });
    if (!authed(req)) return res.status(401).json({ ok: false, error: "unauthorized" });

    const at = now();
    const day = pacificDay(at);
    const key = dayKey(day);

    let record = (await hGet(key)) || { day, sends: null, four29: 0 };
    if (record.day !== day) record = { day, sends: null, four29: 0 };

    const [backoffUntil, samples] = await Promise.all([hGet(BACKOFF_KEY), hGet(SAMPLES_KEY)]);
    const lockout = lockoutFromSamples(samples, { now: at });

    // Suppression comes first: a live 429 witness means every call we make
    // would re-quote the penalty and keep the mailbox locked.
    const armed = futureIso(backoffUntil?.until || backoffUntil);
    const stale = !record.checkedAt || at - Date.parse(record.checkedAt) >= CHECK_FRESH_MS;

    if (armed) {
      record.suppressed = true;
      record.suppressedReason = "a 429 breaker is armed; not probing while the mailbox is locked";
      await hSet(key, record, DAY_TTL_SECONDS);
      return res.status(200).json(summarize(record, lockout));
    }

    if (!stale) {
      record.suppressed = false;
      record.suppressedReason = null;
      return res.status(200).json(summarize(record, lockout));
    }

    try {
      const counted = await countSentToday(day, { fetchImpl, tokenImpl });
      record = {
        ...record,
        sends: counted.sends,
        exact: counted.exact,
        checkedAt: new Date(at).toISOString(),
        suppressed: false,
        suppressedReason: null,
      };
    } catch (error) {
      const code = String(error?.code || error?.message || "unknown").slice(0, 60);
      // Our own probe hitting 429 is itself the most direct witness there is.
      if (code === "GMAIL_429") record.four29 = Number(record.four29 || 0) + 1;
      record.suppressed = true;
      record.suppressedReason = code;
      // The last good count for the day stands rather than reverting to null:
      // a stale-but-real number beats "unknown" against a hard cap.
    }

    await hSet(key, record, DAY_TTL_SECONDS);
    return res.status(200).json(summarize(record, lockout));
  };
}

export default createHandler();
