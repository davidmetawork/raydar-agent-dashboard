import { authConfig, cors, hasParaformCookie, listSequences, paraAIConfig, trpcGet } from "./_lib/core.mjs";
import { storeConfigured } from "./_lib/store.mjs";

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "GET only" });
  const config = paraAIConfig();
  const auth = authConfig();
  const health = {
    ok: false,
    generatedAt: new Date().toISOString(),
    authRequired: auth.authRequired,
    googleClientId: auth.googleClientId,
    allowedDomains: auth.allowedDomains,
    storeConfigured: storeConfigured(),
    anthropicConfigured: config.anthropicConfigured,
    openaiConfigured: config.openaiConfigured,
    extractorConfigured: config.extractorConfigured,
    lifecycleRegistrationConfigured: config.lifecycleRegistrationConfigured,
    submitApproved: config.submitApproved,
    enrollApproved: config.enrollApproved,
    dryRun: config.dryRun,
    submissionOriginPinned: config.submissionOriginPinned,
    matchReadPinned: config.matchReadPinned,
    paraform: "checking",
    talentNetwork: null,
    quota: null,
    sequences: [],
    submitReady: false,
    enrollmentReady: false,
  };
  if (!(await hasParaformCookie())) {
    health.paraform = "no_cookie";
    return res.status(200).json(health);
  }
  try {
    const [sequences, talentNetwork, quota] = await Promise.all([
      listSequences(),
      trpcGet("submissionRequest.getRecruiterParaAIStatus", {}).catch((error) => ({ error: String(error?.message || error) })),
      trpcGet("agency.getTalentNetworkDirectSubmitQuota", {}).catch(() => null),
    ]);
    health.paraform = "live";
    health.talentNetwork = talentNetwork;
    health.quota = quota;
    const required = [
      "New Matches - Added to Para AI (one role)",
      "New Matches - Added to Para AI (multiple)",
      "No Matches - Added to Para AI",
    ];
    health.sequences = required.map((name) => {
      const row = sequences.find((sequence) => sequence?.name === name);
      return { name, id: row?.id || null, found: Boolean(row), enabled: Boolean(row?.enabled) };
    });
    const networkEnabled = talentNetwork?.isTalentNetworkEnabled === true && talentNetwork?.isParaAIDisabled !== true;
    health.submitReady = Boolean(
      health.storeConfigured && health.extractorConfigured && health.submissionOriginPinned &&
      health.submitApproved && !health.dryRun && networkEnabled,
    );
    health.enrollmentReady = Boolean(
      health.submitReady && health.lifecycleRegistrationConfigured && health.matchReadPinned &&
      health.enrollApproved && health.sequences.every((sequence) => sequence.found && sequence.enabled),
    );
    health.ok = health.submitReady;
    return res.status(200).json(health);
  } catch (error) {
    health.paraform = error?.code === "AUTH_EXPIRED" ? "expired" : "error";
    health.error = String(error?.message || error).slice(0, 220);
    return res.status(200).json(health);
  }
}
