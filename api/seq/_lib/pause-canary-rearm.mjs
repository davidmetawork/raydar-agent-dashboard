import { createHash } from "node:crypto";

import {
  campaignLeadBySearch,
  trpcPost,
  withThrottleRetry,
} from "./core.mjs";
import {
  K,
  kvGet,
  raydarPauseCanaryIdentityFingerprint,
} from "./booking-stop.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const BARE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

const clean = (value) => String(value ?? "").trim();
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/**
 * Re-arm only the preconfigured no-send pause canary. Ordinary candidates can
 * never be selected: the address must match the independently configured HMAC
 * fingerprint, and exactly one current Paraform lead must read back as the
 * expected row. An operator-supplied digest can narrow the identity further,
 * but is not needed when the configured fingerprint resolves uniquely.
 */
export async function rearmRaydarPauseCanary({
  identitySha256,
  env = process.env,
  readIndexImpl = () => kvGet(K.leadIndex),
  searchImpl = campaignLeadBySearch,
  updateImpl = (ccuId) => withThrottleRetry(() =>
    trpcPost("campaigns.updateCandidatePauseStatus", {
      campaign_to_candidate_user_id: ccuId,
      is_paused: false,
    }, 1)),
} = {}) {
  const identityDigest = clean(identitySha256).toLowerCase();
  const secret = clean(env.RAYDAR_SCHEDULER_WEBHOOK_SECRET);
  const configuredFingerprint = clean(
    env.RAYDAR_BOOKING_PAUSE_CANARY_FINGERPRINT,
  ).toLowerCase();
  if (
    (identityDigest && !SHA256.test(identityDigest))
    || secret.length < 32
    || !SHA256.test(configuredFingerprint)
  ) {
    throw codedError("PAUSE_CANARY_REARM_CONFIG_INVALID");
  }

  const index = await readIndexImpl();
  if (
    !index
    || typeof index !== "object"
    || !index.byEmail
    || typeof index.byEmail !== "object"
    || Array.isArray(index.byEmail)
  ) {
    throw codedError("PAUSE_CANARY_REARM_INDEX_INVALID");
  }

  const identities = [];
  for (const [rawEmail, rawEntries] of Object.entries(index.byEmail)) {
    const email = clean(rawEmail).toLowerCase();
    if (
      !BARE_EMAIL.test(email)
      || (identityDigest && sha256(email) !== identityDigest)
      || raydarPauseCanaryIdentityFingerprint({ secret, email })
        !== configuredFingerprint
    ) {
      continue;
    }
    if (!Array.isArray(rawEntries)) {
      throw codedError("PAUSE_CANARY_REARM_INDEX_INVALID");
    }
    identities.push({ email, entries: rawEntries });
  }
  if (identities.length !== 1) {
    throw codedError("PAUSE_CANARY_REARM_IDENTITY_MISMATCH");
  }

  const candidates = [];
  for (const entry of identities[0].entries) {
    const sequenceId = clean(entry?.s);
    const ccuId = clean(entry?.ccu);
    if (!sequenceId || !ccuId) {
      throw codedError("PAUSE_CANARY_REARM_INDEX_INVALID");
    }
    const row = await searchImpl(sequenceId, identities[0].email, {
      expectedCcuId: ccuId,
    });
    if (!row || clean(row.ccu_id) !== ccuId || row.is_archived === true) {
      continue;
    }
    candidates.push({ sequenceId, ccuId, row });
  }
  if (candidates.length !== 1) {
    throw codedError("PAUSE_CANARY_REARM_LEAD_AMBIGUOUS");
  }

  const selected = candidates[0];
  if (selected.row.is_paused !== true) {
    return Object.freeze({
      ok: true,
      rearmed: 0,
      alreadyRearmed: true,
      leadsVerified: 1,
    });
  }

  await updateImpl(selected.ccuId);
  const readback = await searchImpl(
    selected.sequenceId,
    identities[0].email,
    { expectedCcuId: selected.ccuId },
  );
  if (
    !readback
    || clean(readback.ccu_id) !== selected.ccuId
    || readback.is_paused !== false
    || readback.is_archived === true
  ) {
    throw codedError("PAUSE_CANARY_REARM_READBACK_FAILED");
  }
  return Object.freeze({
    ok: true,
    rearmed: 1,
    alreadyRearmed: false,
    leadsVerified: 1,
  });
}
