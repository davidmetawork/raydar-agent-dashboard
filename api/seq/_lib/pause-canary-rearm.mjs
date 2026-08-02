import { createHash, createHmac, randomUUID } from "node:crypto";

import {
  campaignLeadBySearch,
  trpcPost,
  withThrottleRetry,
} from "./core.mjs";
import {
  K,
  kvGet,
  kvGetMany,
  raydarPauseCanaryIdentityFingerprint,
} from "./booking-stop.mjs";
import {
  loadPublishedBookingMembershipSnapshot,
} from "./booking-membership-snapshot.mjs";
import {
  RAYDAR_BOOKING_HOOK_PATH,
} from "./raydar-booking-contract.mjs";
import {
  handleRaydarBookingWebhook,
} from "../raydar-booking-hook.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const BARE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

const clean = (value) => String(value ?? "").trim();
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function loadCurrentMembershipSnapshot() {
  const current = await kvGet(K.membershipCurrent);
  const binding = current?.scope;
  if (
    !binding
    || !Array.isArray(binding.selectedSequenceIds)
  ) {
    return null;
  }
  const scope = {
    schema: binding.schema,
    scopeDigest: binding.digest,
    catalogFloor: binding.catalogFloor,
    complete: true,
    sequences: binding.selectedSequenceIds.map((id) => ({ id })),
    catalogSequences: binding.catalogSequenceCount,
    scannedSequences: binding.catalogSequenceCount,
    linkSequences: binding.linkSequenceCount,
    enabledLinkSequences: binding.enabledLinkSequenceCount,
    coveredEnabledLinkSequences: binding.coveredEnabledLinkSequenceCount,
  };
  return loadPublishedBookingMembershipSnapshot({
    scope,
    read: kvGet,
    readMany: kvGetMany,
  });
}

function leadEmails(lead) {
  return new Set([
    lead?.to_use_email,
    ...(Array.isArray(lead?.user_emails) ? lead.user_emails : []),
  ].map((value) => clean(value).toLowerCase()).filter((value) =>
    BARE_EMAIL.test(value)));
}

async function refreshCanaryThroughSignedWebhook({ email, env, nowMs }) {
  const secret = clean(env.RAYDAR_SCHEDULER_WEBHOOK_SECRET);
  const now = new Date(nowMs);
  const startsAt = new Date(nowMs + 24 * 60 * 60 * 1_000);
  const endsAt = new Date(startsAt.getTime() + 15 * 60 * 1_000);
  const suffix = randomUUID().replaceAll("-", "");
  const body = {
    schema: "raydar-booking-event-v1",
    event: "booking.confirmed",
    eventId: `bevt_canary_${suffix}`,
    occurredAt: now.toISOString(),
    bookingId: `bk_canary_${suffix}`,
    callType: "agent",
    candidate: { email, name: "Raydar Canary" },
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    bookedAt: now.toISOString(),
    sourceAttribution: "operator_pause_canary",
    status: "confirmed",
    supersedesBookingId: null,
  };
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(nowMs / 1_000));
  const canonical = `${timestamp}\nPOST\n${RAYDAR_BOOKING_HOOK_PATH}\n${raw}`;
  const signature = createHmac("sha256", secret)
    .update(canonical)
    .digest("hex");
  const request = new Request(
    `https://monitor.raydar.xyz${RAYDAR_BOOKING_HOOK_PATH}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-raydar-timestamp": timestamp,
        "x-raydar-event-id": body.eventId,
        "x-raydar-signature": `v1=${signature}`,
      },
      body: raw,
    },
  );
  const response = await handleRaydarBookingWebhook(request, {
    enabled: true,
    secret,
    pauseCanaryFingerprint:
      env.RAYDAR_BOOKING_PAUSE_CANARY_FINGERPRINT,
    nowMs,
  });
  const result = await response.json().catch(() => null);
  if (
    response.status !== 202
    || result?.ok !== true
    || result.apply !== true
    || result.deferred !== false
    || !Number.isInteger(result.matched)
    || result.matched < 1
    || !Number.isInteger(result.paused)
    || result.paused < 1
  ) {
    throw codedError("PAUSE_CANARY_REARM_REFRESH_FAILED");
  }
  return true;
}

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
  loadSnapshotImpl = loadCurrentMembershipSnapshot,
  searchImpl = campaignLeadBySearch,
  updateImpl = (ccuId) => withThrottleRetry(() =>
    trpcPost("campaigns.updateCandidatePauseStatus", {
      campaign_to_candidate_user_id: ccuId,
      is_paused: false,
    }, 1)),
  refreshImpl = refreshCanaryThroughSignedWebhook,
  nowMs = Date.now(),
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

  const snapshot = await loadSnapshotImpl();
  if (
    snapshot?.ok !== true
    || snapshot.complete !== true
    || !Array.isArray(snapshot.perSequence)
  ) {
    throw codedError("PAUSE_CANARY_REARM_INDEX_INVALID");
  }

  const identityEntries = new Map();
  for (const group of snapshot.perSequence) {
    const sequenceId = clean(group?.seq?.id);
    if (!sequenceId || !Array.isArray(group?.leads)) {
      throw codedError("PAUSE_CANARY_REARM_INDEX_INVALID");
    }
    for (const lead of group.leads) {
      const ccuId = clean(lead?.ccu_id);
      if (!ccuId || lead?.is_archived === true) continue;
      for (const email of leadEmails(lead)) {
        if (
          (identityDigest && sha256(email) !== identityDigest)
          || raydarPauseCanaryIdentityFingerprint({ secret, email })
            !== configuredFingerprint
        ) {
          continue;
        }
        const entries = identityEntries.get(email) ?? [];
        entries.push({ sequenceId, ccuId });
        identityEntries.set(email, entries);
      }
    }
  }
  if (identityEntries.size !== 1) {
    throw codedError("PAUSE_CANARY_REARM_IDENTITY_MISMATCH");
  }
  const [[email, entries]] = identityEntries;

  const candidates = [];
  for (const { sequenceId, ccuId } of entries) {
    const row = await searchImpl(sequenceId, email, {
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
  const alreadyRearmed = selected.row.is_paused !== true;
  if (!alreadyRearmed) {
    await updateImpl(selected.ccuId);
    const readback = await searchImpl(
      selected.sequenceId,
      email,
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
  }
  await refreshImpl({ email, env, nowMs });
  const finalReadback = await searchImpl(
    selected.sequenceId,
    email,
    { expectedCcuId: selected.ccuId },
  );
  if (
    !finalReadback
    || clean(finalReadback.ccu_id) !== selected.ccuId
    || finalReadback.is_paused !== true
    || finalReadback.is_archived === true
  ) {
    throw codedError("PAUSE_CANARY_REARM_REFRESH_FAILED");
  }
  return Object.freeze({
    ok: true,
    rearmed: alreadyRearmed ? 0 : 1,
    alreadyRearmed,
    refreshed: 1,
    leadsVerified: 1,
  });
}
