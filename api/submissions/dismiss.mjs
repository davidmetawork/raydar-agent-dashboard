import { dismissPathA, undoDismissPathA } from "./_lib/path-a.mjs";
import { dismissPathB, undoDismissPathB } from "./_lib/path-b.mjs";
import { bodyOf, requireHuman, sendError } from "./_lib/http.mjs";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (!(await requireHuman(req, res))) return;
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST_only" });
  const body = bodyOf(req);
  const path = String(body.path || "A").toUpperCase();
  try {
    if (body.action === "undo") {
      const input = { ...body, by: req.authedEmail || "team" };
      return res.status(200).json(path === "B" ? await undoDismissPathB(input) : await undoDismissPathA(input));
    }
    const input = { ...body, action: "dismiss", by: req.authedEmail || "team" };
    return res.status(200).json(path === "B" ? await dismissPathB(input) : await dismissPathA(input));
  } catch (error) {
    return sendError(res, error);
  }
}
