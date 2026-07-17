import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { candidateAlreadySubmitted, fetchCall, findIdentity, normLinkedin, normalizeEmail, paraAIConfig, resumeContact, scoreIdentity, uploadResume } from "../api/paraai/_lib/core.mjs";
import { PARAAI_LOCATIONS, extractPreferences, extraNote, normalizeExtraction } from "../api/paraai/_lib/extract.mjs";
import { PARAAI_SALARY_CAP, STATES, buildPreferences, matchCountFromResponse, missingRequiredPreferences, normalizeParaAIPreferences, scoreSelectedIdentity, submitJob, targetSequenceName } from "../api/paraai/_lib/pipeline.mjs";
import { resolveCandidateCall, searchCandidates, selectedCallMatch } from "../api/paraai/_lib/search.mjs";
import { reclaimableLegacyJobLock } from "../api/paraai/_lib/store.mjs";

test("LinkedIn normalization repairs profile paths and rejects non-profiles", () => {
  assert.equal(normLinkedin("linkedin.com/alice-example"), "https://www.linkedin.com/in/alice-example");
  assert.equal(normLinkedin("https://linkedin.com/in/Alice-Example/?x=1"), "https://www.linkedin.com/in/alice-example");
  assert.equal(normLinkedin("https://linkedin.com/company/example"), "");
});

test("identity requires two signals including a strong one", () => {
  const candidate = { fullName: "Alex Example", linkedin: "linkedin.com/in/alex-example", phone: "(415) 555-1212" };
  const exact = { id: "candidate-1", name: "Alex Example", linkedin_user: "alex-example", phone_number: "+1 415 555 1212" };
  const homonym = { id: "candidate-2", name: "Alex Example", linkedin_user: "someone-else", phone_number: "+1 212 555 9999" };
  assert.deepEqual(scoreIdentity(candidate, exact), { signals: ["linkedin", "phone", "name"], ok: true });
  assert.equal(scoreIdentity(candidate, homonym).ok, false);
  assert.equal(findIdentity(candidate, [exact, homonym]).match.id, "candidate-1");
});

test("candidate name search ranks exact and token-prefix Paraform matches", () => {
  const items = [
    { id: "3", name: "Alexandra Example", location: "Austin", updated_at: "2026-07-15" },
    { id: "1", name: "Alex Example", location: "New York", updated_at: "2026-07-10" },
    { id: "2", name: "Alex Smith", location: "Boston", updated_at: "2026-07-16" },
  ];
  assert.deepEqual(searchCandidates(items, "alex ex").map((candidate) => candidate.id), ["1", "3"]);
  assert.equal(searchCandidates(items, "Alex Example")[0].name, "Alex Example");
  assert.deepEqual(searchCandidates(items, "a"), []);
});

test("selected Paraform identity can resolve a call but mismatches still fail closed", () => {
  const crm = { id: "candidate-1", name: "Alex Example", linkedin_user: "alex-example", phone_number: "+1 415 555 1212" };
  const call = { candidate: { fullName: "Alex Example", linkedin: "https://linkedin.com/in/alex-example", phone: "(415) 555-1212" } };
  assert.equal(selectedCallMatch(crm, call, 1).confidence, "strong");
  assert.equal(selectedCallMatch({ ...crm, linkedin_user: "" }, { candidate: { fullName: "Alex Example" } }, 1).confidence, "selected_unique_name");
  assert.equal(selectedCallMatch({ ...crm, linkedin_user: "" }, { candidate: { fullName: "Alex Example" } }, 2).ok, false);
  assert.equal(scoreSelectedIdentity(call.candidate, crm).ok, true);
  assert.equal(scoreSelectedIdentity({ fullName: "Jordan Other" }, crm).ok, false);
});

