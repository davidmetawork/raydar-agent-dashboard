import { readSubmissionCredits } from "../paraai/_lib/interest.mjs";
import { requireHuman, sendError } from "./_lib/http.mjs";

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (!(await requireHuman(req, res))) return;
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "GET_only" });
  try {
    return res.status(200).json({ ok: true, credits: await readSubmissionCredits() });
  } catch (error) {
    return sendError(res, error);
  }
}

