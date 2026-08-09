// GET /api/activity/thread?application_id=&thread_id= — one candidate's full
// subthread timeline (messages AND structural events), oldest first, plus the
// SPL tag target so the composer can show who a nudge would notify.

import { cors, requireAuth } from "../seq/_lib/core.mjs";
import { getThread, resolveApplicationThread } from "./_lib/paraform.mjs";
import { resolveSpl } from "./_lib/mentions.mjs";
import { stripHtml } from "./_lib/feed.mjs";

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "GET") { res.status(405).json({ ok: false, error: "method_not_allowed" }); return; }
  if (!(await requireAuth(req, res))) return;

  const applicationId = String(req.query?.application_id || "").trim();
  let threadId = String(req.query?.thread_id || "").trim();
  const roleId = String(req.query?.role_id || "").trim();
  if (!applicationId) { res.status(400).json({ ok: false, error: "application_id_required" }); return; }
  const subthreadId = `application:${applicationId}`;

  try {
    let items = threadId ? (await getThread(threadId)) || [] : [];
    let mine = items.filter((it) => it?.id === subthreadId || it?.rootMessageId === subthreadId);
    if (!mine.length) {
      const resolved = await resolveApplicationThread(applicationId);
      if (resolved?.threadId) {
        threadId = resolved.threadId;
        items = (await getThread(threadId)) || [];
        mine = items.filter((it) => it?.id === (resolved.subthreadId || subthreadId) || it?.rootMessageId === (resolved.subthreadId || subthreadId));
      }
    }
    if (!mine.length) { res.status(200).json({ ok: false, error: "thread_unresolved" }); return; }

    mine.sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0));
    const timeline = mine.map((it) => ({
      id: it.id,
      type: it.type,
      direction: it.direction,
      at: it.createdAt,
      from: it.fromUser?.name || null,
      fromType: it.fromUser?.type || null,
      text: stripHtml(it.text),
      html: it.text || "",
      structural: !stripHtml(it.text),
      stage: it.metadata?.currentStage?.name || null,
      status: it.metadata?.status || null,
      scheduledAt: it.metadata?.scheduledAt || null,
      mentions: (it.mentions || []).map((m) => m?.label || m?.metadata?.user?.name).filter(Boolean),
    }));

    let spl = null;
    if (roleId) { try { spl = await resolveSpl(roleId, threadId); } catch { spl = null; } }

    res.status(200).json({ ok: true, threadId, subthreadId, timeline, spl });
  } catch (e) {
    res.status(200).json({ ok: false, error: String(e?.message || e).slice(0, 200) });
  }
}
