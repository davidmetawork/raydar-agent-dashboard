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
  return null;
}

/** A subject is only a fallback family hint when the outbound parent is absent. */
export function replySubjectFamily(subject) {
  const value = clean(subject);
  if (/\binterview request(?:s)?\b/iu.test(value)) return "para_ai_interview_request";
  if (/\bnew match(?:es)?\b/iu.test(value)) return "new_match";
  if (/\braydar\s*-\s*1st round interview\b/iu.test(value)) return "fit_follow_up_with_matches";
  return null;
}
