import { normalizeEmail } from "./core.mjs";
import {
  delegatedGoogleAccessToken,
  getThread,
  GOOGLE_CALENDAR_READONLY_SCOPE,
  headerValue,
  searchThreads,
} from "./outreach-gmail.mjs";

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";
const clean = (value) => String(value || "").trim();

export function normalizeContactName(value) {
  return clean(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// INCIDENT 2026-07-29 (William M.). Paraform sometimes stores an abbreviated
// display name \u2014 "William M." \u2014 and for such a candidate the calendar half of
// discovery cannot work: Google's tokenised search does not return his event for
// q="William M.", it returns a DIFFERENT person's event, and our own filter
// (`includes("william m")`) would have happily accepted that stranger. Because
// corroboration needs both halves, no address could ever be resolved for anyone
// whose name is abbreviated and whose Paraform record has no email.
//
// The fix is NOT to guess his surname. Measured against the 140 candidates in the
// request history whose full name we already know \u2014 abbreviating each one and
// asking the deriver to recover it \u2014 a name derived from the LinkedIn handle is
// still wrong about 4% of the time (`nithinkkumar` for Kasireddy, `india-a` for
// Adams). One wrong name in twenty-five, used to pick an email address, means
// eventually mailing a stranger somebody else's interview request.
//
// So identity comes from the handle itself, never from a derived name. Calendly
// writes the candidate's LinkedIn URL into the booked event's description: 573 of
// the mailbox's events carry one, 570 of those also carry an external attendee.
// A handle is an exact token that cannot collide the way "william m" does.
export function normalizeLinkedinHandle(value) {
  const raw = clean(value).toLowerCase();
  if (!raw) return "";
  const fromUrl = raw.match(/linkedin\.com\/in\/([a-z0-9_-]+)/i);
  const handle = fromUrl ? fromUrl[1] : raw.replace(/^\/+|\/+$/g, "");
  // A bare handle only. Anything with a slash left in it is a URL we do not
  // understand, and guessing at it is how the wrong person gets matched.
  return /^[a-z0-9_-]+$/.test(handle) ? handle : "";
}

// True when Paraform's display name is a first name plus a bare initial, which is
// the only shape this whole path exists for.
export function isAbbreviatedName(value) {
  const parts = normalizeContactName(value).split(" ").filter(Boolean);
  return parts.length >= 2 && parts[parts.length - 1].length === 1;
}

export function eventMentionsLinkedinHandle(event, handle) {
  const wanted = normalizeLinkedinHandle(handle);
  if (!wanted) return false;
  const description = String(event?.description || "");
  for (const match of description.matchAll(/linkedin\.com\/in\/([A-Za-z0-9_-]+)/gi)) {
    // Exact handle equality, never a prefix: `linkedin.com/in/willi` must not
    // match `william-mulder`, and `/in/amy` must not match `/in/amyzhang`.
    if (match[1].toLowerCase().replace(/\/+$/, "") === wanted) return true;
  }
  return false;
}

/**
 * The routing decision, exported so it can be tested directly rather than
 * inferred from whichever evidence a mocked calendar happens to return.
 *
 * Returns the handle to search by, or "" to keep the existing name route. The
 * handle route is used ONLY for an abbreviated name: for a full name the name
 * route already works, and switching it to the handle would silently lose every
 * candidate whose meeting was booked outside Calendly (no LinkedIn URL in the
 * description, therefore no evidence at all).
 */
export function handleRouteFor(candidateName, linkedinUser) {
  const handle = normalizeLinkedinHandle(linkedinUser);
  if (!handle) return "";
  return isAbbreviatedName(candidateName) ? handle : "";
}

export function linkedinCalendarEvidence(events, handle, mailbox) {
  if (!normalizeLinkedinHandle(handle)) return [];
  const emails = new Set();
  for (const event of events || []) {
    if (!eventMentionsLinkedinHandle(event, handle)) continue;
    for (const attendee of event?.attendees || []) {
      const candidate = externalEmail(attendee?.email, mailbox);
      if (candidate) emails.add(candidate);
    }
  }
  return [...emails].sort();
}

function extractEmails(value) {
  return [...new Set(
    (String(value || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [])
      .map(normalizeEmail)
      .filter(Boolean),
  )];
}

function addressSegments(value) {
  const segments = [];
  let current = "";
  let quoted = false;
  let angleDepth = 0;
  const raw = String(value || "");
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (character === '"' && raw[index - 1] !== "\\") quoted = !quoted;
    if (!quoted && character === "<") angleDepth += 1;
    if (!quoted && character === ">") angleDepth = Math.max(0, angleDepth - 1);
    if (!quoted && angleDepth === 0 && character === ",") {
      if (current.trim()) segments.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

function externalEmail(value, mailbox) {
  const email = normalizeEmail(value);
  if (!email || email === normalizeEmail(mailbox)) return "";
  return email;
}

export function gmailCandidateEvidence(thread, candidateName, mailbox) {
  const wanted = normalizeContactName(candidateName);
  if (!wanted) return [];
  const emails = new Set();
  for (const message of thread?.messages || []) {
    for (const name of ["From", "To", "Cc"]) {
      const header = headerValue(message, name) || "";
      for (const segment of addressSegments(header)) {
        if (!normalizeContactName(segment).includes(wanted)) continue;
        for (const email of extractEmails(segment)) {
          const candidate = externalEmail(email, mailbox);
          if (candidate) emails.add(candidate);
        }
      }
    }
  }
  return [...emails].sort();
}

export function calendarCandidateEvidence(events, candidateName, mailbox) {
  const wanted = normalizeContactName(candidateName);
  if (!wanted) return [];
  const emails = new Set();
  for (const event of events || []) {
    const searchable = normalizeContactName(
      `${event?.summary || ""} ${event?.description || ""}`,
    );
    if (!searchable.includes(wanted)) continue;
    for (const attendee of event?.attendees || []) {
      const candidate = externalEmail(attendee?.email, mailbox);
      if (candidate) emails.add(candidate);
    }
  }
  return [...emails].sort();
}

export function resolveContactEvidence({
  gmailEmails = [],
  calendarEmails = [],
  gmailError = null,
  calendarError = null,
} = {}) {
  const gmail = [...new Set(gmailEmails.map(normalizeEmail).filter(Boolean))].sort();
  const calendar = [...new Set(calendarEmails.map(normalizeEmail).filter(Boolean))].sort();
  const calendarSet = new Set(calendar);
  const corroborated = gmail.filter((email) => calendarSet.has(email));
  const suggestions = [...new Set([...corroborated, ...calendar, ...gmail])];
  return {
    email: corroborated.length === 1 ? corroborated[0] : "",
    confidence: corroborated.length === 1 ? "gmail_calendar_corroborated" : "unresolved",
    gmailEmails: gmail,
    calendarEmails: calendar,
    suggestedEmails: suggestions,
    gmailError,
    calendarError,
  };
}

async function gmailEvidence(mailbox, candidateName) {
  const escaped = clean(candidateName).replace(/"/g, "");
  const refs = await searchThreads(mailbox, `"${escaped}"`, 50);
  const emails = new Set();
  for (const ref of refs.slice(0, 20)) {
    try {
      const thread = await getThread(mailbox, ref.id);
      for (const email of gmailCandidateEvidence(thread, candidateName, mailbox)) {
        emails.add(email);
      }
    } catch {
      // One unreadable thread must not hide corroborating evidence elsewhere.
    }
  }
  return [...emails].sort();
}

async function calendarEvidence(
  mailbox,
  candidateName,
  {
    fetchImpl = fetch,
    now = Date.now(),
    linkedinUser = "",
  } = {},
) {
  // For an abbreviated name the handle REPLACES the name route rather than
  // supplementing it. Unioning the two would re-admit exactly the failure this
  // fixes: q="William M." returns a stranger's event and the loose name filter
  // accepts it. With no handle available there is nothing safe to do, so this
  // stays as broken as it was rather than becoming wrong — the send then fails
  // closed on OUTREACH_NO_EMAIL, which is the documented, alerted outcome.
  const handle = handleRouteFor(candidateName, linkedinUser);
  const useHandleRoute = Boolean(handle);
  let token;
  try {
    token = await delegatedGoogleAccessToken(mailbox, {
      scopes: [GOOGLE_CALENDAR_READONLY_SCOPE],
      fetchImpl,
    });
  } catch (error) {
    if (error?.code === "GMAIL_AUTH_FAILED") {
      error.code = "GOOGLE_CALENDAR_SCOPE_MISSING";
    }
    throw error;
  }
  const params = new URLSearchParams({
    // Searching by the handle finds the Calendly-booked event directly; the
    // description carries the LinkedIn URL, and the handle is a far better search
    // token than a name that is missing half of itself.
    q: useHandleRoute ? handle : clean(candidateName),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "250",
    timeMin: new Date(now - 4 * 365 * 24 * 60 * 60 * 1000).toISOString(),
    timeMax: new Date(now + 365 * 24 * 60 * 60 * 1000).toISOString(),
  });
  const response = await fetchImpl(
    `${CALENDAR_BASE}/calendars/primary/events?${params}`,
    {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    },
  );
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(body?.error?.message || `Google Calendar HTTP ${response.status}`);
    error.code = response.status === 403
      ? "GOOGLE_CALENDAR_SCOPE_MISSING"
      : "GOOGLE_CALENDAR_REQUEST_FAILED";
    throw error;
  }
  const items = body?.items || [];
  return useHandleRoute
    ? linkedinCalendarEvidence(items, handle, mailbox)
    : calendarCandidateEvidence(items, candidateName, mailbox);
}

// INCIDENT 2026-07-29. Discovery needs BOTH halves, so the calendar read is a
// hard dependency of the send path for any candidate Paraform has no email for.
// For nine days the service account had no `calendar.readonly` domain-wide grant
// and the project's Calendar API was disabled, every corroboration was therefore
// impossible, and health reported the recovery path green the whole time. This
// probe is what makes that state observable instead of silent.
export async function probeCalendarAccess(
  mailbox,
  {
    fetchImpl = fetch,
    tokenImpl = delegatedGoogleAccessToken,
  } = {},
) {
  try {
    const token = await tokenImpl(mailbox, {
      scopes: [GOOGLE_CALENDAR_READONLY_SCOPE],
      fetchImpl,
    });
    const response = await fetchImpl(
      `${CALENDAR_BASE}/calendars/primary/events?maxResults=1&singleEvents=true`,
      {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (response.ok) return { ok: true, code: null };
    const body = await response.json().catch(() => null);
    return {
      ok: false,
      code: response.status === 403
        ? "GOOGLE_CALENDAR_SCOPE_MISSING"
        : "GOOGLE_CALENDAR_REQUEST_FAILED",
      detail: clean(body?.error?.message).slice(0, 180) || null,
    };
  } catch (error) {
    const code = error?.code === "GMAIL_AUTH_FAILED"
      ? "GOOGLE_CALENDAR_SCOPE_MISSING"
      : clean(error?.code) || "GOOGLE_CALENDAR_CONTACT_LOOKUP_FAILED";
    return { ok: false, code, detail: clean(error?.message).slice(0, 180) || null };
  }
}

export async function discoverCandidateContact(
  {
    candidateName,
    mailbox,
    linkedinUser = "",
  },
  {
    gmailEvidenceImpl = gmailEvidence,
    calendarEvidenceImpl = calendarEvidence,
  } = {},
) {
  const result = {
    gmailEmails: [],
    calendarEmails: [],
    gmailError: null,
    calendarError: null,
  };
  // The Gmail half is deliberately untouched. It already found the right address
  // for the 07-29 candidate — among three disposable-domain lookalikes — and the
  // intersection with a handle-verified calendar address is what discards those.
  // Fixing the calendar half is therefore sufficient, and widening the Gmail
  // search by a derived name would only add noise to the side that works.
  const [gmail, calendar] = await Promise.allSettled([
    gmailEvidenceImpl(mailbox, candidateName),
    calendarEvidenceImpl(mailbox, candidateName, { linkedinUser }),
  ]);
  if (gmail.status === "fulfilled") result.gmailEmails = gmail.value;
  else result.gmailError = clean(gmail.reason?.code || "GMAIL_CONTACT_LOOKUP_FAILED");
  if (calendar.status === "fulfilled") result.calendarEmails = calendar.value;
  else result.calendarError = clean(
    calendar.reason?.code || "GOOGLE_CALENDAR_CONTACT_LOOKUP_FAILED",
  );
  return resolveContactEvidence(result);
}
