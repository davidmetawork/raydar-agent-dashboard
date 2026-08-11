import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  SEQUENCE_IDENTITY_AUTHORITY_REQUIRED,
  resolveSequenceCandidate,
} from "../api/seq/_lib/core.mjs";

test("Sequences runtime contains no candidate-create capability or grant", async () => {
  const runtime = (await Promise.all([
    "../api/seq/_lib/core.mjs",
    "../api/seq/enroll.mjs",
    "../api/seq/preview.mjs",
  ].map((path) => readFile(new URL(path, import.meta.url), "utf8")))).join("\n");
  assert.doesNotMatch(runtime, /createExternalCandidateFromManual/u);
  assert.doesNotMatch(runtime, /SEQUENCES_UNMATCHED_LINKEDIN_CREATE_GRANT/u);
});

test("an existing candidate keeps the resolved write path unchanged", async () => {
  const result = await resolveSequenceCandidate({
    candidate_user_id: "candidate-user-existing",
    email: "existing@example.test",
    linkedinUrl: "https://www.linkedin.com/in/changed-vanity-alias",
  });
  assert.deepEqual(result, {
    ok: true,
    cu: "candidate-user-existing",
    email: "existing@example.test",
    isNew: false,
  });
});

test("an unmatched LinkedIn row always parks for identity authority", async () => {
  const result = await resolveSequenceCandidate({
    candidate_user_id: null,
    email: "unmatched@example.test",
    linkedinUrl: "https://www.linkedin.com/in/unmatched-synthetic",
  });
  assert.deepEqual(result, {
    ok: false,
    email: "unmatched@example.test",
    parkedIdentity: true,
    reason: SEQUENCE_IDENTITY_AUTHORITY_REQUIRED,
  });
});

test("an unmatched row without a LinkedIn URL also parks", async () => {
  const result = await resolveSequenceCandidate({
    candidate_user_id: null,
    email: "email-only@example.test",
    linkedinUrl: "",
  });
  assert.deepEqual(result, {
    ok: false,
    email: "email-only@example.test",
    parkedIdentity: true,
    reason: SEQUENCE_IDENTITY_AUTHORITY_REQUIRED,
  });
});
