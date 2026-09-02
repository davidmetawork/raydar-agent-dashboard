import assert from "node:assert/strict";
import test from "node:test";

import {
  collectResumeSourceBundle,
  collectorInternals,
  downloadCandidateResume,
  extractResumePdf,
} from "../api/submissions-v2/_lib/resume/collector.mjs";

test("collector distinguishes missing, denied, and failed reads", () => {
  assert.equal(collectorInternals.statusFor(null), "missing");
  assert.equal(collectorInternals.statusFor(null, { failed: new Error("PARAFORM_PROC_UNAUTHORIZED:role.x") }), "denied");
  assert.equal(collectorInternals.statusFor(null, { failed: new Error("timeout") }), "unreadable");
});

test("intake reconstruction prefers the full transcript and labels summary fallback partial", () => {
  const full = collectorInternals.intakeTurns({
    transcription_json: [{ speaker: "HM", words: [{ text: "A".repeat(220) }] }],
    shorten_transcript: "summary",
  });
  assert.equal(full.partial, false);
  const partial = collectorInternals.intakeTurns({ shorten_transcript: "The team needs a product-minded backend engineer." });
  assert.equal(partial.partial, true);
});

test("collector uses the exact proven Paraform read map and only original resume blocks", async () => {
  const calls = [];
  const trpcGetImpl = async (procedure) => {
    calls.push(procedure);
    const values = {
      "candidateUser.getCandidateUserById": { id: "candidate-1", resume_id: "resume-1" },
      "candidateUser.getCandidateProfileInfo": { name: "Candidate One" },
      "candidateUser.getMostRecentResume": { resume_id: "resume-1" },
      "candidateUserMeeting.getSelectableMeetingsForCandidateUserId": [{ id: "call-1", recording_transcript: [{ speaker: "Candidate", text: "I built reliable data systems." }] }],
      "candidateUser.getLinkedInCandidate": null,
      "candidateUserPreference.getCandidateUserPrefs": null,
      "role.getRoleByIdDetailed": { id: "role-1", title: "Engineer" },
      "role.getBasicRoleInfo": { id: "role-1" },
      "role.getRoleRequirements": { requirements: ["systems"] },
      "company.getCompanyByRoleId": { name: "Example" },
      "meetings.getLatestProcessedMeeting": { id: "intake-1", type: "INTAKE_CALL", transcription: `<p>${"Team context ".repeat(30)}</p>` },
    };
    return values[procedure] ?? null;
  };
  const bundle = await collectResumeSourceBundle({ candidateUserId: "candidate-1", roleId: "role-1" }, {
    trpcGetImpl,
    downloadResumeImpl: async () => Buffer.from("%PDF-practice"),
    extractResumeImpl: async () => ({ text: "Candidate One\nEngineer\nBuilt reliable data systems.", pageCount: 1 }),
    paceMs: 0,
    now: () => Date.parse("2026-09-01T12:00:00.000Z"),
  });
  assert.equal(bundle.readiness.canGenerate, true);
  assert.equal(bundle.sources.find((source) => source.key === "candidate_original_resume").origin, "candidate_original");
  assert.equal(bundle.sources.find((source) => source.key === "candidate_linkedin").status, "missing");
  assert.ok(bundle.readiness.cautions.some((item) => item.sourceKey === "candidate_linkedin"));
  for (const procedure of [
    "candidateUser.getCandidateUserById",
    "candidateUser.getCandidateProfileInfo",
    "candidateUser.getMostRecentResume",
    "candidateUserMeeting.getSelectableMeetingsForCandidateUserId",
    "candidateUser.getLinkedInCandidate",
    "candidateUserPreference.getCandidateUserPrefs",
    "role.getRoleByIdDetailed",
    "role.getRoleRequirements",
    "meetings.getLatestProcessedMeeting",
  ]) assert.ok(calls.includes(procedure), procedure);
});

