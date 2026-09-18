import { withParaformTelemetrySource } from "../_lib/paraform-telemetry-context.mjs";
import { readSubmissionCredits } from "../paraai/_lib/interest.mjs";
import { requireHuman, sendError } from "./_lib/http.mjs";
import { paraformBackgroundPauseState } from "../_lib/paraform-background-pause.mjs";

export const config = { maxDuration: 30 };

export async function handleSubmissionCredits(req, res, {
  pauseState = () => paraformBackgroundPauseState("dashboardReaders"),
  auth = requireHuman,
  readCredits = readSubmissionCredits,
} = {}) {
  if (!(await auth(req, res))) return;
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "GET_only" });
  const backgroundPause = await pauseState()
    .catch(() => ({ paused: true, state: "unreadable" }));
  if (backgroundPause?.paused) {
    res.setHeader("Retry-After", "300");
    return res.status(503).json({
      ok: false,
      paused: true,
      error: "paraform_background_paused",
      control_state: backgroundPause.state || "unreadable",
    });
  }
  try {
    return res.status(200).json({ ok: true, credits: await readCredits() });
  } catch (error) {
    return sendError(res, error);
  }
}

async function handleRequest(req, res) {
  return handleSubmissionCredits(req, res);
}

export default function handler(req, res) {
  return withParaformTelemetrySource("submissions-v1", () => handleRequest(req, res));
}
