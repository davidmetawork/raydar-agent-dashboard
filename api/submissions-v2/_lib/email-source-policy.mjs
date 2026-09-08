const clean = (value) => String(value ?? "").trim();

export const GMAIL_ROLE_INTEREST_SCOPE = "approved_role_interest_v1";
export const SUBMISSIONS_V2_APPROVED_ACTIVATION_AT = "2026-09-02T02:45:14.308Z";

export const APPROVED_EMAIL_FAMILIES = Object.freeze([
  "para_ai_interview_request",
  "new_match",
  "fit_follow_up_with_matches",
]);

const PARAform_HOSTS = new Set(["paraform.com", "www.paraform.com"]);
const ROLE_ID = /^[A-Za-z0-9_-]{1,200}$/u;
const SHARE_ROLE_ID = /^[A-Za-z0-9_-]{6,200}$/u;
const SHARE_SLUG = /^[A-Za-z0-9][A-Za-z0-9()._-]{0,199}$/u;

/** Accept only role URLs emitted by Raydar/Paraform. Digest/list URLs are not roles. */
export function paraformRoleLink(value) {
  let url;
  try { url = new URL(clean(value).replace(/[\])}.!,;?:]+$/u, "")); } catch { return null; }
  if (url.protocol !== "https:" || !PARAform_HOSTS.has(url.hostname) || url.port || url.username || url.password || url.hash) return null;

  let roleId = null;
  if (url.pathname === "/browse") {
    roleId = url.searchParams.get("role");
    if (!ROLE_ID.test(roleId || "")) return null;
  } else {
    if (url.search) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length === 3 && parts[0] === "share") {
      let slug;
      try {
        slug = decodeURIComponent(parts[1]);
        roleId = decodeURIComponent(parts[2]);
      } catch { return null; }
      if (!SHARE_SLUG.test(slug) || !SHARE_ROLE_ID.test(roleId)) return null;
    } else if (parts.length === 4 && parts[0] === "lists" && parts[2] === "role") {
      let listId;
      try {
        listId = decodeURIComponent(parts[1]);
        roleId = decodeURIComponent(parts[3]);
      } catch { return null; }
      if (!ROLE_ID.test(listId) || !ROLE_ID.test(roleId)) return null;
    } else {
      return null;
    }
  }
  return {
    role_id: roleId,
    company: "",
    title: "",
    url: `https://www.paraform.com/browse?role=${encodeURIComponent(roleId)}`,
  };
}

const INTEREST_ASK = /\b(?:would you be interested|any interest in exploring|would you be open|open to (?:connecting|having|learning)|let me know if you(?:'d| would) be open|look interesting)\b/iu;
const ADMINISTRATIVE_COPY = /\b(?:interview (?:prep(?:aration)?|confirmed|confirmation)|prep(?:aration)? (?:guide|document|doc|materials)|later[- ]stage interview|what to expect in (?:the |your )?(?:later |next )?interview stage|(?:your |the )?interview (?:has been |is )scheduled|calendar invitation)\b/iu;

// Match Watch announces roles as "Raydar - New Role Match 🎉" / "Raydar - New Role
// Matches 🎉" and sends them through the Mailroom (SendGrid), so the outbound original
// never reaches Gmail Sent and the reply is classified by subject alone.  A read-only
// probe of the live mailbox on 2026-09-08 (analysis note gmail-search-probe.md) counted
// 0 messages for the shipped phrase subject:"New Match" against 184 for
// subject:"New Role Match": "new match" does not match "New Role Match" in either Gmail
// phrase search or the regex below, which is why this family never entered V2.
const NEW_ROLE_MATCH = /\bnew role match(?:es)?\b/iu;
// Both Match Watch templates (single and multi) carry both markers; requiring both keeps
// a neighbouring template that merely links a job description out of this family.
const MATCH_WATCH_OPENING = /\bi recently got (?:a new role|some new roles)\b/iu;
const MATCH_WATCH_JD_LINE = /\blinking the job description(?:s)?\b/iu;
// Reply clients prefix the subject; the family test is anchored on what is left, so a
// title-suffixed Interview Agent invite ("Raydar - 1st Round Interview - {title}") is not
// read as the bare curated-list follow-up subject it resembles.
const REPLY_PREFIX = /^(?:\s*(?:re|fw|fwd|aw|sv|antw)\s*(?:\[\d{1,3}\])?\s*:\s*)+/iu;
const SUBJECT_TRAILING_DECORATION = /[\s\p{P}\p{S}]+$/u;

/** The subject a family test sees: reply prefixes and trailing decoration removed. */
export function coreSubject(subject) {
  return clean(subject).replace(REPLY_PREFIX, "").replace(SUBJECT_TRAILING_DECORATION, "").trim();
}

/** Classify the exact outbound parent. Prep/admin copy intentionally returns null. */
export function outboundEmailFamily({ subject = "", text = "", roleCount = 0 } = {}) {
  const sample = `${clean(subject)}\n${clean(text)}`;
  if (ADMINISTRATIVE_COPY.test(sample)) return null;
  if (/\bthanks for taking the time to chat(?: with our ai agent)?\b/iu.test(sample)
    && /\bsee (?:your |all of your |your existing )?match(?:es)? here\b/iu.test(sample)
    && /\b(?:look|looks) interesting\b/iu.test(sample)) return "fit_follow_up_with_matches";
  if (/\bnew match(?:es)?\b/iu.test(sample) && INTEREST_ASK.test(sample)) return "new_match";
  if (roleCount > 0 && /\bnew match(?:es)?\b/iu.test(subject)) return "new_match";
  if (/\binterview request(?:s)?\b/iu.test(sample) && INTEREST_ASK.test(sample)) return "para_ai_interview_request";
  if (/\b(?:interested in this|new interview request|another interview request)\b/iu.test(sample) && INTEREST_ASK.test(sample)) return "para_ai_interview_request";
  if (roleCount > 0 && /\binterview request(?:s)?\b/iu.test(subject)) return "para_ai_interview_request";
  // Appended last so every family that already resolves keeps resolving unchanged.
  if (NEW_ROLE_MATCH.test(sample)) return "new_match";
  if (MATCH_WATCH_OPENING.test(sample) && MATCH_WATCH_JD_LINE.test(sample)) return "new_match";
  return null;
}

/** A subject is only a fallback family hint when the outbound parent is absent. */
export function replySubjectFamily(subject) {
  const value = clean(subject);
  if (/\binterview request(?:s)?\b/iu.test(value)) return "para_ai_interview_request";
  if (/\bnew match(?:es)?\b/iu.test(value)) return "new_match";
  // Anchored: only the bare curated-list follow-up subject is this family.
  if (/^raydar\s*-\s*1st round interview$/iu.test(coreSubject(value))) return "fit_follow_up_with_matches";
  if (NEW_ROLE_MATCH.test(value)) return "new_match";
  return null;
}
