import assert from "node:assert/strict";
import {
  spawn,
} from "node:child_process";
import {
  mkdtemp,
  rm,
} from "node:fs/promises";
import {
  tmpdir,
} from "node:os";
import {
  join,
} from "node:path";
import test from "node:test";

import {
  createSourceRecallReferencePersistenceAdapter,
} from "../api/paraai/_lib/source-recall-reference-persistence-adapter.mjs";
import {
  SOURCE_RECALL_REFERENCE_PRIVATE_PAGE_TTL_MS,
  createSourceRecallReferencePersistenceProtocol,
} from "../api/paraai/_lib/source-recall-reference-persistence-protocol.mjs";
import {
  createSourceRecallPointObservationPersistenceAdapter,
} from "../api/paraai/_lib/source-recall-point-observation-store.mjs";
import {
  collectRecallReferenceHeadStep,
} from "../api/paraai/_lib/source-recall-reference-collector.mjs";
import {
  SOURCE_RECALL_PAGE_VERSION,
} from "../api/paraai/_lib/source-recall-page-client.mjs";

const ENABLED = process.env.PARAAI_TEST_REAL_REDIS === "1";
const BOUNDARY = "2026-07-26T00:00:00.000Z";
const TEST_TIMEOUT_MS = 60_000;
const PROCESS_TIMEOUT_MS = 10_000;
const MAX_CLI_OUTPUT_BYTES = 16 * 1024 * 1024;

class RealRedisHarnessError extends Error {
  constructor(code) {
    super(code);
    this.name = "RealRedisHarnessError";
    this.code = code;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function runProcess(command, args, {
  allowEmpty = false,
  signal = null,
  timeoutMs = PROCESS_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let outputBytes = 0;
    const output = [];
    const child = spawn(command, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (error, value = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const fail = () => {
      if (child.exitCode === null) child.kill("SIGKILL");
      finish(new RealRedisHarnessError(
        "PARAAI_REAL_REDIS_COMMAND_FAILED",
      ));
    };
    const onAbort = () => fail();
    const timeout = setTimeout(fail, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", fail);
    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_CLI_OUTPUT_BYTES) {
        fail();
        return;
      }
      output.push(chunk);
    });
    child.stderr.resume();
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        fail();
        return;
      }
      const text = Buffer.concat(output).toString("utf8").trim();
      if (!allowEmpty && text.length === 0) {
        fail();
        return;
      }
      finish(null, text);
    });
  });
}

async function waitForRedis(redisCommand) {
  const deadline = Date.now() + PROCESS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      if (await redisCommand(["PING"]) === "PONG") return;
    } catch {
      // The isolated Unix socket may not exist yet.
    }
    await delay(20);
  }
  throw new RealRedisHarnessError(
    "PARAAI_REAL_REDIS_START_FAILED",
  );
}

