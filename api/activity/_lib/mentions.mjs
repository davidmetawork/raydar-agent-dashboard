// SPL mention resolution + markup — ported from the chase (main repo
// src/hm-chase/mentions.mjs), which paid for the sharpest trap in the wire
// contract: the activity feed RENDERS mentions as data-type="mention"
// data-id="…", but what the composer STORES (and the only shape the server
// parses into the notify list) is data-consolidated-messaging-id="user::<id>".
// Posting the rendered form looks right and notifies nobody. Read-back must
// check the echoed mentions[], not the text.

import { getMentionList, getRoleOwner } from "./paraform.mjs";

export const MENTION_ID_PREFIX = "user::";

// SPLs who asked not to be @-tagged on platform (chase parity, 2026-08-03):
// same comment, same cadence, mention span omitted. Whole-name match only.
const DEFAULT_NO_TAG = ["Thomas Roske"];
export function noTagSpl(name) {
  const raw = process.env.ACTIVITY_NO_TAG_SPLS;
  const list = raw != null
    ? String(raw).split(",").map((s) => s.trim()).filter(Boolean)
    : DEFAULT_NO_TAG;
  return list.some((n) => n.toLowerCase() === String(name || "").trim().toLowerCase());
}

export const escapeHtml = (s) => String(s || "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function mentionSpan(userId, label) {
  const esc = escapeHtml(label);
  return `<span class="mention" data-consolidated-messaging-id="${MENTION_ID_PREFIX}${escapeHtml(userId)}" data-label="${esc}">@${esc}</span>`;
}

/**
 * Resolve the role's Strategic Projects Lead into a verified-mentionable
 * target. Deterministic: role.getRoleOwner gives the exact id; the thread's
 * mention list verifies that id is actually tag-able there. An owner who
 * fails to resolve is SKIPPED (comment posts untagged), never guessed —
 * "we don't know who owns this role" must not masquerade as an opt-out.
 */
export async function resolveSpl(roleId, threadId) {
  let owner = null;
  try { owner = await getRoleOwner(roleId); } catch { return null; }
  if (!owner?.id || !owner?.name) return null;
  if (noTagSpl(owner.name)) return { ...ownerLabel(owner), noTag: true };
  try {
    const list = (await getMentionList(threadId)) || [];
    const hit = list.find((m) => m?.id === owner.id || m?.metadata?.user?.id === owner.id);
    if (!hit) return null;
  } catch { return null; }
  return { ...ownerLabel(owner), noTag: false };
}

export function ownerLabel(owner) {
  const team = Array.isArray(owner.team) && owner.team.length ? ` (${owner.team[0]})` : "";
  return { id: owner.id, name: owner.name, label: `${owner.name}${team}` };
}

/** Plain composer text -> the HTML Paraform stores, with optional SPL tag. */
export function renderCommentHtml(text, spl) {
  const paragraphs = String(text || "").trim().split(/\n{2,}/).map((p) =>
    `<p>${escapeHtml(p.trim()).replace(/\n/g, "<br/>")}</p>`);
  if (spl && !spl.noTag) {
    const last = paragraphs.pop() || "<p></p>";
    paragraphs.push(last.replace(/<\/p>$/, ` ${mentionSpan(spl.id, spl.label)}</p>`));
  }
  return paragraphs.join("");
}
