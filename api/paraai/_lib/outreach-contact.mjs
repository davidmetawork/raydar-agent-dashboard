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
  } = {},
) {
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
    q: clean(candidateName),
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
  return calendarCandidateEvidence(body?.items || [], candidateName, mailbox);
}

export async function discoverCandidateContact(
  {
    candidateName,
    mailbox,
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
  const [gmail, calendar] = await Promise.allSettled([
    gmailEvidenceImpl(mailbox, candidateName),
    calendarEvidenceImpl(mailbox, candidateName),
  ]);
  if (gmail.status === "fulfilled") result.gmailEmails = gmail.value;
  else result.gmailError = clean(gmail.reason?.code || "GMAIL_CONTACT_LOOKUP_FAILED");
  if (calendar.status === "fulfilled") result.calendarEmails = calendar.value;
  else result.calendarError = clean(
    calendar.reason?.code || "GOOGLE_CALENDAR_CONTACT_LOOKUP_FAILED",
  );
  return resolveContactEvidence(result);
}
