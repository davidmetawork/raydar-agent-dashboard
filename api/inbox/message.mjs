import {
  cors,
  publicMessage,
  requestQuery,
  requireInboxAuth,
} from "./_lib/core.mjs";
import { trpcGet } from "../seq/_lib/core.mjs";

const GMAIL_ID_RE = /^[a-zA-Z0-9._:-]{1,512}$/;

export default async function handler(req, res) {
  if (cors(req, res)) return;
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }
  if (!(await requireInboxAuth(req, res))) return;

  const value = requestQuery(req).gmail_id;
  const gmailId = String(Array.isArray(value) ? value[0] : value || "").trim();
  if (!GMAIL_ID_RE.test(gmailId)) {
    return res.status(400).json({ ok: false, error: "invalid_gmail_id" });
  }

  try {
    const message = await trpcGet(
      "campaigns.getCampaignEmail",
      { gmail_id: gmailId },
      1,
    );
    return res.status(200).json({ ok: true, message: publicMessage(message) });
  } catch (error) {
    return res.status(error?.code === "AUTH_EXPIRED" ? 503 : 502).json({
      ok: false,
      error: error?.code === "AUTH_EXPIRED"
        ? "paraform_auth_expired"
        : "message_unavailable",
      detail: String(error?.message || error).slice(0, 180),
    });
  }
}
