import { cors, sourcingConfig } from "./_lib/core.mjs";
import { storeConfigured } from "./_lib/store.mjs";

// Public bootstrap metadata only. No Paraform request and no secret values.
export default function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "GET only" });
  return res.status(200).json({ ok: true, ...sourcingConfig(), stateStoreConfigured: storeConfigured() });
}
