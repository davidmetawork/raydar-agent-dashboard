import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  PROFILE_REPLACEMENT_COPY,
  attachResume,
  generateResume,
  normalizeCareerHistory,
  replaceProfileResume,
  selectResumeId,
  validatePresignTarget,
} from "../api/submissions/_lib/resume.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const row = {
  key: "row-key",
  path: "B",
  candidateUserId: "candidate-user",
  candidateName: "Candidate",
  roleId: "role-id",
  roleName: "Role",
  companyName: "Company",
};
const snapshot = { trustworthy: true, generatedAt: new Date().toISOString(), rows: [row] };
const lockDeps = {
  readSnapshotImpl: async () => snapshot,
  writeSnapshotImpl: async () => {},
  acquireLockImpl: async () => "lock",
  releaseLockImpl: async () => true,
};

test("career history normalizes all three captured Paraform shapes without retitling", () => {
  const rows = normalizeCareerHistory(
    { experiences: [{ id: "crm", title: "Engineer", name: "CRM Company", description: "Built systems." }] },
    { candidate: { experiences: [{ id: "point", title: "Lead", company_name: "Point Company", facts: ["Led team."] }] } },
    { profile: { positions: [{ id: "linkedin", position: "Founder", company: { name: "LinkedIn Company" }, highlights: ["Founded company."] }] } },
  );
  assert.deepEqual(rows.map((item) => [item.title, item.company]), [
    ["Engineer", "CRM Company"],
    ["Lead", "Point Company"],
    ["Founder", "LinkedIn Company"],
  ]);
  assert.deepEqual(rows.map((item) => item.facts[0]), ["Built systems.", "Led team.", "Founded company."]);
});

test("resume identity selection uses only known resume fields", () => {
  assert.equal(selectResumeId([{ latest_application_resume_id: "resume-a" }]), "resume-a");
  assert.equal(selectResumeId({ candidate: { resume_id: "resume-b" } }), "resume-b");
  assert.equal(selectResumeId({ id: "candidate-not-a-resume" }), null);
});

test("profile upload rejects a presign that could point at another object", () => {
  assert.throws(
    () => validatePresignTarget({
      url: "https://storage.googleapis.com/paraform-resumes-new",
      fields: { key: "another-object" },
      resumeUri: "another-object",
    }, "expected-object"),
    (error) => error.code === "PRESIGN_OBJECT_KEY_MISMATCH",
  );
});

test("profile replacement uses the captured Date metadata and exact readback", async () => {
  const calls = [];
  const result = await replaceProfileResume({
    candidateUserId: "candidate-user",
    pdfBytes: Buffer.from("%PDF-1.7\nresume"),
  }, {
    trpcGetImpl: async (procedure, input) => {
      calls.push({ procedure, input });
      return {
        url: "https://storage.googleapis.com/paraform-resumes-new",
        fields: { key: input.fileName },
        resumeUri: input.fileName,
      };
    },
    trpcPostWithDatesImpl: async (procedure, input, dateFields) => {
      calls.push({ procedure, input, dateFields });
    },
    fetchImpl: async () => ({ ok: true, status: 204 }),
    getResumeImpl: async () => ({ resume_id: calls[0].input.fileName }),
  });
  assert.equal(result.writeReturned, true);
  assert.equal(calls[0].procedure, "file.getSignedUploadUrl");
  assert.equal(calls[1].procedure, "candidateUser.updateCandidateUser");
  assert.deepEqual(calls[1].dateFields, ["fields.resume_uploaded_at.value"]);
  assert.equal(calls[1].input.fields.resume_id.value, result.resumeId);
  assert.equal(calls[1].input.fields.resume_id.allow_overwrite, true);
});

test("an ambiguous profile replacement is never replayed", async () => {
  let writes = 0;
  await assert.rejects(
    () => replaceProfileResume({
      candidateUserId: "candidate-user",
      pdfBytes: Buffer.from("%PDF-1.7\nresume"),
    }, {
      trpcGetImpl: async (_procedure, input) => ({
        url: "https://storage.googleapis.com/paraform-resumes-new",
        fields: { key: input.fileName },
        resumeUri: input.fileName,
      }),
      trpcPostWithDatesImpl: async () => { writes += 1; throw new Error("timeout"); },
      fetchImpl: async () => ({ ok: true, status: 204 }),
      getResumeImpl: async () => ({ resume_id: "incumbent" }),
    }),
    (error) => error.code === "RESUME_ATTACH_AMBIGUOUS",
  );
  assert.equal(writes, 1);
});

