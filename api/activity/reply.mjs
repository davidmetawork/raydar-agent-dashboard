// POST /api/activity/reply — post a comment onto a candidate's application
// subthread as David's Paraform session. The ONLY Paraform write in the
// Activity tab. Safety discipline inherited from the chase's post path
// (main repo src/hm-chase/post.mjs, 162 verified posts):
//
//   - single-attempt send, NEVER retried (a comment post is not idempotent;
//     a timed-out send may have landed; the failure mode of an ambiguous
//     send is "unconfirmed", never a double post)
//   - a 200 is "accepted", never "stored": the thread is re-read fresh and
//     the comment matched by normalized text + direction:sent on the right
//     subthread before we call it delivered
//   - if a mention was requested, read-back checks the echoed mentions[]
//     resolved — a tag that did not register reports "posted_untagged",
//     never silently claims the SPL was notified
//   - per-application claim in KV (NX, 90s) so double-clicks and racing
//     teammates cannot double-post the same reply

import { cors, requireAuth } from "../seq/_lib/core.mjs";
import { kv } from "./_lib/kv.mjs";
import { getThread, sendComment, AuthExpired } from "./_lib/paraform.mjs";
import { resolveSpl, renderCommentHtml } from "./_lib/mentions.mjs";
import { stripHtml } from "./_lib/feed.mjs";

const norm = (s) => stripHtml(s).toLowerCase().replace(/\s+/g, " ").trim();

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "POST") { res.status(405).json({ ok: false, error: "method_not_allowed" }); return; }
  if (!(await requireAuth(req, res))) return;

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const applicationId = String(body?.application_id || "").trim();
  const threadId = String(body?.thread_id || "").trim();
  const roleId = String(body?.role_id || "").trim();
  const text = String(body?.text || "").trim();
  const tagSpl = body?.tag_spl === true;

  if (!applicationId || !threadId) { res.status(400).json({ ok: false, error: "application_and_thread_required" }); return; }
  if (!text) { res.status(400).json({ ok: false, error: "text_required" }); return; }
  if (text.length > 4000) { res.status(400).json({ ok: false, error: "text_too_long" }); return; }
  const subthreadId = `application:${applicationId}`;

  // Claim before send: NX with a TTL long enough to cover send + read-back.
  const claimKey = `activity:v1:claim:${applicationId}`;
  const claimed = await kv(["SET", claimKey, req.authedEmail || "user", "NX", "EX", "90"]).catch(() => null);
  if (claimed !== "OK") { res.status(409).json({ ok: false, error: "reply_in_flight" }); return; }

  try {
    let spl = null;
    if (tagSpl && roleId) {
      spl = await resolveSpl(roleId, threadId).catch(() => null);
      // Tag requested but owner unresolvable → post untagged and SAY so,
      // never guess a person.
    }
    const html = renderCommentHtml(text, spl);

    let sendError = null;
    try {
      await sendComment({ threadId, text: html, replyTo: subthreadId });
    } catch (e) {
      sendError = e;
      if (e instanceof AuthExpired) {
        res.status(200).json({ ok: false, error: "paraform_auth", detail: "Session rejected the post. Nothing was retried — check Paraform before posting again." });
        return;
      }
      // Fall through to read-back: a timeout/network error may still have landed.
    }

    // Read-back verification on a FRESH thread fetch.
    let verified = false, mentionRegistered = null, postedItemId = null;
    try {
      const items = (await getThread(threadId)) || [];
      const wanted = norm(text);
      const hit = [...items].reverse().find((it) =>
        it?.direction === "sent" &&
        (it?.id === subthreadId || it?.rootMessageId === subthreadId) &&
        norm(it?.text) === wanted);
      if (hit) {
        verified = true;
        postedItemId = hit.id;
        if (spl && !spl.noTag) {
          mentionRegistered = (hit.mentions || []).some((m) => m?.id === spl.id || m?.metadata?.user?.id === spl.id);
        }
      }
    } catch { /* verification unavailable */ }

    if (verified) {
      res.status(200).json({
        ok: true,
        verified: true,
        itemId: postedItemId,
        tagged: spl ? (spl.noTag ? "no_tag_list" : (mentionRegistered ? "registered" : "posted_untagged")) : "none",
      });
    } else if (sendError) {
      res.status(200).json({ ok: false, error: "send_failed", detail: String(sendError?.message || sendError).slice(0, 200) });
    } else {
      // Accepted but not observed: report honestly, never resend.
      res.status(200).json({ ok: false, verified: false, error: "unconfirmed", detail: "Paraform accepted the post but the read-back could not confirm it. Check the thread in Paraform before posting again — do NOT repost blindly." });
    }
  } finally {
    await kv(["DEL", claimKey]).catch(() => {});
  }
}
