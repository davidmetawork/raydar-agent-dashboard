// Runner-owned DARK Phase 4 source capture coordinator.
//
// The only runner request is exactly:
//   { mode: "phase4-source-capture-tick" }
//
// Source IDs, decision boundaries, cursors, limits, digests, retries, and
// force controls are selected by durable server state, never by the request.
// Exact private source clients are not captured in this repository yet, so
// this coordinator plans/resumes the durable journal and then stops closed.

import {
  SOURCE_HUMAN_INTRO_ARTIFACT_DIGEST,
  SOURCE_IDENTITY_BINDING_IDENTITY_ARTIFACT_DIGEST,
  SOURCE_Q37_DISCRIMINATOR_ARTIFACT_DIGEST,
} from "./source-watermark.mjs";
import {
  ensureDarkSourceCaptureRun,
  sourceCaptureAggregateStatus,
  sourceCaptureStoreConfigured,
} from "./source-capture-store.mjs";

export const PHASE4_SOURCE_CAPTURE_TICK_MODE =
  "phase4-source-capture-tick";

// These are explicit release locks. A future integration must replace each
// null with a reviewed immutable contract and then separately integrate the
// capture lease with source authority. Merely completing this dark journal
// cannot open Phase 4.
const CAPTURE_PRIVATE_INTERFACES = Object.freeze({
  recallPageClient: null,
  paraformHumanPageClient: null,
  humanIntroPageClient: null,
  identityAliasClient: null,
  sourceHeadClient: null,
});

const RELEASE_PINS = Object.freeze({
  identityCollector:
    SOURCE_IDENTITY_BINDING_IDENTITY_ARTIFACT_DIGEST,
  paraformHumanDiscriminator:
    SOURCE_Q37_DISCRIMINATOR_ARTIFACT_DIGEST,
  humanIntroSource:
    SOURCE_HUMAN_INTRO_ARTIFACT_DIGEST,
});

export class SourceCaptureCoordinatorError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "SourceCaptureCoordinatorError";
    this.code = code;
  }
}

function fail(code, message = code) {
  throw new SourceCaptureCoordinatorError(code, message);
}

function request(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(
      "SOURCE_CAPTURE_REQUEST_INVALID",
      "source capture request must be an object",
    );
  }
  const keys = Object.keys(value);
  if (
    keys.length !== 1
    || keys[0] !== "mode"
    || value.mode !== PHASE4_SOURCE_CAPTURE_TICK_MODE
  ) {
    fail(
      "SOURCE_CAPTURE_CALLER_PARAMETERS_FORBIDDEN",
      "source capture accepts only its exact runner mode",
    );
  }
  return value;
}

function missingCount(value) {
  return Object.values(value).filter((item) => item == null).length;
}

function darkStatus({
  status,
  aggregate = sourceCaptureAggregateStatus(),
  storeConfigured = sourceCaptureStoreConfigured(),
  ok = true,
}) {
  return Object.freeze({
    ok,
    status,
    operational: false,
    activationAvailable: false,
    writeAuthorityAvailable: false,
    curationAvailable: false,
    enrollmentAvailable: false,
    serverSelected: true,
    storeConfigured,
    commonRedisBoundary: aggregate.commonRedisBoundary,
    requiredSources: aggregate.requiredSources,
    requiredPassesPerSource:
      aggregate.requiredPassesPerSource,
    completedSources: aggregate.completedSources,
    completedPasses: aggregate.completedPasses,
    verifiedHeads: aggregate.verifiedHeads,
    freshnessLeaseCurrent:
      aggregate.freshnessLeaseCurrent,
    missingPrivateInterfaces: missingCount(
      CAPTURE_PRIVATE_INTERFACES,
    ),
    missingReleasePins: missingCount(RELEASE_PINS),
  });
}

export function phase4SourceCaptureDarkStatus() {
  if (!sourceCaptureStoreConfigured()) {
    return darkStatus({
      ok: false,
      status: "store_unavailable",
      storeConfigured: false,
    });
  }
  return darkStatus({
    status: "capture_interfaces_unavailable",
  });
}

export async function runPhase4SourceCaptureTick(input) {
  request(input);
  if (!sourceCaptureStoreConfigured()) {
    return darkStatus({
      ok: false,
      status: "store_unavailable",
      storeConfigured: false,
    });
  }
  let snapshot;
  let aggregate;
  try {
    snapshot = await ensureDarkSourceCaptureRun();
    aggregate = sourceCaptureAggregateStatus(snapshot);
  } catch {
    // Durable parse/validation failures include invariant errors and strict
    // shape TypeErrors. None may escape into a runner response.
    return darkStatus({
      ok: false,
      status: "capture_store_invalid",
    });
  }
  // The source calls deliberately do not exist yet. Persisting the
  // server-selected boundary/checkpoint is safe; advancing it from an
  // invented client contract is not.
  return darkStatus({
    status: "capture_interfaces_unavailable",
    aggregate,
  });
}