test("generation stores PDF, ATS and manifest as a new private version", async () => {
  const puts = [];
  let ledgerPatch = null;
  const renderedPdf = Buffer.from("%PDF-1.7\nrendered");
  const renderedText = "Candidate\n\nEXPERIENCE\n";
  const result = await generateResume({
    action: "generate",
    key: row.key,
    candidateUserId: row.candidateUserId,
    roleId: row.roleId,
    by: "team@example.com",
  }, {
    ...lockDeps,
    readLedgerImpl: async () => ({
      resumeArtifacts: [{ id: "old", version: 2 }],
    }),
    readInputsImpl: async () => ({
      careerHistory: [{ id: "job", title: "Engineer", company: "Company", facts: ["Built systems."] }],
      candidate: { name: "Candidate" },
      role: { title: "Role" },
      resume: null,
      profile: {},
    }),
    rendererImpl: async () => ({
      ok: true,
      pdf: renderedPdf,
      pdfSha256: sha(renderedPdf),
      atsText: renderedText,
      atsSha256: sha(renderedText),
      document: { name: "Candidate", experiences: [] },
      manifest: { schemaVersion: 1, allowedFacts: ["Built systems."], canonicalJobs: [] },
      source: "Paraform cached career history",
      mode: "tailored",
      model: "claude-test",
      pages: 1,
    }),
    putBlobImpl: async (pathname, body, options) => {
      puts.push({ pathname, body, options });
      return { pathname };
    },
    appendLedgerImpl: async (_candidateUserId, _roleId, _event, patch) => {
      ledgerPatch = patch;
      return { ...patch };
    },
  });
  assert.equal(result.artifact.version, 3);
  assert.equal(puts.length, 3);
  assert.deepEqual(puts.map((item) => item.options.access), ["private", "private", "private"]);
  assert.match(puts[0].pathname, /\/3-[a-f0-9-]+\.pdf$/u);
  assert.match(puts[1].pathname, /\.txt$/u);
  assert.match(puts[2].pathname, /\.json$/u);
  assert.equal(ledgerPatch.resumeArtifacts.at(-1).version, 3);
  assert.equal(ledgerPatch.resumeUnavailableReason, null);
});

test("no career history becomes a durable disabled reason", async () => {
  let nextLedger = null;
  await assert.rejects(
    () => generateResume({
      action: "generate",
      key: row.key,
      candidateUserId: row.candidateUserId,
      roleId: row.roleId,
      by: "team@example.com",
    }, {
      ...lockDeps,
      readLedgerImpl: async () => ({}),
      readInputsImpl: async () => ({ careerHistory: [] }),
      appendLedgerImpl: async (_candidateUserId, _roleId, event, patch) => {
        nextLedger = { event, ...patch };
        return nextLedger;
      },
    }),
    (error) => error.code === "NO_CAREER_HISTORY",
  );
  assert.equal(nextLedger.resumeUnavailableReason, "no_career_history");
});

test("attach requires the exact destructive consequence copy before taking a lock", async () => {
  let locked = false;
  await assert.rejects(
    () => attachResume({
      action: "attach",
      key: row.key,
      candidateUserId: row.candidateUserId,
      roleId: row.roleId,
      artifactId: "artifact",
      confirmProfileReplacement: true,
      confirmationCopy: "replace it",
    }, {
      ...lockDeps,
      acquireLockImpl: async () => { locked = true; return "lock"; },
    }),
    (error) => error.code === "RESUME_REPLACEMENT_CONFIRMATION_REQUIRED",
  );
  assert.equal(PROFILE_REPLACEMENT_COPY, "this replaces their profile resume.");
  assert.equal(locked, false);
});

test("attach blocks when the incumbent profile resume changed after generation", async () => {
  const artifact = {
    id: "artifact",
    version: 1,
    pdfPath: "resume.pdf",
    manifestPath: "resume.json",
  };
  let replaced = false;
  await assert.rejects(
    () => attachResume({
      action: "attach",
      key: row.key,
      candidateUserId: row.candidateUserId,
      roleId: row.roleId,
      artifactId: artifact.id,
      confirmProfileReplacement: true,
      confirmationCopy: PROFILE_REPLACEMENT_COPY,
    }, {
      ...lockDeps,
      readLedgerImpl: async () => ({ resumeArtifacts: [artifact], currentResumeArtifactId: artifact.id }),
      getBlobImpl: async () => ({
        statusCode: 200,
        stream: new Blob([JSON.stringify({ sourceResumeId: "resume-at-generation" })]).stream(),
      }),
      getResumeImpl: async () => ({ resume_id: "newer-profile-resume" }),
      replaceProfileImpl: async () => { replaced = true; },
    }),
    (error) => error.code === "RESUME_PROFILE_CHANGED",
  );
  assert.equal(replaced, false);
});
