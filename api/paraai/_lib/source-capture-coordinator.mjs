// Runner-owned DARK Phase 4 source capture coordinator.
//
// The only runner request is exactly:
//   { mode: "phase4-source-capture-tick" }
//
// Source IDs, decision boundaries, cursors, limits, digests, retries, and
// force controls are selected by durable server state, never by the request.
// Only the sealed candidate-user alias artifact has an exact private source
// adapter. Recall, Paraform Human, and Human Intro remain unavailable, and
// this coordinator cannot open any Phase 4 release authority.

import {
  SOURCE_HUMAN_INTRO_ARTIFACT_DIGEST,
  SOURCE_IDENTITY_BINDING_IDENTITY_ARTIFACT_DIGEST,
  SOURCE_Q37_DISCRIMINATOR_ARTIFACT_DIGEST,
} from "./source-watermark.mjs";
import {
  claimDarkSourceCaptureStep,
  checkpointTrustedSourceCaptureEvent,
  ensureDarkSourceCaptureRun,
  sourceCaptureAggregateStatus,
  sourceCaptureStoreConfigured,
} from "./source-capture-store.mjs";
import {
  prepareIdentityAliasArtifact,
  readIdentityAliasArtifactHead,
  readIdentityAliasArtifactPage,
} from "./source-identity-artifact-store.mjs";
import {
  createSourceIdentityAliasAdapter,
} from "./source-identity-alias-adapter.mjs";

export const PHASE4_SOURCE_CAPTURE_TICK_MODE =
  "phase4-source-capture-tick";

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

function exactInterface(value, methods, code) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
  ) {
    fail(code);
  }
  const actual = Object.keys(value).sort();
  const expected = [...methods].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
    || methods.some((method) => typeof value[method] !== "function")
  ) {
    fail(code);
  }
  return value;
}

function selectedSource(record) {
  if (record?.status === "capturing") {
    return record.activeStep?.source ?? null;
  }
  if (record?.status === "verifying_heads") {
    return record.sources?.[record.headVerificationIndex]?.source
      ?? null;
  }
  return null;
}

const EMPTY_AGGREGATE = Object.freeze({
  commonRedisBoundary: false,
  requiredSources: 4,
  requiredPassesPerSource: 2,
  completedSources: 0,
  completedPasses: 0,
  verifiedHeads: 0,
  freshnessLeaseCurrent: false,
});

const DEFAULT_CAPTURE_STORE = Object.freeze({
  claimDarkSourceCaptureStep,
  checkpointTrustedSourceCaptureEvent,
  ensureDarkSourceCaptureRun,
  sourceCaptureAggregateStatus,
  sourceCaptureStoreConfigured,
});

const DEFAULT_IDENTITY_ARTIFACT_STORE = Object.freeze({
  prepareIdentityAliasArtifact,
  readIdentityAliasArtifactHead,
  readIdentityAliasArtifactPage,
});

