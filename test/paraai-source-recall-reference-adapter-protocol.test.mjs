import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createSourceRecallReferencePersistenceAdapter,
} from "../api/paraai/_lib/source-recall-reference-persistence-adapter.mjs";
import {
  SOURCE_RECALL_REFERENCE_PRIVATE_PAGE_TTL_MS,
  createSourceRecallReferencePersistenceProtocol,
} from "../api/paraai/_lib/source-recall-reference-persistence-protocol.mjs";
import {
  collectRecallReferenceHeadStep,
} from "../api/paraai/_lib/source-recall-reference-collector.mjs";
import {
  SOURCE_RECALL_PAGE_VERSION,
} from "../api/paraai/_lib/source-recall-page-client.mjs";

const BOUNDARY = "2026-07-26T00:00:00.000Z";
const INITIAL_NOW_MS = Date.parse(BOUNDARY) + 10_000;
const MARKERS = Object.freeze({
  beginStage: "recall_reference_begin_stage_v2",
  cas: "recall_reference_final_cas_v2",
  ensure: "recall_reference_ensure_v1",
  readStage: "recall_reference_read_stage_v2",
  readOne: "recall_reference_read_one_v1",
  readPage: "recall_reference_read_page_v1",
  verify: "recall_reference_verify_metadata_set_v2",
  writeStage: "recall_reference_write_stage_v2",
});