test("selected candidate resolution skips failed calls and returns the newest verified success", async () => {
  const crm = { id: "candidate-1", name: "Alex Example", linkedin_user: "alex-example", phone_number: "+1 415 555 1212" };
  const fetchImpl = async () => new Response(JSON.stringify({ results: [
    { botId: "bot-failed", name: "Alex Example", linkedin: "https://linkedin.com/in/alex-example", joinAt: "2026-07-16T10:00:00Z" },
    { botId: "bot-success", name: "Alex Example", linkedin: "https://linkedin.com/in/alex-example", joinAt: "2026-07-15T10:00:00Z" },
  ] }), { status: 200, headers: { "content-type": "application/json" } });
  const fetchCallImpl = async (botId) => botId === "bot-failed"
    ? { botId, candidate: { fullName: "Alex Example", linkedin: "https://linkedin.com/in/alex-example" }, verdict: { verdict: "no_show" } }
    : { botId, joinAt: "2026-07-15T10:00:00Z", candidate: { fullName: "Alex Example", linkedin: "https://linkedin.com/in/alex-example", phone: "415-555-1212" }, verdict: { verdict: "success" } };
  const result = await resolveCandidateCall(crm, [crm], { fetchImpl, fetchCallImpl });
  assert.equal(result.call.botId, "bot-success");
  assert.equal(result.call.confidence, "strong");
});

