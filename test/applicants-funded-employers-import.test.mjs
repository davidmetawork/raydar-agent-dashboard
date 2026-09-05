import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import test from "node:test";

import {
  MAX_ALIASES_PER_ENTRY,
  MAX_PARAFORM_COMPANY_IDS_PER_ENTRY,
  MAX_REVIEWED_SOURCE_NAMES_PER_ENTRY,
  compileFundedEmployerSnapshot,
  updateFundedEmployerCatalog,
} from "../api/applicants/_lib/funded-employers.mjs";
import { K } from "../api/applicants/_lib/kv.mjs";
import {
  createFundedEmployersHandler,
  decodeFundedEmployerImport,
  MAX_FUNDED_EMPLOYER_IMPORT_DECODED_BYTES,
} from "../api/applicants/funded-employers.mjs";

function manifest(snapshotId = "funded-import-test") {
  return {
    snapshotId,
    generatedAt: "2026-09-05T10:00:00.000Z",
    criteria: {
      headquartersCountryCodes: ["US", "GB", "CA"],
      minimumTotalFundingUsd: 1_000_000,
      qualifyingFundingRoundTypes: ["seed", "series_a", "series_b", "series_c", "series_d"],
      qualifyingRoundAnnouncedOnOrAfter: "2011-09-05",
      qualifyingRoundAnnouncedOnOrBefore: "2026-09-05",
    },
    provenance: { sources: [{
      id: "cb-us-2026-09-05", kind: "crunchbase_query_export", exportedAt: "2026-09-05T09:00:00.000Z",
      sourceFileSha256: "a".repeat(64), qualifyingSearch: { entity: "organizations" },
    }] },
    entries: [{
      orgId: `org-${snapshotId}`, name: "Acme", countryCode: "US", domain: "acme.example",
      sourceRef: "cb-us-2026-09-05", paraformCompanyIds: ["pf-acme"],
      fundingProof: { totalFundingUsd: 2_000_000, qualification: { kind: "query_cohort", sourceRef: "cb-us-2026-09-05" } },
    }],
  };
}

function response() {
  return {
    statusCode: null, body: null,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function envelope(body) {
  const decoded = Buffer.from(JSON.stringify(body));
  return {
    operation: "import_snapshot",
    transport: {
      codec: "gzip-base64",
      data: gzipSync(decoded).toString("base64"),
      decodedBytes: decoded.length,
      decodedSha256: createHash("sha256").update(decoded).digest("hex"),
      version: "funded-employer-import-gzip-v1",
    },
  };
}

test("catalog CAS retries a concurrent import without losing either immutable snapshot", async () => {
  let raw = null;
  let gets = 0;
  let releaseGets;
  const firstGets = new Promise((resolve) => { releaseGets = resolve; });
  const command = async (args) => {
    if (args[0] === "GET") {
      const observed = raw;
      gets += 1;
      if (gets <= 2) {
        if (gets === 2) releaseGets();
        await firstGets;
      }
      return observed;
    }
    if (args[0] === "EVAL") {
      const [, , , key, expected, next] = args;
      assert.equal(key, K.fundedEmployerCatalog);
      if ((raw ?? "") !== expected) return 0;
      raw = next;
      return 1;
    }
    throw new Error(`unexpected ${args[0]}`);
  };
  const [a, b] = await Promise.all([
    updateFundedEmployerCatalog({ id: "a", generatedAt: "2026-09-05T10:00:00.000Z" }, { kvImpl: command, now: () => "2026-09-05T12:00:00.000Z" }),
    updateFundedEmployerCatalog({ id: "b", generatedAt: "2026-09-05T11:00:00.000Z" }, { kvImpl: command, now: () => "2026-09-05T12:00:00.000Z" }),
  ]);
  const finalCatalog = JSON.parse(raw);
  assert.deepEqual(finalCatalog.snapshots.map(({ id }) => id).sort(), ["a", "b"]);
  assert.ok([a.activeSnapshotId, b.activeSnapshotId].includes(finalCatalog.activeSnapshotId));
});

test("bounded gzip envelope imports only after authentication and never returns source rows", async () => {
  const state = {};
  const handler = createFundedEmployersHandler({
    corsHandler: () => false,
    authHandler: (req) => req.headers.authorization === "Bearer allowed",
    kvReady: () => true,
    readJson: async (key) => state[key] ?? null,
    writeIfAbsent: async (key, value) => {
      if (state[key]) return null;
      state[key] = value;
      return "OK";
    },
    updateCatalog: async (metadata) => ({ activeSnapshotId: metadata.id, snapshots: [metadata] }),
  });
  const body = envelope(manifest());

  const denied = response();
  await handler({ method: "POST", headers: {}, body }, denied);
  assert.equal(denied.statusCode, 401);
  assert.deepEqual(state, {});

  const accepted = response();
  await handler({ method: "POST", headers: { authorization: "Bearer allowed" }, body }, accepted);
  assert.equal(accepted.statusCode, 201);
  assert.equal(accepted.body.snapshot.id, "funded-import-test");
  assert.equal(JSON.stringify(accepted.body).includes("Acme"), false);
});

test("gzip transport and imported arrays fail closed at explicit bounds", () => {
  const oversized = Buffer.alloc(MAX_FUNDED_EMPLOYER_IMPORT_DECODED_BYTES + 1, 0x61);
  const transport = envelope({ snapshotId: "unused" });
  transport.transport.data = gzipSync(oversized).toString("base64");
  transport.transport.decodedBytes = oversized.length;
  transport.transport.decodedSha256 = createHash("sha256").update(oversized).digest("hex");
  assert.deepEqual(decodeFundedEmployerImport(transport), { ok: false, error: "invalid_import_envelope" });

  const aliases = manifest();
  aliases.entries[0].aliases = Array.from({ length: MAX_ALIASES_PER_ENTRY + 1 }, (_, i) => `alias-${i}`);
  assert.throws(() => compileFundedEmployerSnapshot(aliases), /funded_employer_aliases_invalid/);
  const ids = manifest();
  ids.entries[0].paraformCompanyIds = Array.from({ length: MAX_PARAFORM_COMPANY_IDS_PER_ENTRY + 1 }, (_, i) => `pf-${i}`);
  assert.throws(() => compileFundedEmployerSnapshot(ids), /funded_employer_paraform_id_count_invalid/);
  const bridges = manifest();
  bridges.entries[0].reviewedSourceNames = Array.from({ length: MAX_REVIEWED_SOURCE_NAMES_PER_ENTRY + 1 }, () => ({}));
  assert.throws(() => compileFundedEmployerSnapshot(bridges), /funded_employer_reviewed_source_names_invalid/);
});