function deepFreeze(value) {
  if (
    value
    && typeof value === "object"
    && !Object.isFrozen(value)
  ) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function redisTime(nowMs) {
  return [
    String(Math.floor(nowMs / 1_000)),
    String((nowMs % 1_000) * 1_000),
  ];
}

function response(result) {
  const body = JSON.stringify({ result });
  return new Response(body, {
    status: 200,
    headers: {
      "content-length": String(
        Buffer.byteLength(body, "utf8"),
      ),
      "content-type": "application/json",
    },
  });
}

function sha256(raw) {
  return createHash("sha256")
    .update(raw)
    .digest("hex");
}

function sha1(raw) {
  return createHash("sha1").update(raw).digest("hex");
}

function envelopeIsValid(
  raw,
  expectedPrefix = null,
  expectedNativeByteProof = null,
) {
  if (
    typeof raw !== "string"
    || raw.length < 80
    || !raw.startsWith("RRPG1|")
    || raw[79] !== "|"
    || (
      expectedPrefix !== null
      && !raw.startsWith(expectedPrefix)
    )
  ) {
    return false;
  }
  const length = Number.parseInt(raw.slice(71, 79), 16);
  return (
    Number.isSafeInteger(length)
    && Buffer.byteLength(raw, "utf8")
      === Buffer.byteLength(raw.slice(0, 80), "utf8") + length
    && (
      expectedNativeByteProof === null
      || sha1(raw.slice(80)) === expectedNativeByteProof
    )
  );
}

function fakeUpstash() {
  const clock = { nowMs: INITIAL_NOW_MS };
  const records = new Map();
  const events = [];

  function current(key) {
    const record = records.get(key);
    if (
      record?.expiresAtMs !== null
      && record?.expiresAtMs <= clock.nowMs
    ) {
      records.delete(key);
      return null;
    }
    return record ?? null;
  }

  function failed(currentRaw = "") {
    return [-9, currentRaw, ...redisTime(clock.nowMs)];
  }

  async function fetchImpl(_url, options) {
    const command = JSON.parse(options.body);
    assert.equal(command[0], "EVAL");
    const script = command[1];
    const marker = Object.values(MARKERS).find(
      (candidate) => script.includes(candidate),
    );
    assert.ok(marker, "every EVAL must carry its stable marker");
    const keyCount = Number(command[2]);
    const keys = command.slice(3, 3 + keyCount);
    const args = command.slice(3 + keyCount);
    events.push({ args, keys, marker });

    if (marker === MARKERS.ensure) {
      const existing = current(keys[0]);
      if (existing) {
        return response([
          0,
          existing.raw,
          ...redisTime(clock.nowMs),
        ]);
      }
      const stamped = args[0]
        .replace(
          "\"createdAtMs\":0",
          `"createdAtMs":${clock.nowMs}`,
        )
        .replace(
          "\"updatedAtMs\":0",
          `"updatedAtMs":${clock.nowMs}`,
        );
      records.set(keys[0], {
        expiresAtMs: null,
        raw: stamped,
      });
      return response([
        1,
        stamped,
        ...redisTime(clock.nowMs),
      ]);
    }

    if (marker === MARKERS.readOne) {
      return response([
        current(keys[0])?.raw ?? "",
        ...redisTime(clock.nowMs),
      ]);
    }

    if (marker === MARKERS.readPage) {
      const stored = current(keys[0]);
      if (!stored || stored.expiresAtMs === null) {
        return response(["", "", ...redisTime(clock.nowMs)]);
      }
      return response([
        stored.raw,
        String(stored.expiresAtMs),
        ...redisTime(clock.nowMs),
      ]);
    }

    if (marker === MARKERS.beginStage) {
      if (current(keys[0])) {
        return response([
          0,
          "",
          "",
          "",
          ...redisTime(clock.nowMs),
        ]);
      }
      const notAfterMs = args[2] === ""
        ? null
        : Number(args[2]);
      if (
        notAfterMs !== null
        && clock.nowMs >= notAfterMs
      ) {
        return response([
          -2,
          "",
          "",
          "",
          ...redisTime(clock.nowMs),
        ]);
      }
      const fence = Number(current(keys[1])?.raw ?? "0") + 1;
      records.set(keys[1], {
        expiresAtMs: null,
        raw: String(fence),
      });
      const expiresAtMs = Math.min(
        clock.nowMs + Number(args[4]),
        notAfterMs ?? Number.MAX_SAFE_INTEGER,
      );
      const writerRaw =
        `${args[0]}|${fence}|${args[1]}|${expiresAtMs}`;
      records.set(keys[0], { expiresAtMs, raw: writerRaw });
      records.set(keys[2], {
        expiresAtMs,
        raw: args[3],
      });
      return response([
        1,
        String(fence),
        String(expiresAtMs),
        writerRaw,
        ...redisTime(clock.nowMs),
      ]);
    }

    if (marker === MARKERS.writeStage) {
      const writer = current(keys[0]);
      const expiresAtMs = Number(args[1]);
      if (
        !writer
        || writer.raw !== args[0]
        || writer.expiresAtMs !== expiresAtMs
      ) {
        return response([-2, ...redisTime(clock.nowMs)]);
      }
      const existing = current(keys[1]);
      if (
        existing
        && (
          existing.raw !== args[2]
          || existing.expiresAtMs !== expiresAtMs
        )
      ) {
        return response([-9, ...redisTime(clock.nowMs)]);
      }
      records.set(keys[1], {
        expiresAtMs,
        raw: args[2],
      });
      return response([
        existing ? 0 : 1,
        ...redisTime(clock.nowMs),
      ]);
    }

    if (marker === MARKERS.readStage) {
      const writer = current(keys[0]);
      const stage = current(keys[1]);
      const expiresAtMs = Number(args[1]);
      if (
        !writer
        || writer.raw !== args[0]
        || writer.expiresAtMs !== expiresAtMs
        || !stage
        || stage.expiresAtMs !== expiresAtMs
      ) {
        return response(["", ...redisTime(clock.nowMs)]);
      }
      return response([stage.raw, ...redisTime(clock.nowMs)]);
    }

    if (marker === MARKERS.cas) {
      {
        const run = current(keys[0]);
        const cleanup = () => {
          records.delete(keys[1]);
          records.delete(keys[2]);
          records.delete(keys[3]);
        };
        if (!run || run.raw !== args[0]) {
          cleanup();
          return response([
            -1,
            run?.raw ?? "",
            ...redisTime(clock.nowMs),
          ]);
        }
        const deadline = args[7] === ""
          ? null
          : Number(args[7]);
        if (
          deadline !== null
          && clock.nowMs >= deadline
        ) {
          cleanup();
          return response([
            -2,
            run.raw,
            ...redisTime(clock.nowMs),
          ]);
        }
        const leaseExpiresAtMs = Number(args[2]);
        const writer = current(keys[1]);
        const runStage = current(keys[2]);
        if (
          !writer
          || writer.raw !== args[1]
          || writer.expiresAtMs !== leaseExpiresAtMs
          || !runStage
          || runStage.expiresAtMs !== leaseExpiresAtMs
          || !runStage.raw.startsWith(args[3])
          || Buffer.byteLength(runStage.raw, "utf8")
            !== Number(args[4])
          || sha1(runStage.raw) !== args[14]
        ) {
          cleanup();
          return response(failed(run.raw));
        }
        const nextRaw = runStage.raw.slice(args[3].length);
        if (clock.nowMs < Number(args[18])) {
          cleanup();
          return response(failed(run.raw));
        }
        const pageKeyIndex = Number(args[10]);
        const headKeyIndex = Number(args[11]);
        const requiredCount = Number(args[13]);
        const pageExpiresAtMs = args[8] === ""
          ? null
          : Number(args[8]);
        const pageTtlMs = args[9] === ""
          ? null
          : Number(args[9]);
        const pageStage = pageKeyIndex > 0
          ? current(keys[3])
          : null;
        if (
          pageKeyIndex > 0
          && (
            !pageStage
            || pageStage.expiresAtMs !== leaseExpiresAtMs
            || !pageStage.raw.startsWith(args[5])
            || Buffer.byteLength(pageStage.raw, "utf8")
              !== Number(args[6])
            || sha1(pageStage.raw) !== args[15]
            || !envelopeIsValid(
              pageStage.raw,
              args[5],
              args[17],
            )
            || pageExpiresAtMs <= clock.nowMs
            || pageExpiresAtMs
              > clock.nowMs + pageTtlMs
          )
        ) {
          cleanup();
          return response(failed(run.raw));
        }
        const selectedPageKey = pageKeyIndex > 0
          ? keys[pageKeyIndex - 1]
          : null;
        const selectedHeadKey = headKeyIndex > 0
          ? keys[headKeyIndex - 1]
          : null;
        const existingPage = selectedPageKey
          ? current(selectedPageKey)
          : null;
        const existingHead = selectedHeadKey
          ? current(selectedHeadKey)
          : null;
        if (
          existingPage
          && (
            !envelopeIsValid(
              existingPage.raw,
              args[5],
              args[17],
            )
            || existingPage.expiresAtMs !== pageExpiresAtMs
          )
        ) {
          cleanup();
          return response(failed(run.raw));
        }
        if (
          existingHead
          && existingHead.raw !== args[12]
        ) {
          cleanup();
          return response(failed(run.raw));
        }

        assert.equal(args[16], sha256(nextRaw));
        let offset = 19;
        for (
          let index = 0;
          index < requiredCount;
          index += 1
        ) {
          const requiredKeyIndex = Number(args[offset]);
          const expectedPrefix = args[offset + 1];
          const expectedNativeByteProof = args[offset + 2];
          const expectedExpiresAtMs =
            Number(args[offset + 3]);
          const minimumRemainingTtlMs =
            Number(args[offset + 4]);
          offset += 5;
          const requiredKey = keys[requiredKeyIndex - 1];
          const stored = current(requiredKey);
          const candidate = stored ?? (
            requiredKey === selectedPageKey
              ? {
                expiresAtMs: pageExpiresAtMs,
                raw: pageStage?.raw,
              }
              : null
          );
          if (
            !candidate
            || !envelopeIsValid(
              candidate.raw,
              expectedPrefix,
              expectedNativeByteProof,
            )
            || candidate.expiresAtMs
              !== expectedExpiresAtMs
            || candidate.expiresAtMs - clock.nowMs
              < minimumRemainingTtlMs
          ) {
            cleanup();
            return response(failed(run.raw));
          }
        }

        if (selectedPageKey && !existingPage) {
          records.set(selectedPageKey, {
            expiresAtMs: pageExpiresAtMs,
            raw: pageStage.raw,
          });
        }
        if (selectedHeadKey && !existingHead) {
          records.set(selectedHeadKey, {
            expiresAtMs: null,
            raw: args[12],
          });
        }
        records.set(keys[0], {
          expiresAtMs: null,
          raw: nextRaw,
        });
        cleanup();
        return response([
          1,
          sha256(nextRaw),
          ...redisTime(clock.nowMs),
        ]);
      }
    }

    assert.equal(marker, MARKERS.verify);
    const run = current(keys[0]);
    const head = current(keys[1]);
    const requiredCount = Number(args[2]);
    let matches = (
      run?.raw === args[0]
      && head?.raw === args[1]
      && requiredCount === keys.length - 2
    );
    let offset = 3;
    for (let index = 0; index < requiredCount; index += 1) {
      const page = current(keys[index + 2]);
      const expectedPrefix = args[offset];
      const expectedNativeByteProof = args[offset + 1];
      const expectedExpiresAtMs = Number(args[offset + 2]);
      const minimumRemainingTtlMs = Number(args[offset + 3]);
      offset += 4;
      matches = matches && Boolean(
        page
        && envelopeIsValid(
          page.raw,
          expectedPrefix,
          expectedNativeByteProof,
        )
        && page.expiresAtMs === expectedExpiresAtMs
        && page.expiresAtMs - clock.nowMs
          >= minimumRemainingTtlMs,
      );
    }
    return response([
      matches ? 1 : 0,
      ...redisTime(clock.nowMs),
    ]);
  }

  return {
    clock,
    events,
    fetchImpl,
    records,
  };
}

function adapterFor(harness) {
  return createSourceRecallReferencePersistenceAdapter({
    fetchImpl: harness.fetchImpl,
    token: "synthetic-test-token-with-no-production-authority",
    url: "https://synthetic-private-kv.invalid",
  });
}

function context() {
  return {
    contractPinsDigest: "b".repeat(64),
    decisionBoundaryAtMs: Date.parse(BOUNDARY),
    runNonceDigest: "a".repeat(64),
  };
}

function sourcePage() {
  return deepFreeze({
    boundaryAt: BOUNDARY,
    exhausted: true,
    nextCursor: null,
    references: [{
      candidate: {
        email: "synthetic.reference@example.invalid",
        fullName: "Synthetic Reference",
        linkedin: "https://example.invalid/synthetic-reference",
        paraformEventId: "synthetic-event-reference",
      },
      id: "bot_synthetic_reference",
      joinAt: "2026-07-25T23:00:00.000Z",
      metadataSource: "paraform-auto",
    }],
    scanned: 1,
    version: SOURCE_RECALL_PAGE_VERSION,
  });
}

function dependencies(protocol, readSourcePage) {
  return Object.freeze({
    claimRecallReferencePageImpl:
      protocol.claimRecallReferencePage,
    checkpointRecallReferencePageImpl:
      protocol.checkpointRecallReferencePage,
    readPrivateRecallSourcePageImpl: readSourcePage,
    recordRecallReferencePageFailureImpl:
      protocol.recordRecallReferencePageFailure,
  });
}

async function sealedFixture() {
  const harness = fakeUpstash();
  const protocol = createSourceRecallReferencePersistenceProtocol({
    persistence: adapterFor(harness),
  });
  const { work } = await protocol.ensureRecallReferenceRun(
    context(),
  );
  let providerReads = 0;
  const collector = dependencies(protocol, async () => {
    providerReads += 1;
    return sourcePage();
  });
  const first = await collectRecallReferenceHeadStep(
    work,
    collector,
  );
  assert.equal(first.status, "collecting");
  const second = await collectRecallReferenceHeadStep(
    work,
    collector,
  );
  assert.equal(second.status, "sealed_unpinnable");
  assert.equal(providerReads, 2);
  return { harness, protocol, work };
}

function onlyKey(records, fragment) {
  const keys = [...records.keys()].filter(
    (key) => key.includes(fragment),
  );
  assert.equal(keys.length, 1);
  return keys[0];
}

test("the production adapter drives the real two-pass protocol and restart replay without renewing private TTLs", async () => {
  const { harness, work } = await sealedFixture();
  const runKey = onlyKey(harness.records, ":run:v1:");
  const headKey = onlyKey(harness.records, ":head:v1:");
  const secondPassPageKey = [...harness.records.keys()].find(
    (key) => key.includes(":page:v1:") && key.endsWith(":2:1"),
  );
  assert.equal(typeof secondPassPageKey, "string");
  const originalExpiry =
    harness.records.get(secondPassPageKey).expiresAtMs;
  const originalPageRaw =
    harness.records.get(secondPassPageKey).raw;

  harness.clock.nowMs += 1_234;
  const restartEventIndex = harness.events.length;
  const restarted =
    createSourceRecallReferencePersistenceProtocol({
      persistence: adapterFor(harness),
    });
  const head = await restarted.readRecallReferenceHead(work);
  assert.equal(head.record.passCount, 2);
  assert.equal(head.record.pageCount, 1);
  assert.equal(
    harness.records.get(secondPassPageKey).expiresAtMs,
    originalExpiry,
  );
  assert.equal(
    originalExpiry - harness.clock.nowMs,
    SOURCE_RECALL_REFERENCE_PRIVATE_PAGE_TTL_MS - 1_234,
  );

  const restartEvents = harness.events.slice(
    restartEventIndex,
  );
  assert.deepEqual(
    restartEvents.map((event) => event.marker),
    [
      MARKERS.readOne,
      MARKERS.readOne,
      MARKERS.verify,
    ],
  );
  const proof = restartEvents.at(-1);
  assert.deepEqual(proof.keys, [
    runKey,
    headKey,
    secondPassPageKey,
  ]);
  assert.equal(proof.args[0], harness.records.get(runKey).raw);
  assert.equal(proof.args[1], harness.records.get(headKey).raw);
  assert.equal(proof.args[3], originalPageRaw.slice(0, 71));
  assert.equal(proof.args[4], sha1(originalPageRaw.slice(80)));
  assert.equal(proof.args.includes(originalPageRaw), false);
  assert.equal(
    Number(proof.args[5]),
    originalExpiry,
  );
});

test("sealed replay fails closed before provider I/O when exact private bytes are tampered or expired", async () => {
  for (
    const fault of ["same_length_tamper", "empty", "expiry"]
  ) {
    const { harness, work } = await sealedFixture();
    const secondPassPageKey = [...harness.records.keys()].find(
      (key) => key.includes(":page:v1:") && key.endsWith(":2:1"),
    );
    assert.equal(typeof secondPassPageKey, "string");
    if (fault === "same_length_tamper") {
      const stored = harness.records.get(secondPassPageKey);
      const last = stored.raw.at(-1);
      harness.records.set(secondPassPageKey, {
        ...stored,
        raw: `${stored.raw.slice(0, -1)}${
          last === "x" ? "y" : "x"
        }`,
      });
    } else if (fault === "empty") {
      const stored = harness.records.get(secondPassPageKey);
      harness.records.set(secondPassPageKey, {
        ...stored,
        raw: "",
      });
    } else {
      harness.clock.nowMs +=
        SOURCE_RECALL_REFERENCE_PRIVATE_PAGE_TTL_MS + 1;
    }

    const restarted =
      createSourceRecallReferencePersistenceProtocol({
        persistence: adapterFor(harness),
      });
    let providerReads = 0;
    const aggregate = await collectRecallReferenceHeadStep(
      work,
      dependencies(restarted, async () => {
        providerReads += 1;
        throw new Error("provider I/O must remain unreachable");
      }),
    );
    assert.equal(aggregate.status, "invalidated");
    assert.equal(aggregate.headSealed, false);
    assert.equal(providerReads, 0);
    const runKey = onlyKey(harness.records, ":run:v1:");
    assert.equal(
      JSON.parse(harness.records.get(runKey).raw).invalidReason,
      "sealed_artifact_verification_failed",
    );
  }
});
