import test from "node:test";
import assert from "node:assert/strict";

import {
  candidateTagNames,
  findCrmCandidate,
  isArchiveImportCandidate,
  scanCrm,
} from "../api/paraai/_lib/core.mjs";
import {
  archiveImportSet,
  crmProjectMembers,
  projectMembers,
} from "../api/seq/_lib/core.mjs";

test("archive-import is a load-bearing automation exclusion tag", async () => {
  assert.deepEqual(candidateTagNames({
    tags: [{ name: "archive-import" }, "src-linkedin"],
  }), ["archive-import", "src-linkedin"]);
  assert.equal(isArchiveImportCandidate({
    candidate: { tags: [{ name: "archive-import" }] },
  }), true);

  const archived = await archiveImportSet(["candidate-1", "candidate-2"], {
    async fetchImpl(url) {
      const tagged = url.includes("candidate-2");
      return new Response(JSON.stringify({
        tags: tagged ? [{ name: "archive-import" }] : [{ name: "live-pipeline" }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.deepEqual([...archived], ["candidate-2"]);
});

test("Para AI CRM scan exhausts every cursor instead of truncating at six pages", async () => {
  const cursors = [];
  const rows = await scanCrm({
    maxRows: 20,
    async fetchPage(cursor) {
      cursors.push(cursor);
      const page = Number(cursor);
      return {
        items: [{ id: `candidate-${page}` }],
        nextCursor: page < 7 ? page + 1 : null,
      };
    },
  });
  assert.deepEqual(cursors, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(rows.length, 8);
});

test("Para AI CRM scan fails closed on cursor loops and configured row ceiling", async () => {
  await assert.rejects(
    scanCrm({
      fetchPage: async () => ({
        items: [{ id: "candidate-1" }],
        nextCursor: 0,
      }),
    }),
    /CRM_SCAN_CURSOR_REPEATED/u,
  );
  await assert.rejects(
    scanCrm({
      maxRows: 1,
      fetchPage: async () => ({
        items: [{ id: "candidate-1" }, { id: "candidate-2" }],
        nextCursor: null,
      }),
    }),
    /CRM_SCAN_MAX_ROWS_EXCEEDED/u,
  );
});

test("Para AI candidate ID reads use the exact point lookup", async () => {
  const calls = [];
  const row = await findCrmCandidate("candidate-7", {
    async trpcGetImpl(procedure, input) {
      calls.push({ procedure, input });
      return { candidate_user: { id: "candidate-7", name: "Candidate Seven" } };
    },
  });
  assert.deepEqual(calls, [{
    procedure: "candidateUser.getCandidateUserById",
    input: { candidate_user_id: "candidate-7" },
  }]);
  assert.equal(row.id, "candidate-7");
});

test("sequence project membership exhausts all pages and deduplicates overlap", async () => {
  const cursors = [];
  const fetchImpl = async (url) => {
    const input = JSON.parse(new URL(url).searchParams.get("input")).json;
    cursors.push(input.cursor);
    const pages = new Map([
      [0, {
        items: [
          { id: "candidate-1", name: "One", emails: ["one@example.test"] },
          { id: "candidate-2", name: "Two", emails: ["two@example.test"] },
        ],
        next_cursor: 2,
      }],
      [2, {
        items: [
          { id: "candidate-2", name: "Two", emails: ["two@example.test"] },
          { id: "candidate-3", name: "Three", emails: ["three@example.test"] },
        ],
        next_cursor: null,
      }],
    ]);
    return new Response(JSON.stringify({
      result: { data: { json: pages.get(input.cursor) } },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const raw = await crmProjectMembers("project-1", { fetchImpl });
  const members = await projectMembers("project-1", { fetchImpl });
  assert.deepEqual(cursors, [0, 2, 0, 2]);
  assert.deepEqual(raw.map((row) => row.id), [
    "candidate-1",
    "candidate-2",
    "candidate-3",
  ]);
  assert.deepEqual(members.map((row) => row.id), [
    "candidate-1",
    "candidate-2",
    "candidate-3",
  ]);
});
