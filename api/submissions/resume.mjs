import {
  attachResume,
  generateResume,
  loadResume,
  readArtifactForHttp,
} from "./_lib/resume.mjs";
import { bodyOf, requireHuman, sendError } from "./_lib/http.mjs";

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  if (!(await requireHuman(req, res))) return;
  try {
    if (req.method === "GET") {
      const artifact = await readArtifactForHttp(req.query || {});
      res.setHeader("Content-Type", artifact.contentType);
      res.setHeader("Content-Disposition", `inline; filename="${artifact.filename}"`);
      res.setHeader("Cache-Control", "private, no-store, max-age=0");
      return res.status(200).send(artifact.bytes);
    }
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "GET_or_POST_only" });
    }
    const body = bodyOf(req);
    const input = { ...body, by: req.authedEmail || "team" };
    if (body.action === "load") return res.status(200).json(await loadResume(input));
    if (["generate", "revise"].includes(body.action)) {
      return res.status(200).json(await generateResume(input));
    }
    if (body.action === "attach") return res.status(200).json(await attachResume(input));
    return res.status(400).json({
      ok: false,
      error: "unknown_action",
      detail: "load, generate, revise or attach",
    });
  } catch (error) {
    return sendError(res, error);
  }
}