function redisJsonResponse(result) {
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

function context(runNonceCharacter) {
  return Object.freeze({
    contractPinsDigest: "b".repeat(64),
    decisionBoundaryAtMs: Date.parse(BOUNDARY),
    runNonceDigest: runNonceCharacter.repeat(64),
  });
}

function sourcePage() {
  return Object.freeze({
    boundaryAt: BOUNDARY,
    exhausted: true,
    nextCursor: null,
    references: Object.freeze([Object.freeze({
      candidate: Object.freeze({
        email: "",
        fullName: "",
        linkedin: "",
        paraformEventId: "",
      }),
      id: "synthetic_reference",
      joinAt: "2026-07-25T23:00:00.000Z",
      metadataSource: "paraform-auto",
    })]),
    scanned: 1,
    version: SOURCE_RECALL_PAGE_VERSION,
  });
}

function collectorDependencies(protocol, readSourcePage) {
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

const realRedisTest = ENABLED ? test : test.skip;

realRedisTest(
  "Redis 8.x preserves Recall reference atomic proofs across restart and corruption",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const version = await runProcess("redis-server", ["--version"]);
    assert.equal(/\bv=8\.[0-9]+\.[0-9]+\b/u.test(version), true);

    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "paraai-redis-"),
    );
    const socketPath = join(temporaryDirectory, "r.sock");
    const server = spawn("redis-server", [
      "--port",
      "0",
      "--unixsocket",
      socketPath,
      "--unixsocketperm",
      "700",
      "--save",
      "",
      "--appendonly",
      "no",
      "--daemonize",
      "no",
      "--protected-mode",
      "yes",
      "--dir",
      temporaryDirectory,
      "--loglevel",
      "warning",
    ], {
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    server.on("error", () => {
      // Readiness reports one stable, non-sensitive failure below.
    });
    server.stderr.resume();
    const serverClosed = new Promise((resolve) => {
      server.once("close", resolve);
    });

    async function redisCommand(command, {
      allowEmpty = false,
      signal = null,
    } = {}) {
      const text = await runProcess(
        "redis-cli",
        ["--json", "-s", socketPath, ...command],
        { allowEmpty, signal },
      );
      if (allowEmpty && text.length === 0) return null;
      try {
        return JSON.parse(text);
      } catch {
        throw new RealRedisHarnessError(
          "PARAAI_REAL_REDIS_RESPONSE_INVALID",
        );
      }
    }

    t.after(async () => {
      try {
        await redisCommand(["SHUTDOWN", "NOSAVE"], {
          allowEmpty: true,
        });
      } catch {
        // The fallback signals below remain authoritative.
      }
      if (server.exitCode === null) server.kill("SIGTERM");
      await Promise.race([
        serverClosed,
        delay(1_000),
      ]);
      if (server.exitCode === null) {
        server.kill("SIGKILL");
        await Promise.race([
          serverClosed,
          delay(1_000),
        ]);
      }
      await rm(temporaryDirectory, {
        force: true,
        recursive: true,
      });
    });

    await waitForRedis(redisCommand);

    function adapter() {
      return createSourceRecallReferencePersistenceAdapter({
        fetchImpl: async (_url, options) => {
          const command = JSON.parse(options.body);
          const result = await redisCommand(command, {
            signal: options.signal,
          });
          return redisJsonResponse(result);
        },
        token: "synthetic-test-token-with-no-authority",
        url: "https://redis-harness.invalid",
      });
    }

    function observationAdapter() {
      return createSourceRecallPointObservationPersistenceAdapter({
        fetchImpl: async (_url, options) => {
          const command = JSON.parse(options.body);
          const result = await redisCommand(command, {
            signal: options.signal,
          });
          return redisJsonResponse(result);
        },
        token: "synthetic-test-token-with-no-authority",
        url: "https://redis-harness.invalid",
      });
    }

    await t.test(
      "point observations preserve exact absolute expiry and CAS fences",
      async () => {
        const pointPersistence = observationAdapter();
        const firstTime = await pointPersistence.time();
        const pointKey = (
          "paraai:phase4:recall-point-observation:v2:work:"
          + "d".repeat(64)
        );
        const pointExpiry =
          firstTime.redisNowMs + 5 * 60 * 1_000;
        const initialRaw = "{\"revision\":0}";
        const nextRaw = "{\"revision\":1}";

        const created = await pointPersistence.ensure({
          key: pointKey,
          proposedRaw: initialRaw,
          expiresAtMs: pointExpiry,
        });
        assert.equal(created.status, "created");
        assert.equal(created.raw, initialRaw);
        assert.equal(created.expiresAtMs, pointExpiry);
        assert.equal(await redisCommand([
          "PEXPIRETIME",
          pointKey,
        ]), pointExpiry);

        const replay = await pointPersistence.ensure({
          key: pointKey,
          proposedRaw: "{\"revision\":999}",
          expiresAtMs: pointExpiry,
        });
        assert.equal(replay.status, "existing");
        assert.equal(replay.raw, initialRaw);
        assert.equal(replay.expiresAtMs, pointExpiry);

        const read = await pointPersistence.read({
          key: pointKey,
        });
        assert.equal(read.raw, initialRaw);
        assert.equal(read.expiresAtMs, pointExpiry);

        const wrongRaw =
          await pointPersistence.compareAndSet({
            key: pointKey,
            expectedRaw: "{\"revision\":404}",
            nextRaw,
            expiresAtMs: pointExpiry,
            notAfterMs: pointExpiry,
          });
        assert.equal(wrongRaw.status, "conflict");
        assert.equal(wrongRaw.raw, initialRaw);
        assert.equal(wrongRaw.expiresAtMs, pointExpiry);

        const wrongExpiry =
          await pointPersistence.compareAndSet({
            key: pointKey,
            expectedRaw: initialRaw,
            nextRaw,
            expiresAtMs: pointExpiry + 1,
            notAfterMs: pointExpiry,
          });
        assert.equal(wrongExpiry.status, "expired");
        assert.equal(wrongExpiry.raw, initialRaw);
        assert.equal(wrongExpiry.expiresAtMs, pointExpiry);

        const missedDeadline =
          await pointPersistence.compareAndSet({
            key: pointKey,
            expectedRaw: initialRaw,
            nextRaw,
            expiresAtMs: pointExpiry,
            notAfterMs: firstTime.redisNowMs,
          });
        assert.equal(missedDeadline.status, "expired");
        assert.equal(missedDeadline.raw, initialRaw);
        assert.equal(missedDeadline.expiresAtMs, pointExpiry);

        const stored =
          await pointPersistence.compareAndSet({
            key: pointKey,
            expectedRaw: initialRaw,
            nextRaw,
            expiresAtMs: pointExpiry,
            notAfterMs: pointExpiry,
          });
        assert.equal(stored.status, "stored");
        assert.equal(stored.raw, nextRaw);
        assert.equal(stored.expiresAtMs, pointExpiry);
        assert.equal(await redisCommand([
          "GET",
          pointKey,
        ]), nextRaw);
        assert.equal(await redisCommand([
          "PEXPIRETIME",
          pointKey,
        ]), pointExpiry);
      },
    );

    await t.test(
      "manifest head and page shards share exact non-renewed Redis CAS semantics",
      async () => {
        const persistence = observationAdapter();
        const firstTime = await persistence.time();
        const expiry =
          firstTime.redisNowMs + 5 * 60 * 1_000;
        const keys = [
          (
            "paraai:phase4:recall-point-observation-manifest:"
            + `v1:run:${"e".repeat(64)}`
          ),
          (
            "paraai:phase4:recall-point-observation-manifest:"
            + `v1:page:${"e".repeat(64)}:200`
          ),
        ];
        for (const [index, key] of keys.entries()) {
          const initialRaw = `{"revision":${index}}`;
          const nextRaw = `{"revision":${index + 1}}`;
          const created = await persistence.ensure({
            key,
            proposedRaw: initialRaw,
            expiresAtMs: expiry,
          });
          assert.equal(created.status, "created");
          assert.equal(
            await redisCommand(["PEXPIRETIME", key]),
            expiry,
          );
          const stored = await persistence.compareAndSet({
            key,
            expectedRaw: initialRaw,
            nextRaw,
            expiresAtMs: expiry,
            notAfterMs: expiry,
          });
          assert.equal(stored.status, "stored");
          assert.equal(stored.raw, nextRaw);
          assert.equal(
            await redisCommand(["PEXPIRETIME", key]),
            expiry,
          );
        }
      },
    );

    const firstProtocol =
      createSourceRecallReferencePersistenceProtocol({
        persistence: adapter(),
      });
    const { work: firstWork } =
      await firstProtocol.ensureRecallReferenceRun(context("a"));
    let providerReads = 0;
    const firstCollector = collectorDependencies(
      firstProtocol,
      async () => {
        providerReads += 1;
        return sourcePage();
      },
    );
    const firstPass = await collectRecallReferenceHeadStep(
      firstWork,
      firstCollector,
    );
    const secondPass = await collectRecallReferenceHeadStep(
      firstWork,
      firstCollector,
    );
    assert.equal(firstPass.status, "collecting");
    assert.equal(secondPass.status, "sealed_unpinnable");
    assert.equal(providerReads, 2);

    const restartedProtocol =
      createSourceRecallReferencePersistenceProtocol({
        persistence: adapter(),
      });
    const restartedHead =
      await restartedProtocol.readRecallReferenceHead(firstWork);
    assert.equal(restartedHead.record.passCount, 2);
    assert.equal(restartedHead.record.pageCount, 1);

    const retainedPageKey = (
      "paraai:phase4:recall-reference:page:v1:"
      + `${firstWork.workKeyDigest}:2:1`
    );
    const retainedEnvelope = await redisCommand([
      "GET",
      retainedPageKey,
    ]);
    assert.equal(typeof retainedEnvelope, "string");
    assert.equal(retainedEnvelope.length > 80, true);
    const finalCharacter = retainedEnvelope.at(-1);
    const mutatedEnvelope = (
      `${retainedEnvelope.slice(0, -1)}`
      + `${finalCharacter === "X" ? "Y" : "X"}`
    );
    assert.equal(
      Buffer.byteLength(mutatedEnvelope, "utf8"),
      Buffer.byteLength(retainedEnvelope, "utf8"),
    );
    assert.equal(await redisCommand([
      "SET",
      retainedPageKey,
      mutatedEnvelope,
      "XX",
      "KEEPTTL",
    ]), "OK");

    const tamperedProtocol =
      createSourceRecallReferencePersistenceProtocol({
        persistence: adapter(),
      });
    let postTamperProviderReads = 0;
    const postTamper = await collectRecallReferenceHeadStep(
      firstWork,
      collectorDependencies(tamperedProtocol, async () => {
        postTamperProviderReads += 1;
        throw new Error("provider read must remain unreachable");
      }),
    );
    assert.equal(postTamper.status, "invalidated");
    assert.equal(postTamper.headSealed, false);
    assert.equal(postTamperProviderReads, 0);

    const emptyPageProtocol =
      createSourceRecallReferencePersistenceProtocol({
        persistence: adapter(),
      });
    const { work: emptyPageWork } =
      await emptyPageProtocol.ensureRecallReferenceRun(context("c"));
    const claim =
      await emptyPageProtocol.claimRecallReferencePage(emptyPageWork);
    assert.equal(claim.status, "page_required");
    const emptyPageKey = (
      "paraai:phase4:recall-reference:page:v1:"
      + `${emptyPageWork.workKeyDigest}:1:1`
    );
    assert.equal(await redisCommand([
      "SET",
      emptyPageKey,
      "",
      "NX",
      "PX",
      String(SOURCE_RECALL_REFERENCE_PRIVATE_PAGE_TTL_MS),
    ]), "OK");

    let emptyPageFailureCode = null;
    try {
      await emptyPageProtocol.checkpointRecallReferencePage(
        claim,
        sourcePage(),
      );
    } catch (error) {
      emptyPageFailureCode = error?.code ?? null;
    }
    assert.equal(
      emptyPageFailureCode,
      "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_ATOMIC_PROOF_FAILED",
    );
    assert.equal(await redisCommand([
      "EXISTS",
      emptyPageKey,
    ]), 1);
    assert.equal(await redisCommand([
      "STRLEN",
      emptyPageKey,
    ]), 0);
  },
);
