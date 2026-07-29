import test from "node:test";
import assert from "node:assert/strict";

const ENV_NAMES = [
  "SCHEDULER_DASHBOARD_HEALTH_READ_KEY",
  "VERCEL_GIT_COMMIT_SHA",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "PARAFORM_COOKIE",
  "RAYDAR_SCHEDULER_BOOKING_STOP_ENABLED",
  "RAYDAR_SCHEDULER_INTEGRATION_READ_KEY",
  "RAYDAR_SCHEDULER_INTEGRATION_URL",
  "RAYDAR_SCHEDULER_WEBHOOK_SECRET",
  "RAYDAR_BOOKING_PAUSE_CANARY_FINGERPRINT",
];
const SAVED_ENV = Object.fromEntries(
  ENV_NAMES.map((name) => [name, process.env[name]]),
);
for (const name of ENV_NAMES) delete process.env[name];

const {
  authenticatedSchedulerHealthFields,
  default: healthHandler,
} = await import("../api/seq/health.mjs");

test.after(() => {
  for (const [name, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const KEY = "scheduler-dashboard-health-read-key-0001";
const REVISION = "abcdef0123456789abcdef0123456789abcdef01";

function request(authorization, method = "GET") {
  return {
    method,
    headers: authorization === undefined ? {} : { authorization },
  };
}

function response() {
  return {
    body: undefined,
    headers: {},
    statusCode: undefined,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    status(value) {
      this.statusCode = value;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
    end() {},
  };
}

async function readHealth(req) {
  const res = response();
  await healthHandler(req, res);
  assert.equal(res.statusCode, 200);
  return res.body;
}

function setProofEnv(options = {}) {
  const key = Object.hasOwn(options, "key") ? options.key : KEY;
  const revision = Object.hasOwn(options, "revision")
    ? options.revision
    : REVISION;
  if (key === undefined) {
    delete process.env.SCHEDULER_DASHBOARD_HEALTH_READ_KEY;
  } else {
    process.env.SCHEDULER_DASHBOARD_HEALTH_READ_KEY = key;
  }
  if (revision === undefined) {
    delete process.env.VERCEL_GIT_COMMIT_SHA;
  } else {
    process.env.VERCEL_GIT_COMMIT_SHA = revision;
  }
}

test("authenticated scheduler health proof requires an exact bearer and valid deployed revision", () => {
  const minimumKey = "k".repeat(32);
  assert.deepEqual(
    authenticatedSchedulerHealthFields(
      request(`Bearer ${minimumKey}`),
      {
        SCHEDULER_DASHBOARD_HEALTH_READ_KEY: minimumKey,
        VERCEL_GIT_COMMIT_SHA: REVISION,
      },
    ),
    {
      authenticated: true,
      contractRevision: REVISION,
    },
  );

  const lower = authenticatedSchedulerHealthFields(
    request(`Bearer ${KEY}`),
    {
      SCHEDULER_DASHBOARD_HEALTH_READ_KEY: KEY,
      VERCEL_GIT_COMMIT_SHA: REVISION,
    },
  );
  assert.deepEqual(lower, {
    authenticated: true,
    contractRevision: REVISION,
  });

  const upperRevision = REVISION.toUpperCase();
  assert.deepEqual(
    authenticatedSchedulerHealthFields(
      request(`Bearer ${KEY}`),
      {
        SCHEDULER_DASHBOARD_HEALTH_READ_KEY: KEY,
        VERCEL_GIT_COMMIT_SHA: upperRevision,
      },
    ),
    {
      authenticated: true,
      contractRevision: REVISION,
    },
  );

  for (const { name, req, env } of [
    {
      name: "missing bearer",
      req: request(),
      env: {
        SCHEDULER_DASHBOARD_HEALTH_READ_KEY: KEY,
        VERCEL_GIT_COMMIT_SHA: REVISION,
      },
    },
    {
      name: "wrong bearer",
      req: request(`Bearer ${KEY.slice(0, -1)}x`),
      env: {
        SCHEDULER_DASHBOARD_HEALTH_READ_KEY: KEY,
        VERCEL_GIT_COMMIT_SHA: REVISION,
      },
    },
    {
      name: "wrong bearer scheme casing",
      req: request(`bearer ${KEY}`),
      env: {
        SCHEDULER_DASHBOARD_HEALTH_READ_KEY: KEY,
        VERCEL_GIT_COMMIT_SHA: REVISION,
      },
    },
    {
      name: "wrong bearer separator",
      req: request(`Bearer  ${KEY}`),
      env: {
        SCHEDULER_DASHBOARD_HEALTH_READ_KEY: KEY,
        VERCEL_GIT_COMMIT_SHA: REVISION,
      },
    },
    {
      name: "bearer with an extra byte",
      req: request(`Bearer ${KEY} `),
      env: {
        SCHEDULER_DASHBOARD_HEALTH_READ_KEY: KEY,
        VERCEL_GIT_COMMIT_SHA: REVISION,
      },
    },
    {
      name: "non-GET request",
      req: request(`Bearer ${KEY}`, "POST"),
      env: {
        SCHEDULER_DASHBOARD_HEALTH_READ_KEY: KEY,
        VERCEL_GIT_COMMIT_SHA: REVISION,
      },
    },
    {
      name: "missing configured key",
      req: request(`Bearer ${KEY}`),
      env: { VERCEL_GIT_COMMIT_SHA: REVISION },
    },
    {
      name: "short configured key",
      req: request("Bearer too-short"),
      env: {
        SCHEDULER_DASHBOARD_HEALTH_READ_KEY: "too-short",
        VERCEL_GIT_COMMIT_SHA: REVISION,
      },
    },
    {
      name: "configured key with whitespace",
      req: request(`Bearer ${"k".repeat(16)} ${"k".repeat(16)}`),
      env: {
        SCHEDULER_DASHBOARD_HEALTH_READ_KEY:
          `${"k".repeat(16)} ${"k".repeat(16)}`,
        VERCEL_GIT_COMMIT_SHA: REVISION,
      },
    },
    {
      name: "missing revision",
      req: request(`Bearer ${KEY}`),
      env: { SCHEDULER_DASHBOARD_HEALTH_READ_KEY: KEY },
    },
    {
      name: "short revision",
      req: request(`Bearer ${KEY}`),
      env: {
        SCHEDULER_DASHBOARD_HEALTH_READ_KEY: KEY,
        VERCEL_GIT_COMMIT_SHA: "a".repeat(39),
      },
    },
    {
      name: "non-hex revision",
      req: request(`Bearer ${KEY}`),
      env: {
        SCHEDULER_DASHBOARD_HEALTH_READ_KEY: KEY,
        VERCEL_GIT_COMMIT_SHA: `${"a".repeat(39)}g`,
      },
    },
  ]) {
    assert.deepEqual(
      authenticatedSchedulerHealthFields(req, env),
      {},
      name,
    );
  }
});

test("public, missing-auth, wrong-auth, and invalid-config responses keep the exact redacted shape", async () => {
  setProofEnv({ key: undefined, revision: undefined });
  const publicBody = await readHealth(request());
  const publicBytes = JSON.stringify(publicBody);
  const publicScheduler = publicBody.bookingStop.raydarScheduler;
  assert.equal(
    Object.hasOwn(publicScheduler, "authenticated"),
    false,
  );
  assert.equal(
    Object.hasOwn(publicScheduler, "contractRevision"),
    false,
  );

  setProofEnv();
  for (const req of [
    request(),
    request(`Bearer ${KEY.slice(0, -1)}x`),
    request(`Bearer ${KEY} `),
  ]) {
    assert.equal(JSON.stringify(await readHealth(req)), publicBytes);
  }

  for (const config of [
    { key: "k".repeat(31), revision: REVISION },
    { key: `${"k".repeat(31)} `, revision: REVISION },
    { key: KEY, revision: undefined },
    { key: KEY, revision: "not-a-deployment-revision" },
  ]) {
    setProofEnv(config);
    assert.equal(
      JSON.stringify(await readHealth(request(`Bearer ${config.key}`))),
      publicBytes,
    );
  }

  assert.doesNotMatch(publicBytes, /authenticated|contractRevision/u);
  assert.doesNotMatch(publicBytes, /@/u);
});

test("valid authenticated health adds only normalized revision proof and never reflects the secret", async () => {
  setProofEnv({ revision: REVISION.toUpperCase() });
  const body = await readHealth(request(`Bearer ${KEY}`));
  const scheduler = body.bookingStop.raydarScheduler;
  assert.equal(scheduler.authenticated, true);
  assert.equal(scheduler.contractRevision, REVISION);
  assert.deepEqual(
    Object.keys(scheduler).slice(-2),
    ["authenticated", "contractRevision"],
  );

  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes(KEY), false);
  assert.doesNotMatch(serialized, /@/u);
});
