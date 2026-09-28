import {
  cors,
  inboxTrpcGet,
  publicMessage,
  requestQuery,
  requireInboxAuth,
  resolveInboxParaformSession,
  validInboxGmailId,
} from "./_lib/core.mjs";

// Reads through inboxTrpcGet, not seq's trpcGet: seq's 401 path reports the
// store session rejected, which parks it for 30 minutes and sends the rest
// of that request's retries on the dead env seal, turning one burst-throttle
// 401 into a false "session expired".
export function createInboxMessageHandler({
  corsHandler = cors,
  authHandler = requireInboxAuth,
  ensureSession = resolveInboxParaformSession,
  get = inboxTrpcGet,
} = {}) {
  return async function handler(req, res) {
    if (corsHandler(req, res)) return;
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ ok: false, error: "method_not_allowed" });
    }
    if (!(await authHandler(req, res))) return;

    const value = requestQuery(req).gmail_id;
    const gmailId = String(Array.isArray(value) ? value[0] : value || "").trim();
    if (!validInboxGmailId(gmailId)) {
      return res.status(400).json({ ok: false, error: "invalid_gmail_id" });
    }

    await ensureSession();

    try {
      const message = await get(
        "campaigns.getCampaignEmail",
        { gmail_id: gmailId },
        2,
        10_000,
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
  };
}

export default createInboxMessageHandler();