test("Raydar generated digest does not clear original resume readiness", async () => {
  const pdf = Buffer.from("%PDF-practice");
  const digest = (await import("node:crypto")).createHash("sha256").update(pdf).digest("hex");
  const trpcGetImpl = async (procedure) => ({
    "candidateUser.getCandidateUserById": { id: "candidate-1", resume_id: "resume-1" },
    "candidateUser.getCandidateProfileInfo": {},
    "candidateUser.getMostRecentResume": { resume_id: "resume-1" },
    "candidateUserMeeting.getSelectableMeetingsForCandidateUserId": [],
    "meetings.getAllIntakeAndOnboardingCallsByRoleId": [],
  }[procedure] ?? null);
  const bundle = await collectResumeSourceBundle({
    candidateUserId: "candidate-1", roleId: "role-1", knownRaydarDigests: [digest],
  }, {
    trpcGetImpl,
    downloadResumeImpl: async () => pdf,
    extractResumeImpl: async () => ({ text: "Prior generated resume", pageCount: 1 }),
    paceMs: 0,
    now: () => Date.parse("2026-09-01T12:00:00.000Z"),
  });
  assert.equal(bundle.readiness.canGenerate, false);
  assert.equal(bundle.readiness.blocker.origin, "raydar_generated");
});

test("PDF extraction is bearer authenticated and digest bound", async () => {
  const pdf = Buffer.from("%PDF-practice");
  const digest = (await import("node:crypto")).createHash("sha256").update(pdf).digest("hex");
  const result = await extractResumePdf(pdf, {
    env: { SUBMISSIONS_V2_RENDERER_URL: "https://renderer.example", SUBMISSIONS_V2_RENDERER_KEY: "secret" },
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://renderer.example/extract-v2");
      assert.equal(init.headers.authorization, "Bearer secret");
      return new Response(JSON.stringify({ ok: true, text: "Candidate resume", page_count: 1, pdf_sha256: digest }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(result.text, "Candidate resume");
});

test("signed resume downloads reject unapproved, private, and redirected destinations", async () => {
  const signedResponse = (url) => new Response(JSON.stringify({ url }), {
    status: 200, headers: { "content-type": "application/json" },
  });
  const common = {
    cookieImpl: async () => "session",
    cookieNameImpl: () => "session-cookie",
    env: { SUBMISSIONS_V2_RESUME_DOWNLOAD_HOSTS: "storage.example" },
  };
  await assert.rejects(() => downloadCandidateResume("resume-1", {
    ...common,
    fetchImpl: async () => signedResponse("https://evil.example/resume.pdf"),
    lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
  }), (error) => error.code === "resume_signed_url_invalid");
  await assert.rejects(() => downloadCandidateResume("resume-1", {
    ...common,
    fetchImpl: async () => signedResponse("https://storage.example/resume.pdf"),
    lookupImpl: async () => [{ address: "127.0.0.1", family: 4 }],
  }), (error) => error.code === "resume_signed_url_address_rejected");
  let calls = 0;
  await assert.rejects(() => downloadCandidateResume("resume-1", {
    ...common,
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? signedResponse("https://storage.example/resume.pdf")
        : new Response(null, { status: 302, headers: { location: "https://evil.example/private" } });
    },
    lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
  }), (error) => error.code === "resume_signed_url_invalid");
  assert.equal(calls, 2);
  for (const address of [
    "10.0.0.1", "169.254.1.1", "198.18.0.1", "::ffff:172.16.0.1", "2001:db8::1",
    "0:0:0:0:0:0:0:1", "0:0:0:0:0:ffff:7f00:1", "fd00:0:0:0:0:0:0:1", "fe80:0:0:0:0:0:0:1",
  ]) {
    assert.equal(collectorInternals.privateAddress(address), true, address);
  }
  assert.equal(collectorInternals.privateAddress("2606:2800:220:1:248:1893:25c8:1946"), false);
});
