import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { K } from "../api/applicants/_lib/kv.mjs";
import { coreGenerationDigest } from "../api/applicants/_lib/generation.mjs";
import {
  MONITOR_CHUNK_BYTES,
  MONITOR_CHUNK_VERSION,
} from "../api/applicants/_lib/transport-chunks.mjs";
import { createSyncHandler } from "../api/applicants/sync.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function chunked(body) {
  const decoded = Buffer.from(JSON.stringify(body));
  const compressed = gzipSync(decoded, { level: 9 });
  const manifest = {
    version: MONITOR_CHUNK_VERSION,
    codec: "gzip-base64",
    decodedBytes: decoded.length,
    decodedSha256: sha256(decoded),
    compressedBytes: compressed.length,
    compressedSha256: sha256(compressed),
    chunkCount: Math.ceil(compressed.length / MONITOR_CHUNK_BYTES),
  };
  return {
    manifest,
    chunks: Array.from({ length: manifest.chunkCount }, (_, index) => ({
      manifest,
      index,
      data: compressed.subarray(
        index * MONITOR_CHUNK_BYTES,
        (index + 1) * MONITOR_CHUNK_BYTES,
      ).toString("base64"),
    })),
  };
}

test("transportRef replay is exact and cannot reactivate an older stored generation", async () => {
  const priorKey = process.env.APPHUB_SYNC_KEY;
  process.env.APPHUB_SYNC_KEY = "transport-replay-fixture";
  try {
    const snapshot = {
      generatedAt: "2026-09-08T00:00:00.000Z",
      stream: [],
      profilePreparing: [],
      counts: { stream: 0, queue: 0, profilePreparing: 0, total: 0 },
    };
    const queue = [];
    const source = {
      id: "transport-replay-generation",
      sourceCutoff: "transport-replay-cutoff",
      sourceWatermark: 17,
    };
    source.digest = coreGenerationDigest({
      generationId: source.id,
      sourceCutoff: source.sourceCutoff,
      sourceWatermark: source.sourceWatermark,
      snapshot,
      queue,
    });
    const encoded = chunked({ snapshot, queue, generation: source });
    const delayedSnapshot = { ...snapshot, generatedAt: "2026-09-07T23:59:00.000Z" };
    const delayedSource = {
      id: "transport-delayed-first-generation",
      sourceCutoff: "transport-delayed-first-cutoff",
      sourceWatermark: 17,
    };
    delayedSource.digest = coreGenerationDigest({
      generationId: delayedSource.id,
      sourceCutoff: delayedSource.sourceCutoff,
      sourceWatermark: delayedSource.sourceWatermark,
      snapshot: delayedSnapshot,
      queue,
    });
    const delayedEncoded = chunked({
      snapshot: delayedSnapshot,
      queue,
      generation: delayedSource,
    });
    const state = new Map();
    const readJson = async (key) => structuredClone(state.get(key) ?? null);
    const writeJson = async (key, value) => {
      state.set(key, structuredClone(value));
      return "OK";
    };
    const writeImmutableJson = async (key, value) => {
      if (state.has(key)) return null;
      state.set(key, structuredClone(value));
      return "OK";
    };
    const activateGeneration = async (key, previous, next) => {
      if (JSON.stringify(state.get(key) ?? null) !== JSON.stringify(previous ?? null)) return false;
      state.set(key, structuredClone(next));
      return true;
    };
    let clock = 0;
    const handler = createSyncHandler({
      kvReady: () => true,
      readJson,
      writeJson,
      writeImmutableJson,
      activateGeneration,
      readHash: async () => ({}),
      readHashKeys: async () => [],
      deleteHashFields: async () => 0,
      now: () => `2026-09-08T00:00:${String(clock++).padStart(2, "0")}.000Z`,
    });
    const call = async (body) => {
      const res = {
        setHeader() {},
        status(statusCode) { this.statusCode = statusCode; return this; },
        json(value) { this.body = value; return this; },
      };
      await handler({
        method: "POST",
        headers: { authorization: "Bearer transport-replay-fixture" },
        body,
      }, res);
      return res;
    };

    // Upload an older generation without its final reference. Its first final
    // request will be deliberately delayed until after a newer activation.
    for (const transportChunk of delayedEncoded.chunks) {
      assert.equal((await call({ transportChunk })).statusCode, 200);
    }
    for (const transportChunk of encoded.chunks) {
      assert.equal((await call({ transportChunk })).statusCode, 200);
    }
    const first = await call({ transportRef: encoded.manifest });
    assert.equal(first.statusCode, 200);
    const prefix = K.generation(source.id);
    const originalArtifacts = structuredClone(Object.fromEntries(
      [...state].filter(([key]) => key.startsWith(`${prefix}:`)),
    ));

    const delayedFirst = await call({ transportRef: delayedEncoded.manifest });
    assert.equal(delayedFirst.statusCode, 409);
    assert.equal(delayedFirst.body.error, "generation_changed_retry_publish");
    assert.equal(delayedFirst.body.generationId, source.id);
    assert.equal(state.has(`${K.generation(delayedSource.id)}:meta`), false);
    assert.equal(state.get(K.activeGeneration).generationId, source.id);

    const replay = await call({ transportRef: encoded.manifest });
    assert.equal(replay.statusCode, 200);
    assert.deepEqual(replay.body.generation, first.body.generation);
    assert.deepEqual(Object.fromEntries(
      [...state].filter(([key]) => key.startsWith(`${prefix}:`)),
    ), originalArtifacts);
    assert.equal(state.get(K.activeGeneration).generationId, source.id);

    const nextSnapshot = { ...snapshot, generatedAt: "2026-09-08T00:01:00.000Z" };
    const nextSource = {
      id: "transport-replay-newer-generation",
      sourceCutoff: "transport-replay-newer-cutoff",
      // A later generation may legitimately republish the same source
      // watermark after another local decision/outbox change.
      sourceWatermark: 17,
    };
    nextSource.digest = coreGenerationDigest({
      generationId: nextSource.id,
      sourceCutoff: nextSource.sourceCutoff,
      sourceWatermark: nextSource.sourceWatermark,
      snapshot: nextSnapshot,
      queue,
    });
    const nextEncoded = chunked({ snapshot: nextSnapshot, queue, generation: nextSource });
    for (const transportChunk of nextEncoded.chunks) {
      assert.equal((await call({ transportChunk })).statusCode, 200);
    }
    assert.equal((await call({ transportRef: nextEncoded.manifest })).statusCode, 200);
    const newerPointer = structuredClone(state.get(K.activeGeneration));
    assert.equal(newerPointer.generationId, nextSource.id);

    const stale = await call({ transportRef: encoded.manifest });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.body.error, "generation_changed_retry_publish");
    assert.equal(stale.body.generationId, nextSource.id);
    assert.deepEqual(state.get(K.activeGeneration), newerPointer);
  } finally {
    if (priorKey === undefined) delete process.env.APPHUB_SYNC_KEY;
    else process.env.APPHUB_SYNC_KEY = priorKey;
  }
});
