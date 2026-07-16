import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { findIdentity, normLinkedin, normalizeEmail, paraAIConfig, scoreIdentity } from "../api/paraai/_lib/core.mjs";
import { extractPreferences, extraNote, normalizeExtraction } from "../api/paraai/_lib/extract.mjs";
import { buildPreferences, matchCountFromResponse, missingRequiredPreferences, prepareAndSubmitJob, scoreSelectedIdentity, targetSequenceName } from "../api/paraai/_lib/pipeline.mjs";
import { resolveCandidateCall, searchCandidates, selectedCallMatch } from "../api/paraai/_lib/search.mjs";

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

test("email normalization rejects Paraform relay addresses", () => {
  assert.equal(normalizeEmail(" Candidate@Example.COM "), "candidate@example.com");
  assert.equal(normalizeEmail("relay@paraform.com"), "");
  assert.equal(normalizeEmail("david@raydar.xyz"), "");
});

test("extraction normalization keeps only supported enums and base-only compensation", () => {
  const extracted = normalizeExtraction({
    locations: ["New York", "New York", ""],
    relocation: { open: true, scope: "anywhere US" },
    workplaceTypes: ["REMOTE", "SPACE_STATION"],
    compensation: { baseMin: 180000, baseMax: 210000, ote: null },
    companyStages: ["SERIES_A", "IPO"],
    sponsorship: { required: false, statuses: ["CITIZEN", "MAYBE"], kind: "none" },
    otherInterviewProcesses: { count: 2, stages: ["onsite"], details: "one late stage" },
  });
  assert.deepEqual(extracted.locations, ["New York"]);
  assert.deepEqual(extracted.workplaceTypes, ["REMOTE"]);
  assert.deepEqual(extracted.companyStages, ["SERIES_A"]);
  assert.deepEqual(extracted.sponsorship.statuses, ["CITIZEN"]);
  const preferences = buildPreferences(extracted);
  assert.equal(preferences.salaryMin, 180000);
  assert.ok(preferences.locations.includes("Open to relocate: anywhere US"));
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
        locations: ["New York"],
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
        locations: ["New York"], workplaceTypes: ["REMOTE"], companyStages: ["SERIES_A"],
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

test("direct submit prepares and submits the selected candidate in one action", async () => {
  const calls = [];
  const prepared = { id: "bot-direct-001", state: "ready_to_submit", revision: 3 };
  const result = await prepareAndSubmitJob(
    { botId: prepared.id, candidateUserId: "candidate-1", resumeBase64: "cGRm", resumeFileName: "resume.pdf" },
    {
      getJobImpl: async () => null,
      prepareImpl: async (input) => { calls.push(["prepare", input]); return prepared; },
      submitImpl: async (job, body) => { calls.push(["submit", job, body]); return { ...job, state: "awaiting_matches" }; },
    },
  );
  assert.equal(result.state, "awaiting_matches");
  assert.deepEqual(calls[0], ["prepare", { botId: prepared.id, candidateUserId: "candidate-1", force: true }]);
  assert.equal(calls[1][2].confirmation, `SUBMIT ${prepared.id}`);
  assert.equal(calls[1][2].resumeFileName, "resume.pdf");
});

test("direct submit is idempotent after the Para AI write", async () => {
  const existing = { id: "bot-direct-002", state: "awaiting_matches", revision: 8 };
  let prepared = false;
  const result = await prepareAndSubmitJob(
    { botId: existing.id, candidateUserId: "candidate-2" },
    { getJobImpl: async () => existing, prepareImpl: async () => { prepared = true; } },
  );
  assert.equal(result, existing);
  assert.equal(prepared, false);
});

test("Para AI required preference validation names missing native fields", () => {
  assert.deepEqual(missingRequiredPreferences({ locations: ["New York"] }), [
    "workplace types", "company stages", "minimum base salary", "work authorization",
  ]);
  assert.deepEqual(missingRequiredPreferences({
    locations: ["New York"], workplaceTypes: ["REMOTE"], idealFundingRounds: ["SERIES_A"],
    salaryMin: 180000, requiresSponsorship: ["CITIZEN"],
  }), []);
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
});

test("Vercel config exposes one Para AI page and grouped API duration", async () => {
  const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.deepEqual(config.rewrites.find((row) => row.source === "/paraai"), { source: "/paraai", destination: "/paraai.html" });
  assert.equal(config.functions["api/paraai/*.mjs"].maxDuration, 120);
});
