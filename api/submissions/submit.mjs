import { previewPathA, submitPathA } from "./_lib/path-a.mjs";
import { previewPathB, submitPathB } from "./_lib/path-b.mjs";
import { bodyOf, requireHuman, sendError } from "./_lib/http.mjs";

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  if (!(await requireHuman(req, res))) return;
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST_only" });
  const body = bodyOf(req);
  const action = String(body.action || "");
  const path = String(body.path || "A").toUpperCase();
  try {
    if (action === "preview") {
      return res.status(200).json(path === "B" ? await previewPathB(body) : await previewPathA(body));
    }
    if (action === "submit") {
      const input = { ...body, by: req.authedEmail || "team" };
      return res.status(200).json(path === "B" ? await submitPathB(input) : await submitPathA(input));
    }
    return res.status(400).json({ ok: false, error: "unknown_action", detail: "preview or submit" });
  } catch (error) {
    return sendError(res, error);
  }
}