// This factory is a narrow integration seam for deterministic contract tests.
// Neither dependency object is reachable from the runner request.
export function createPhase4SourceCaptureCoordinator({
  captureStore,
  identityArtifactStore,
}) {
  const trustedCaptureStore = exactInterface(
    captureStore,
    [
      "claimDarkSourceCaptureStep",
      "checkpointTrustedSourceCaptureEvent",
      "ensureDarkSourceCaptureRun",
      "sourceCaptureAggregateStatus",
      "sourceCaptureStoreConfigured",
    ],
    "SOURCE_CAPTURE_STORE_INTERFACE_INVALID",
  );
  const trustedIdentityArtifactStore = exactInterface(
    identityArtifactStore,
    [
      "prepareIdentityAliasArtifact",
      "readIdentityAliasArtifactHead",
      "readIdentityAliasArtifactPage",
    ],
    "SOURCE_IDENTITY_ARTIFACT_STORE_INTERFACE_INVALID",
  );
  const identityAliasClient = createSourceIdentityAliasAdapter({
    artifactStore: trustedIdentityArtifactStore,
  });

  // These are explicit release locks. The alias client is private and
  // hard-dark; the remaining sources and the shared post-capture head client
  // stay absent. Completing alias checkpoints cannot open Phase 4.
  const privateInterfaces = Object.freeze({
    recallPageClient: null,
    paraformHumanPageClient: null,
    humanIntroPageClient: null,
    identityAliasClient,
    sourceHeadClient: null,
  });

  function darkStatus({
    status,
    aggregate = EMPTY_AGGREGATE,
    storeConfigured = true,
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
        privateInterfaces,
      ),
      missingReleasePins: missingCount(RELEASE_PINS),
    });
  }

  function phase4SourceCaptureDarkStatusForCoordinator() {
    let configured;
    let aggregate;
    try {
      configured =
        trustedCaptureStore.sourceCaptureStoreConfigured();
      if (configured) {
        aggregate =
          trustedCaptureStore.sourceCaptureAggregateStatus();
      }
    } catch {
      return darkStatus({
        ok: false,
        status: "capture_step_failed_dark",
      });
    }
    if (!configured) {
      return darkStatus({
        ok: false,
        status: "store_unavailable",
        storeConfigured: false,
      });
    }
    return darkStatus({
      status: "capture_interfaces_unavailable",
      aggregate,
    });
  }

  async function runPhase4SourceCaptureTickForCoordinator(input) {
    request(input);
    let configured;
    try {
      configured =
        trustedCaptureStore.sourceCaptureStoreConfigured();
    } catch {
      return darkStatus({
        ok: false,
        status: "capture_step_failed_dark",
      });
    }
    if (!configured) {
      return darkStatus({
        ok: false,
        status: "store_unavailable",
        storeConfigured: false,
      });
    }
    let snapshot;
    let aggregate;
    try {
      snapshot =
        await trustedCaptureStore.ensureDarkSourceCaptureRun();
      aggregate =
        trustedCaptureStore.sourceCaptureAggregateStatus(
          snapshot,
        );
    } catch {
      // Durable parsing, store, adapter, and checkpoint failures collapse to
      // this one aggregate-only response. No upstream cause or private
      // evidence can escape into the runner response.
      return darkStatus({
        ok: false,
        status: "capture_step_failed_dark",
      });
    }
    if (selectedSource(snapshot.record) !== "aliases") {
      return darkStatus({
        status: "capture_interfaces_unavailable",
        aggregate,
      });
    }
    try {
      const claim =
        await trustedCaptureStore.claimDarkSourceCaptureStep();
      const claimSource = selectedSource(claim.record);
      if (claimSource !== "aliases") {
        fail("SOURCE_CAPTURE_SERVER_SELECTION_CHANGED");
      }
      const result = claim.record.status === "capturing"
        ? await identityAliasClient.readPage(claim)
        : await identityAliasClient.readHead(claim);
      const checkpointed = await trustedCaptureStore
        .checkpointTrustedSourceCaptureEvent(
          claim,
          result.checkpointEvent,
        );
      const checkpointedAggregate =
        trustedCaptureStore.sourceCaptureAggregateStatus(
          checkpointed,
        );
      return darkStatus({
        status: "identity_alias_step_checkpointed_dark",
        aggregate: checkpointedAggregate,
      });
    } catch {
      return darkStatus({
        ok: false,
        status: "capture_step_failed_dark",
        aggregate,
      });
    }
  }

  return Object.freeze({
    phase4SourceCaptureDarkStatus:
      phase4SourceCaptureDarkStatusForCoordinator,
    runPhase4SourceCaptureTick:
      runPhase4SourceCaptureTickForCoordinator,
  });
}

const DEFAULT_COORDINATOR = createPhase4SourceCaptureCoordinator({
  captureStore: DEFAULT_CAPTURE_STORE,
  identityArtifactStore: DEFAULT_IDENTITY_ARTIFACT_STORE,
});

export function phase4SourceCaptureDarkStatus() {
  return DEFAULT_COORDINATOR.phase4SourceCaptureDarkStatus();
}

export async function runPhase4SourceCaptureTick(input) {
  return DEFAULT_COORDINATOR.runPhase4SourceCaptureTick(input);
}
