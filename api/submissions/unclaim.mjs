import { unclaimPathA } from "./_lib/path-a.mjs";
import { unclaimPathB } from "./_lib/path-b.mjs";
import { bodyOf, requireHuman, sendError } from "./_lib/http.mjs";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (!(await requireHuman(req, res))) return;
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST_only" });
  const body = bodyOf(req);
  const path = String(body.path || "A").toUpperCase();
  const expected = path === "B"
    ? `UNCLAIM ${String(body.key || "").trim()}`
    : `UNCLAIM ${String(body.requestId || "").trim()}`;
  if (String(body.confirmation || "").trim() !== expected) {
    return res.status(400).json({ ok: false, error: "confirmation_required", detail: expected });
  }
  try {
    const input = { ...body, by: req.authedEmail || "team" };
    return res.status(200).json(path === "B" ? await unclaimPathB(input) : await unclaimPathA(input));
  } catch (error) {
    return sendError(res, error);
  }
}