test("automatic call reads bypass the Calls API verdict cache", async () => {
  let request = null;
  const result = await fetchCall("bot_12345678", {
    now: () => 1_784_267_374_599,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ botId: "bot_12345678" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const url = new URL(request.url);
  assert.equal(url.searchParams.get("bot"), "bot_12345678");
  assert.equal(url.searchParams.get("fresh"), "1784267374599");
  assert.equal(request.options.headers["cache-control"], "no-cache");
  assert.equal(request.options.headers.pragma, "no-cache");
  assert.equal(request.options.cache, "no-store");
  assert.equal(result.botId, "bot_12345678");
});

test("email normalization rejects Paraform relay addresses", () => {
  assert.equal(normalizeEmail(" Candidate@Example.COM "), "candidate@example.com");
  assert.equal(normalizeEmail("relay@paraform.com"), "");
  assert.equal(normalizeEmail("david@raydar.xyz"), "");
});

test("extraction normalization keeps only supported enums and base-only compensation", () => {
  const extracted = normalizeExtraction({
    locations: ["New York", "New York", ""],
    paraformLocations: ["new_york", "moon"],
    relocation: { open: true, scope: "anywhere US" },
    workplaceTypes: ["REMOTE", "SPACE_STATION"],
    compensation: { baseMin: 180000, baseMax: 210000, ote: null },
    companyStages: ["SERIES_A", "IPO"],
    sponsorship: { required: false, statuses: ["CITIZEN", "MAYBE"], kind: "none" },
    otherInterviewProcesses: { count: 2, stages: ["onsite"], details: "one late stage" },
  });
  assert.deepEqual(extracted.locations, ["New York"]);
  assert.deepEqual(extracted.paraformLocations, ["new_york"]);
  assert.deepEqual(extracted.workplaceTypes, ["REMOTE"]);
  assert.deepEqual(extracted.companyStages, ["SERIES_A"]);
  assert.deepEqual(extracted.sponsorship.statuses, ["CITIZEN"]);
  const preferences = buildPreferences(extracted);
  assert.equal(preferences.salaryMin, 180000);
  assert.deepEqual(preferences.locations, [...PARAAI_LOCATIONS]);
  assert.deepEqual(preferences.requiresSponsorship, ["Not available"]);
  assert.equal("salaryMax" in preferences, false);
  assert.match(extraNote(extracted), /2 process\(es\)/);
});

test("golden transcript is sent once and parsed from the forced structured tool", async () => {
  const beforeAnthropic = process.env.ANTHROPIC_API_KEY;
  const beforeOpenAI = process.env.OPENAI_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-only";
  delete process.env.OPENAI_API_KEY;
  const transcript = JSON.parse(await readFile(new URL("./fixtures/paraai-screen.json", import.meta.url), "utf8"));
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    calls++;
    const request = JSON.parse(options.body);
    assert.equal(request.tool_choice.name, "record_candidate_preferences");
    assert.equal(request.messages.length, 1);
    assert.equal("temperature" in request, false);
    return new Response(JSON.stringify({
      model: "claude-fable-5",
      usage: { input_tokens: 100, output_tokens: 50 },
      content: [{ type: "tool_use", name: "record_candidate_preferences", input: {
        locations: ["New York"], paraformLocations: ["new_york"],
        relocation: { open: true, scope: "anywhere US" },
        workplaceTypes: ["REMOTE"],
        compensation: { baseMin: 180000, baseMax: 210000, ote: null, currency: "USD", notes: "equity separate" },
        otherInterviewProcesses: { count: 2, stages: ["onsite"], details: null },
        sponsorship: { required: false, statuses: ["CITIZEN"], kind: null },
      } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await extractPreferences(transcript, { fetchImpl });
    assert.equal(calls, 1);
    assert.equal(result.provider, "anthropic");
    assert.equal(result.extracted.compensation.baseMin, 180000);
    assert.equal(result.extracted.compensation.ote, null);
    assert.equal(result.extracted.otherInterviewProcesses.count, 2);
  } finally {
    if (beforeAnthropic == null) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = beforeAnthropic;
    if (beforeOpenAI == null) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = beforeOpenAI;
  }
});

test("OpenAI structured extraction takes over when Anthropic is unavailable", async () => {
  const beforeAnthropic = process.env.ANTHROPIC_API_KEY;
  const beforeOpenAI = process.env.OPENAI_API_KEY;
  process.env.ANTHROPIC_API_KEY = "anthropic-test-only";
  process.env.OPENAI_API_KEY = "openai-test-only";
  const transcript = [{ role: "candidate", speaker: "Alex", text: "New York, remote, Series A, $180k base, and I am a citizen." }];
  const urls = [];
  const fetchImpl = async (url, options) => {
    urls.push(url);
    if (url.includes("anthropic.com")) {
      return new Response(JSON.stringify({ error: { message: "credit balance is too low" } }), { status: 402, headers: { "content-type": "application/json" } });
    }
    const request = JSON.parse(options.body);
    assert.equal(request.model, "gpt-5.6-luna");
    assert.equal(request.reasoning_effort, "none");
    assert.equal(request.tool_choice.function.name, "record_candidate_preferences");
    assert.equal("temperature" in request, false);
    return new Response(JSON.stringify({
      model: "gpt-5.6-luna",
      usage: { prompt_tokens: 40, completion_tokens: 20 },
      choices: [{ message: { tool_calls: [{ function: { name: "record_candidate_preferences", arguments: JSON.stringify({
        locations: ["New York"], paraformLocations: ["new_york"], workplaceTypes: ["REMOTE"], companyStages: ["SERIES_A"],
        compensation: { baseMin: 180000 }, sponsorship: { required: false, statuses: ["CITIZEN"] },
      }) } }] } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await extractPreferences(transcript, { fetchImpl });
    assert.deepEqual(urls, ["https://api.anthropic.com/v1/messages", "https://api.openai.com/v1/chat/completions"]);
    assert.equal(result.provider, "openai");
    assert.equal(result.extracted.compensation.baseMin, 180000);
  } finally {
    if (beforeAnthropic == null) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = beforeAnthropic;
    if (beforeOpenAI == null) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = beforeOpenAI;
  }
});

test("Para AI payload uses exact enums and enforces the salary ceiling", () => {
  const preferences = normalizeParaAIPreferences({
    locations: ["new_york", "New York", "moon"],
    workplaceTypes: ["remote", "ON_SITE"],
    idealFundingRounds: ["series_a", "NO_PREFERENCE"],
    requiresSponsorship: ["Not available", "CITIZEN"],
    salaryMin: 400000,
  });
  assert.deepEqual(preferences.locations, ["new_york"]);
  assert.deepEqual(preferences.workplaceTypes, ["REMOTE", "ON_SITE"]);
  assert.deepEqual(preferences.idealFundingRounds, ["SERIES_A"]);
  assert.deepEqual(preferences.requiresSponsorship, ["Not available"]);
  assert.equal(preferences.salaryMin, PARAAI_SALARY_CAP);
});

test("native candidate preferences are a fallback for missing transcript enums", () => {
  const preferences = buildPreferences(normalizeExtraction({ compensation: { baseMin: 400000 } }), {
    locations: ["texas", "florida"], workplace: ["REMOTE", "HYBRID"],
    last_funding_round: ["SERIES_B"], visa: ["Available"], salary_min: 350000,
  });
  assert.deepEqual(preferences.locations, ["texas", "florida"]);
  assert.deepEqual(preferences.idealFundingRounds, ["SERIES_B"]);
  assert.deepEqual(preferences.requiresSponsorship, ["Available"]);
  assert.equal(preferences.salaryMin, 200000);
});

test("Para AI required preference validation rejects display labels and names missing native fields", () => {
  assert.deepEqual(missingRequiredPreferences({ locations: ["New York"] }), [
    "locations", "workplace types", "company stages", "minimum base salary", "visa sponsorship",
  ]);
  assert.deepEqual(missingRequiredPreferences({
    locations: ["new_york"], workplaceTypes: ["REMOTE"], idealFundingRounds: ["SERIES_A"],
    salaryMin: 180000, requiresSponsorship: ["Not available"],
  }), []);
  assert.deepEqual(missingRequiredPreferences({
    locations: ["new_york"], workplaceTypes: ["REMOTE"], idealFundingRounds: ["UNKNOWN"],
    salaryMin: 180000, ote: 170000, requiresSponsorship: ["Available"],
  }), ["OTE (must be at least minimum base salary)"]);
});

test("Para AI submit cannot bypass the market attestation", async () => {
  const job = { id: "bot-attest-001", state: "ready_to_submit", revision: 1 };
  await assert.rejects(
    submitJob(job, { confirmation: `SUBMIT ${job.id}` }),
    (error) => error?.code === "MARKET_CONFIRMATION_REQUIRED",
  );
});

test("Paraform submission acceptance is asynchronous and recognizes native status signals", () => {
  assert.equal(STATES.has("awaiting_approval"), true);
  assert.equal(candidateAlreadySubmitted({ talent_network_submitted_at: "2026-07-16T18:47:00Z" }), true);
  assert.equal(candidateAlreadySubmitted({ profile: { has_application_submission_ever: true } }), true);
  assert.equal(candidateAlreadySubmitted({ matchingPoolStatus: "RECRUITER_ON_MARKET" }), true);
  assert.equal(candidateAlreadySubmitted({ matching_pool_status: "NOT_SUBMITTED" }), false);
});

test("only expired legacy locks on an unwritten submission can be reclaimed", () => {
  assert.equal(reclaimableLegacyJobLock("legacy-token", 210, "ready_to_submit"), true);
  assert.equal(reclaimableLegacyJobLock("legacy-token", 211, "ready_to_submit"), false);
  assert.equal(reclaimableLegacyJobLock("v2:new-token", 1, "ready_to_submit"), false);
  assert.equal(reclaimableLegacyJobLock("legacy-token", 1, "submitting"), false);
  assert.equal(reclaimableLegacyJobLock("legacy-token", -1, "ready_to_submit"), false);
});

test("resume upload uses Paraform queries around the signed storage POST", async () => {
  const calls = [];
  const storageId = "54f6ff9c-75bd-4bcc-82bd-925d229a35d9";
  const result = await uploadResume(
    { bytes: Buffer.from("%PDF-1.7 test"), fileName: "candidate.pdf" },
    {
      trpcGetImpl: async (procedure, input) => {
        calls.push(["query", procedure, input]);
        return {
          url: "https://uploads.example.test/resume",
          fields: { key: "resumes/candidate.pdf", policy: "signed-policy" },
          resumeUri: "s3://resumes/candidate.pdf",
        };
      },
      fetchImpl: async (url, options) => {
        calls.push(["upload", url, options.method]);
        assert.equal(options.body.get("key"), "resumes/candidate.pdf");
        assert.equal(options.body.get("policy"), "signed-policy");
        assert.equal(options.body.get("file").type, "application/pdf");
        assert.equal(options.body.get("file").name, "candidate.pdf");
        return new Response(null, { status: 204 });
      },
      resumeContactImpl: async (resumeUri) => {
        calls.push(["contact-query", resumeUri]);
        return { email: "candidate@example.com" };
      },
      uuidImpl: () => storageId,
    },
  );
  assert.deepEqual(calls, [
    ["query", "file.getResumeUploadUrl", { fileName: storageId }],
    ["upload", "https://uploads.example.test/resume", "POST"],
    ["contact-query", "s3://resumes/candidate.pdf"],
  ]);
  assert.deepEqual(result, {
    resumeUri: "s3://resumes/candidate.pdf",
    contact: { email: "candidate@example.com" },
  });

  const contactCalls = [];
  await resumeContact("s3://resumes/candidate.pdf", {
    trpcGetImpl: async (procedure, input) => contactCalls.push([procedure, input]),
  });
  assert.deepEqual(contactCalls, [[
    "candidateUser.extractResumeContactFields",
    { resumeUri: "s3://resumes/candidate.pdf" },
  ]]);
});

test("current Paraform CRM submission origin is accepted as pinned", () => {
  const before = process.env.PARAAI_SUBMISSION_ORIGIN;
  process.env.PARAAI_SUBMISSION_ORIGIN = "CRM";
  try { assert.equal(paraAIConfig().submissionOriginPinned, true); }
  finally {
    if (before == null) delete process.env.PARAAI_SUBMISSION_ORIGIN;
    else process.env.PARAAI_SUBMISSION_ORIGIN = before;
  }
});

test("match result parser supports pinned response candidates without guessing pending", () => {
  assert.deepEqual(matchCountFromResponse([{ id: 1 }]), { count: 1, settled: true });
  assert.deepEqual(matchCountFromResponse({ match_potential_role_count: 3 }), { count: 3, settled: true });
  assert.deepEqual(matchCountFromResponse({ paraai_matches: [] }), { count: 0, settled: true });
  assert.deepEqual(matchCountFromResponse({ status: "PROCESSING", matches: [] }), { count: null, settled: false });
  assert.deepEqual(matchCountFromResponse({ unexpected: true }), { count: null, settled: false });
});

test("match count selects the exact target sequence", () => {
  assert.equal(targetSequenceName(1), "New Matches - Added to Para AI (one role)");
  assert.equal(targetSequenceName(2), "New Matches - Added to Para AI (multiple)");
});

test("Para AI HTML inline JavaScript parses", async () => {
  const html = await readFile(new URL("../paraai.html", import.meta.url), "utf8");
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map((match) => match[1]).filter((source) => source.trim());
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Function(scripts[0]));
  assert.match(html, /I have screened this candidate and confirmed they are actively on the market/);
  assert.match(html, /max="200000"/);
  assert.match(html, /async function submitReviewedBody/);
  assert.match(html, /function reconcileOpenReview/);
  assert.match(html, /latest\.state!=='ready_to_submit'/);
  assert.match(html, /expectedRevision:latest\.revision/);
  assert.match(html, /action:'reconcile-submit'/);
  assert.match(html, /Accepted by Paraform\. Approval may take a couple minutes/);
  assert.doesNotMatch(html, /action:\s*["']direct-submit/);
  const run = await readFile(new URL("../api/paraai/run.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(run, /["']direct-submit["']/);
  const pipeline = await readFile(new URL("../api/paraai/_lib/pipeline.mjs", import.meta.url), "utf8");
  assert.match(pipeline, /transition\(edited, "awaiting_approval"/);
  assert.match(pipeline, /export async function reconcileSubmittedJob/);
});

test("Vercel config exposes one Para AI page and grouped API duration", async () => {
  const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.deepEqual(config.rewrites.find((row) => row.source === "/paraai"), { source: "/paraai", destination: "/paraai.html" });
  assert.equal(config.functions["api/paraai/*.mjs"].maxDuration, 120);
});
