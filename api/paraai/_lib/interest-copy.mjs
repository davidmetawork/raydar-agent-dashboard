// Candidate-facing copy for the curated-list interest lane.
//
// David authored this wording verbatim on 2026-07-28 and it ships as written,
// including the "Talk soon," close. This file is the single place to edit it.
// Plan §6/§7: docs/PLAN-CURATED-INTEREST-TO-SUBMISSION-2026-07-28.md
//
// House rules this copy already follows: "Hey {First}," greeting, one- to
// two-sentence paragraphs, forward-looking close, first name only, no em
// dashes, plain text with no links or images.

const FALLBACK_SUBJECT = "Your roles";

/**
 * First name, validated. Returns null when the name is unusable so the caller
 * routes to review instead of sending "Hey there" to an engaged candidate.
 */
export function firstNameFor(fullName) {
  const cleaned = String(fullName || "")
    // strip leading emoji/symbols Paraform users prepend (e.g. the lightning bolt tag)
    .replace(/^[^\p{L}]+/u, "")
    .trim();
  if (!cleaned) return null;
  const token = cleaned.split(/\s+/)[0];
  if (!token) return null;
  // Splitting on whitespace already removes CR/LF, but reject any remaining
  // control or format characters explicitly so nothing header-unsafe can reach
  // a mail header or the greeting line.
  if (/[\p{Cc}\p{Cf}]/u.test(token)) return null;
  // A usable first name must contain an actual letter.
  if (!/\p{L}/u.test(token)) return null;
  return token.length > 40 ? token.slice(0, 40) : token;
}

/**
 * David's copy. `roleCount` drives singular/plural; his source text wrote
 * "roles(s)" and "team(s)" as shorthand for exactly this.
 */
export function interestConfirmationBody({ firstName, roleCount = 1 }) {
  const name = String(firstName || "").trim();
  if (!name) throw new Error("firstName required");
  const n = Math.max(1, Number(roleCount) || 1);
  const roleWord = n === 1 ? "role" : "roles";
  const teamWord = n === 1 ? "team" : "teams";
  return [
    `Hey ${name},`,
    "",
    `I just saw that you signaled interest on the ${roleWord} I sent over!`,
    "",
    `Will get you in front of the ${teamWord} asap and report back with next steps as soon as I have an update.`,
    "",
    "Talk soon,",
    "David",
  ].join("\n");
}

export function interestConfirmationHtml({ firstName, roleCount = 1 }) {
  const text = interestConfirmationBody({ firstName, roleCount });
  const esc = (s) => s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  // Blank lines are preserved as real empty paragraphs, matching the outreach
  // mailer's rendering so spacing looks identical in Gmail.
  return text
    .split("\n")
    .map((line) => (line === "" ? "<div><br></div>" : `<div>${esc(line)}</div>`))
    .join("");
}

/**
 * Subject only matters when there is no existing thread to reply onto. In-thread
 * replies reuse the original subject with "Re:" per the transport's convention.
 */
export function interestConfirmationSubject({ existingSubject = null } = {}) {
  const s = String(existingSubject || "").trim();
  if (!s) return FALLBACK_SUBJECT;
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

export function buildInterestConfirmation({ firstName, roleCount = 1, existingSubject = null }) {
  return {
    subject: interestConfirmationSubject({ existingSubject }),
    text: interestConfirmationBody({ firstName, roleCount }),
    html: interestConfirmationHtml({ firstName, roleCount }),
  };
}

export const COPY_VARIANT = "interest_confirmation_exact_v1";
