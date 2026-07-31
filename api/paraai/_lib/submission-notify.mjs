/**
 * Paraform submission notifications — pure logic.
 *
 * One Slack channel collects every signal that a candidate has responded about
 * a submission, from three independent streams:
 *
 *   1. INTEREST  — a candidate marked interest on a curated list we sent.
 *   2. REQUEST   — a reply from a candidate we emailed about a Para AI Request.
 *   3. SEQUENCE  — a reply from a candidate in the post-call curated-list
 *                  email sequence.
 *
 * NOTIFY-ONLY. Nothing in this file writes to Paraform, sends email, or
 * actions a candidate. It turns an event into a short message and a dedupe key.
 *
 * ── On the three-way signal ────────────────────────────────────────────────
 * This answers "does this person want THIS role?" That is a DIFFERENT question
 * from `outreach-intent.mjs`, which answers "may we send them a brand-new
 * opportunity?" Its rubric says outright that a no to one role is not a no to
 * the market, so a reply can legitimately be OPEN there and `not_interested`
 * here. They do not conflict and neither should be derived from the other.
 *
 * ── Why `unclear` is the default ──────────────────────────────────────────
 * A wrong `interested` costs David a few seconds reading a message. A wrong
 * `not_interested` can silently drop a real candidate who wanted the job, and
 * nobody would ever look again. So the classifier only labels what it can
 * evidence, and everything else becomes `unclear` — which means "David reads
 * this one". Never widen the not-interested patterns to reduce `unclear`.
 */

export const SIGNAL_INTERESTED = "interested";
export const SIGNAL_NOT_INTERESTED = "not_interested";
export const SIGNAL_UNCLEAR = "unclear";

export const SIGNALS = new Set([SIGNAL_INTERESTED, SIGNAL_NOT_INTERESTED, SIGNAL_UNCLEAR]);

export const STREAM_INTEREST = "interest";
export const STREAM_REQUEST = "request";
export const STREAM_SEQUENCE = "sequence";

const SIGNAL_LABEL = {
  [SIGNAL_INTERESTED]: "✅ Interested",
  [SIGNAL_NOT_INTERESTED]: "🚫 Not interested",
  [SIGNAL_UNCLEAR]: "❓ Unclear",
};

const STREAM_LABEL = {
  [STREAM_INTEREST]: "curated list interest",
  [STREAM_REQUEST]: "Para AI Request reply",
  [STREAM_SEQUENCE]: "curated list sequence reply",
};

const SNIPPET_MAX = 180;

const str = (value) => (typeof value === "string" ? value.trim() : "");

/* ────────────────────────────────────────────────── stream 1: interest marks */

/**
 * Curated-list interest is a click, not prose, so it is decided without any
 * language model. Paraform's own vocabulary maps exactly onto ours, and
 * anything we do not recognise stays `unclear` rather than being guessed.
 */
export function signalFromInterestStatus(status) {
  const value = str(status).toUpperCase();
  if (value === "APPLIED_TO_ROLE") return SIGNAL_INTERESTED;
  if (value === "NOT_INTERESTED") return SIGNAL_NOT_INTERESTED;
  return SIGNAL_UNCLEAR;
}

/* ───────────────────────────────────────── streams 2 and 3: replies as prose */

