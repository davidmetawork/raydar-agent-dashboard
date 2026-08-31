import { requireMasterInboxAuth, privateJson, proxy, relay, requestBody, sessionProof } from "./_lib/core.mjs";
export default async function handler(req, res) {
  privateJson(res);
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method_not_allowed" });
  if (!(await requireMasterInboxAuth(req, res))) return;
  try {
    const input = requestBody(req);
    if (input.action !== "cancel") input.sessionProof = sessionProof({ actor: req.authedEmail, draftId: input.draftId, revision: input.revision, scheduledFor: input.scheduledFor, sessionExpiresAt: req.masterInboxSessionExpiresAt });
    return relay(res, await proxy(req, "/api/send", { method: "POST", body: input }));
  } catch (error) { return res.status(Number(error?.status) || 400).json({ ok: false, error: error?.message || "send_request_invalid" }); }
}
