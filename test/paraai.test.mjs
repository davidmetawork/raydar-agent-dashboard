import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { findIdentity, normLinkedin, normalizeEmail, scoreIdentity } from "../api/paraai/_lib/core.mjs";
import { extractPreferences, extraNote, normalizeExtraction } from "../api/paraai/_lib/extract.mjs";
import { buildPreferences, matchCountFromResponse, targetSequenceName } from "../api/paraai/_lib/pipeline.mjs";

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
  process.env.ANTHROPIC_API_KEY = "test-only";
  const transcript = JSON.parse(await readFile(new URL("./fixtures/paraai-screen.json", import.meta.url), "utf8"));
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    calls++;
    const request = JSON.parse(options.body);
    assert.equal(request.tool_choice.name, "record_candidate_preferences");
    assert.equal(request.messages.length, 1);
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
  const result = await extractPreferences(transcript, { fetchImpl });
  assert.equal(calls, 1);
  assert.equal(result.extracted.compensation.baseMin, 180000);
  assert.equal(result.extracted.otherInterviewProcesses.count, 2);
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
