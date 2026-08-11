import test from "node:test";
import assert from "node:assert/strict";

import {
  SEQUENCES_UNMATCHED_LINKEDIN_CREATE_GRANT_VALUE,
  SEQUENCE_IDENTITY_AUTHORITY_REQUIRED,
  createCandidate,
  resolveSequenceCandidate,
  sequencesUnmatchedLinkedinCreateGranted,
} from "../api/seq/_lib/core.mjs";

test("Sequences unmatched candidate creation is default-off", async () => {
  const calls = [];
  const result = await createCandidate(
    "https://www.linkedin.com/in/synthetic-candidate",
    {
      createGrant: "",
      async postImpl(...args) { calls.push(args); },
    },
  );
  assert.deepEqual(result, {
    id: null,
    status: "parked",
    parked: true,
    reason: SEQUENCE_IDENTITY_AUTHORITY_REQUIRED,
  });
  assert.deepEqual(calls, []);
  assert.equal(sequencesUnmatchedLinkedinCreateGranted(""), false);
  assert.equal(sequencesUnmatchedLinkedinCreateGranted("true"), false);
});

test("only the separately named exact create grant reaches Paraform", async () => {
  const calls = [];
  const result = await createCandidate(
    "https://www.linkedin.com/in/synthetic-candidate",
    {
      createGrant: SEQUENCES_UNMATCHED_LINKEDIN_CREATE_GRANT_VALUE,
      async postImpl(procedure, input) {
        calls.push({ procedure, input });
        return { candidate_user_id: "candidate-user-1", status: "new" };
      },
    },
  );
  assert.deepEqual(calls, [{
    procedure: "candidates.createExternalCandidateFromManual",
    input: { linkedin_url: "https://www.linkedin.com/in/synthetic-candidate" },
  }]);
  assert.deepEqual(result, {
    id: "candidate-user-1",
    status: "new",
    parked: false,
  });
});

test("an existing candidate bypasses the create interlock unchanged", async () => {
  let createCalls = 0;
  const result = await resolveSequenceCandidate({
    candidate_user_id: "candidate-user-existing",
    email: "existing@example.test",
    linkedinUrl: "https://www.linkedin.com/in/changed-vanity-alias",
  }, {
    async createCandidateImpl() {
      createCalls++;
      throw new Error("CREATE_MUST_NOT_RUN");
    },
  });
  assert.deepEqual(result, {
    ok: true,
    cu: "candidate-user-existing",
    email: "existing@example.test",
    isNew: false,
  });
  assert.equal(createCalls, 0);
});

test("an unmatched LinkedIn row is parked instead of counted as a create failure", async () => {
  const result = await resolveSequenceCandidate({
    candidate_user_id: null,
    email: "unmatched@example.test",
    linkedinUrl: "https://www.linkedin.com/in/unmatched-synthetic",
  }, {
    async createCandidateImpl() {
      return {
        id: null,
        status: "parked",
        parked: true,
        reason: SEQUENCE_IDENTITY_AUTHORITY_REQUIRED,
      };
    },
  });
  assert.deepEqual(result, {
    ok: false,
    email: "unmatched@example.test",
    parkedIdentity: true,
    reason: SEQUENCE_IDENTITY_AUTHORITY_REQUIRED,
  });
});
