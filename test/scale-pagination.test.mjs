import test from "node:test";
import assert from "node:assert/strict";

import {
  candidateTagNames,
  candidateUserIdByLinkedin,
  findCrmCandidate,
  findCrmCandidateByLinkedin,
  isArchiveImportCandidate,
  procedureMissing,
  resetCurrentParaformUserCache,
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
  assert.equal(isArchiveImportCandidate({
    candidate: { tags: [{ name: "linkedin-applicant-inbound" }] },
  }), false);

  const archived = await archiveImportSet(["candidate-1", "candidate-2"], {
    async fetchImpl(url) {
      const tagged = url.includes("candidate-2");
      return new Response(JSON.stringify({
        tags: tagged
          ? [{ name: "archive-import" }]
          : [{ name: "linkedin-applicant-inbound" }],
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

test("Para AI point lookup keeps the live root candidate-user record", async () => {
  const row = await findCrmCandidate("candidate-user-7", {
    async trpcGetImpl() {
      return {
        id: "candidate-user-7",
        candidate: { id: "linkedin-person-99" },
        emails: ["candidate@example.test"],
      };
    },
  });
  assert.equal(row.id, "candidate-user-7");
  assert.equal(row.candidate.id, "linkedin-person-99");
});

test("Para AI point lookup still fails closed on a true candidate-user mismatch", async () => {
  await assert.rejects(
    findCrmCandidate("candidate-user-7", {
      async trpcGetImpl() {
        return {
          id: "candidate-user-8",
          candidate: { id: "linkedin-person-99" },
        };
      },
    }),
    /CRM_POINT_LOOKUP_ID_MISMATCH/u,
  );
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

test("Para AI CRM scan throws a recordable timeout instead of being killed mid-walk", async () => {
  // Before the budget the walk simply outlived the function: Vercel returned
  // FUNCTION_INVOCATION_TIMEOUT, no journal entry was ever written, and the job
  // sat in resolving_identity while the stale sweep re-ran it forever.
  let clock = 0;
  let pages = 0;
  await assert.rejects(
    scanCrm({
      budgetMs: 1_000,
      now: () => clock,
      async fetchPage(cursor) {
        pages += 1;
        clock += 400;
        return { items: [{ id: `candidate-${cursor}` }], nextCursor: Number(cursor) + 1 };
      },
    }),
    (thrown) => thrown.code === "CRM_SCAN_TIMEOUT" && thrown.rowsScanned === 3,
  );
  // It stops at the budget rather than running until something else kills it.
  assert.equal(pages, 3);
});

test("Para AI CRM scan with no budget still walks to cursor exhaustion", async () => {
  const rows = await scanCrm({
    budgetMs: 0,
    async fetchPage(cursor) {
      const page = Number(cursor);
      return { items: [{ id: `candidate-${page}` }], nextCursor: page < 3 ? page + 1 : null };
    },
  });
  assert.equal(rows.length, 4);
});

test("Para AI resolves a LinkedIn identity directly instead of walking the CRM", async () => {
  const calls = [];
  resetCurrentParaformUserCache();
  const row = await findCrmCandidateByLinkedin("yang-an-1305", {
    lookupImpl: async (handle) => {
      calls.push(["lookup", handle]);
      return "candidate-user-42";
    },
    readImpl: async (id) => {
      calls.push(["read", id]);
      return { id, linkedin_user: "https://www.linkedin.com/in/yang-an-1305" };
    },
  });
  assert.deepEqual(calls, [["lookup", "yang-an-1305"], ["read", "candidate-user-42"]]);
  assert.equal(row.id, "candidate-user-42");
});

test("Para AI direct LinkedIn lookup uses the recruiter-scoped procedure once per instance", async () => {
  const procedures = [];
  resetCurrentParaformUserCache();
  const trpcGetImpl = async (procedure, input) => {
    procedures.push(procedure);
    if (procedure === "user.getCurrentUser") return { id: "recruiter-1" };
    assert.deepEqual(input, { linkedin_user: "collin-socha", user_id: "recruiter-1" });
    return "candidate-user-9";
  };
  assert.equal(await candidateUserIdByLinkedin("collin-socha", { trpcGetImpl }), "candidate-user-9");
  assert.equal(await candidateUserIdByLinkedin("collin-socha", { trpcGetImpl }), "candidate-user-9");
  assert.deepEqual(procedures, [
    "user.getCurrentUser",
    "candidateUser.getCandidateUserByLinkedinUserAndUserId",
    "candidateUser.getCandidateUserByLinkedinUserAndUserId",
  ]);
});

test("Para AI direct LinkedIn lookup fails closed when the readback is a different profile", async () => {
  resetCurrentParaformUserCache();
  await assert.rejects(
    findCrmCandidateByLinkedin("yang-an-1305", {
      lookupImpl: async () => "candidate-user-42",
      readImpl: async (id) => ({ id, linkedin_user: "https://www.linkedin.com/in/someone-else" }),
    }),
    /CRM_LINKEDIN_LOOKUP_HANDLE_MISMATCH/u,
  );
});

test("Para AI direct LinkedIn lookup returns null so the CRM walk can still run", async () => {
  resetCurrentParaformUserCache();
  assert.equal(
    await findCrmCandidateByLinkedin("nobody-here", { lookupImpl: async () => null }),
    null,
  );
  assert.equal(await findCrmCandidateByLinkedin("", {}), null);
});

test("a withdrawn quota procedure cannot block the submit path", async () => {
  // Paraform removed agency.getTalentNetworkDirectSubmitQuota. The read's only
  // power was to block on isAtLimit; an absent procedure cannot report a limit,
  // and a vendor removing a read must never stop our write.
  assert.equal(procedureMissing({ code: "-32004" }), true);
  assert.equal(
    procedureMissing({ message: 'No procedure found on path "agency.getTalentNetworkDirectSubmitQuota"' }),
    true,
  );
  assert.equal(procedureMissing({ code: "AUTH_EXPIRED", message: "AUTH_EXPIRED" }), false);
  assert.equal(procedureMissing({ code: "HTTP_500", message: "Paraform HTTP 500" }), false);
});