// Explicit, role-level "no". Deliberately narrow — see the header note on why
// `unclear` is preferred over a wrong `not_interested`.
const NOT_INTERESTED_PATTERNS = [
  /\bnot interested\b/i,
  /\bno longer interested\b/i,
  /\bi'?m going to pass\b/i,
  /\bi'?ll pass\b/i,
  /\bgoing to pass on (?:this|it)\b/i,
  /\bnot (?:a|the) right fit\b/i,
  /\bnot (?:a|the) good fit\b/i,
  /\bthis (?:one )?(?:isn'?t|is not) for me\b/i,
  /\bnot looking (?:for|to)\b/i,
  /\bplease remove me\b/i,
  /\b(?:i )?(?:just )?accepted (?:another|an) offer\b/i,
  /\bi'?ve accepted a (?:new )?(?:role|position|job|offer)\b/i,
  /\bhappy (?:where i am|in my current)\b/i,
];

// Explicit, affirmative interest. Also narrow: enthusiasm about talking is not
// the same as wanting this role, but it IS a positive signal worth surfacing.
const INTERESTED_PATTERNS = [
  /\b(?:i'?m|i am|very|definitely|absolutely) interested\b/i,
  /\bi'?d (?:be |love to |like to )(?:very )?interested\b/i,
  /\bsounds (?:great|good|interesting|promising)\b/i,
  /\b(?:yes|yep|yeah)[,!. ]/i,
  /\bi'?d love to (?:hear|learn|chat|talk|know)\b/i,
  /\bhappy to (?:chat|talk|connect|learn more)\b/i,
  /\bcount me in\b/i,
  /\bplease (?:submit|put me forward|send it)\b/i,
  /\btell me more\b/i,
  /\bwhen (?:can|could) we (?:chat|talk|speak)\b/i,
];

/**
 * Deterministic first pass over reply text. No model call, no cost, no latency.
 *
 * Order matters: a "no" is checked first, because a message like "thanks, sounds
 * great, but I'm not interested" is a decline wearing polite clothing, and
 * reading it as interest is the error that wastes David's time chasing someone
 * who already said no.
 *
 * Returns `unclear` for anything it cannot evidence — including empty text,
 * questions, scheduling, and out-of-office replies.
 */
export function signalFromReplyText(text) {
  const value = str(text);
  if (!value) return SIGNAL_UNCLEAR;
  if (NOT_INTERESTED_PATTERNS.some((pattern) => pattern.test(value))) {
    return SIGNAL_NOT_INTERESTED;
  }
  if (INTERESTED_PATTERNS.some((pattern) => pattern.test(value))) {
    return SIGNAL_INTERESTED;
  }
  return SIGNAL_UNCLEAR;
}

/* ──────────────────────────────────────────────────────────────── the message */

/**
 * Paraform exposes no stable per-candidate profile route that this codebase has
 * ever proven — the dashboard UI itself deep-links by name search, so we do the
 * same rather than invent a URL that may 404. If an id-based route is ever
 * captured, change only this function.
 */
export function paraformCandidateLink(name) {
  const value = str(name);
  const base = "https://www.paraform.com/candidates?sort=added_at%3Adesc";
  if (!value) return base;
  return `${base}&q=${encodeURIComponent(value).replace(/%20/g, "+")}`;
}

/**
 * Reply text arrives as multi-line email with quoting and signatures. Slack
 * messages must stay glanceable, so collapse to one line and cap the length.
 */
export function snippet(text, max = SNIPPET_MAX) {
  const value = str(text).replace(/\s+/g, " ");
  if (!value) return "";
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

/**
 * One message per event. Kept deliberately short: signal, who, what stream,
 * the role if we know it, a snippet if there is one, and the link.
 */
export function buildNotification({
  stream,
  candidateName,
  roleName = "",
  signal,
  replyText = "",
  link = "",
} = {}) {
  const safeSignal = SIGNALS.has(signal) ? signal : SIGNAL_UNCLEAR;
  const who = str(candidateName) || "Unknown candidate";
  const role = str(roleName);
  const url = str(link) || paraformCandidateLink(who);
  const context = STREAM_LABEL[stream] || "candidate response";

  const head = `${SIGNAL_LABEL[safeSignal]} — *${who}*`;
  const where = role ? `${context} · ${role}` : context;
  const body = snippet(replyText);

  const lines = [head, `_${where}_`];
  if (body) lines.push(`> ${body}`);
  lines.push(`<${url}|Open in Paraform>`);
  return { signal: safeSignal, text: lines.join("\n") };
}

/**
 * Dedupe is per (stream, candidate, event) so the same reply is never posted
 * twice, while a genuinely new reply from the same person still gets its own
 * message. Callers pass the most stable event id their source offers — a
 * message id, a batch id, or a timestamp — never a value that changes on
 * every poll.
 */
export function notificationDedupeKey({ stream, candidateUserId, eventId } = {}) {
  const parts = [str(stream) || "unknown", str(candidateUserId) || "unknown", str(eventId) || "none"];
  return `paraai:subnotify:sent:${parts.join(":")}`;
}
