// One-call screening transcript extractor. Every provider is forced through
// the same structured tool, then normalized before it can reach a Paraform
// payload or the review UI.

export const WORKPLACE_TYPES = new Set(["REMOTE", "HYBRID", "ON_SITE"]);
export const FUNDING_ROUNDS = new Set(["PRE_SEED", "SEED", "SERIES_A", "SERIES_B", "SERIES_C", "SERIES_D_PLUS", "UNKNOWN"]);
export const SPONSORSHIP_STATUSES = new Set(["CITIZEN", "VISA", "GREEN_CARD"]);
export const PARAAI_LOCATIONS = new Set([
  "new_york", "san_francisco", "south_bay_area", "los_angeles", "boston", "seattle",
  "texas", "chicago", "europe", "latam", "korea", "canada", "australia", "india",
  "uk", "washington_dc", "asia", "denver", "florida", "minnesota", "sacramento",
]);

const schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    locations: { type: "array", items: { type: "string" } },
    paraformLocations: { type: "array", items: { type: "string", enum: [...PARAAI_LOCATIONS] } },
    relocation: {
      type: "object",
      additionalProperties: false,
      properties: { open: { type: ["boolean", "null"] }, scope: { type: ["string", "null"] } },
    },
    otherInterviewProcesses: {
      type: "object",
      additionalProperties: false,
      properties: {
        count: { type: ["integer", "null"], minimum: 0 },
        stages: { type: "array", items: { type: "string" } },
        details: { type: ["string", "null"] },
      },
    },
    interviewingCompanies: { type: "array", items: { type: "string" } },
    offMarketTimeline: { type: ["string", "null"] },
    searchActivity: { type: ["string", "null"] },
    industries: {
      type: "object",
      additionalProperties: false,
      properties: {
        interested: { type: "array", items: { type: "string" } },
        notInterested: { type: "array", items: { type: "string" } },
      },
    },
    obstacles: { type: "array", items: { type: "string" } },
    workplaceTypes: { type: "array", items: { type: "string", enum: [...WORKPLACE_TYPES] } },
    roleTypes: { type: "array", items: { type: "string" } },
    compensation: {
      type: "object",
      additionalProperties: false,
      properties: {
        baseMin: { type: ["number", "null"], minimum: 0 },
        baseMax: { type: ["number", "null"], minimum: 0 },
        ote: { type: ["number", "null"], minimum: 0 },
        currency: { type: ["string", "null"] },
        notes: { type: ["string", "null"] },
      },
    },
    companyStages: { type: "array", items: { type: "string", enum: [...FUNDING_ROUNDS] } },
    companyHeadcounts: { type: "array", items: { type: "string" } },
    sponsorship: {
      type: "object",
      additionalProperties: false,
      properties: {
        required: { type: ["boolean", "null"] },
        statuses: { type: "array", items: { type: "string", enum: [...SPONSORSHIP_STATUSES] } },
        kind: { type: ["string", "null"] },
      },
    },
  },
};

const prompt = `Extract only preferences and facts the candidate explicitly states in this screening transcript.

Rules:
- Never infer or invent a missing value. Omit it or return an empty array/null.
- Normalize workplace to REMOTE, HYBRID, or ON_SITE only.
- Map explicitly acceptable target locations to Paraform's exact location enum in paraformLocations: ${[...PARAAI_LOCATIONS].join(", ")}. Do not treat the candidate's current residence as a preference unless they explicitly say they want to work there. Remote is a workplace type, not a location. New Jersey maps to new_york only when it is explicitly an acceptable target location.
- Normalize funding to PRE_SEED, SEED, SERIES_A, SERIES_B, SERIES_C, SERIES_D_PLUS, or UNKNOWN. UNKNOWN means the explicit Paraform option “Other (e.g. Legal, Healthcare)”; it never means no preference. If the candidate has no company-stage preference, return an empty array so a human can review it.
- Normalize immigration to CITIZEN, VISA, or GREEN_CARD. H-1B/OPT/visa sponsorship => VISA. No sponsorship needed because they are a citizen => CITIZEN. Permanent resident => GREEN_CARD.
- Compensation baseMin/baseMax are pure base salary only. Exclude equity and bonus. Put OTE in compensation.ote only when OTE is explicitly discussed.
- Preserve relocation scope, interview-process stage, named interviewing companies, off-market timeline, search activity, industry likes/dislikes, trips/obstacles, role types, and company headcount as concise facts.
- Do not include interviewer statements unless the candidate agrees with them.`;

const text = (value) => typeof value === "string" ? value.trim() : "";
const strings = (value) => [...new Set((Array.isArray(value) ? value : []).map(text).filter(Boolean))];
const enumStrings = (value, allowed) => strings(value).map((item) => item.toUpperCase()).filter((item) => allowed.has(item));
const lowerEnumStrings = (value, allowed) => strings(value).map((item) => item.toLowerCase()).filter((item) => allowed.has(item));
const number = (value) => value != null && value !== "" && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const integer = (value) => value != null && value !== "" && Number.isInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;

export function normalizeExtraction(raw = {}) {
  const relocation = raw.relocation && typeof raw.relocation === "object" ? {
    open: typeof raw.relocation.open === "boolean" ? raw.relocation.open : null,
    scope: text(raw.relocation.scope) || null,
  } : { open: null, scope: null };
  const processes = raw.otherInterviewProcesses && typeof raw.otherInterviewProcesses === "object" ? {
    count: integer(raw.otherInterviewProcesses.count),
    stages: strings(raw.otherInterviewProcesses.stages),
    details: text(raw.otherInterviewProcesses.details) || null,
  } : { count: null, stages: [], details: null };
  const compensation = raw.compensation && typeof raw.compensation === "object" ? {
    baseMin: number(raw.compensation.baseMin),
    baseMax: number(raw.compensation.baseMax),
    ote: number(raw.compensation.ote),
    currency: text(raw.compensation.currency) || null,
    notes: text(raw.compensation.notes) || null,
  } : { baseMin: null, baseMax: null, ote: null, currency: null, notes: null };
  const sponsorship = raw.sponsorship && typeof raw.sponsorship === "object" ? {
    required: typeof raw.sponsorship.required === "boolean" ? raw.sponsorship.required : null,
    statuses: enumStrings(raw.sponsorship.statuses, SPONSORSHIP_STATUSES),
    kind: text(raw.sponsorship.kind) || null,
  } : { required: null, statuses: [], kind: null };
  return {
    locations: strings(raw.locations),
    paraformLocations: lowerEnumStrings(raw.paraformLocations, PARAAI_LOCATIONS),
    relocation,
    otherInterviewProcesses: processes,
    interviewingCompanies: strings(raw.interviewingCompanies),
    offMarketTimeline: text(raw.offMarketTimeline) || null,
    searchActivity: text(raw.searchActivity) || null,
    industries: {
      interested: strings(raw.industries?.interested),
      notInterested: strings(raw.industries?.notInterested),
    },
    obstacles: strings(raw.obstacles),
    workplaceTypes: enumStrings(raw.workplaceTypes, WORKPLACE_TYPES),
    roleTypes: strings(raw.roleTypes),
    compensation,
    companyStages: enumStrings(raw.companyStages, FUNDING_ROUNDS),
    companyHeadcounts: strings(raw.companyHeadcounts),
    sponsorship,
  };
}

export function extraNote(extracted) {
  const e = normalizeExtraction(extracted);
  const rows = [
    ["Other interview processes", [e.otherInterviewProcesses.count != null ? `${e.otherInterviewProcesses.count} process(es)` : "", ...e.otherInterviewProcesses.stages, e.otherInterviewProcesses.details].filter(Boolean).join(" · ")],
    ["Interviewing companies", e.interviewingCompanies.join(", ")],
    ["Off-market timeline", e.offMarketTimeline],
    ["Search activity", e.searchActivity],
    ["Industries interested", e.industries.interested.join(", ")],
    ["Industries not interested", e.industries.notInterested.join(", ")],
    ["Upcoming obstacles / trips", e.obstacles.join("; ")],
    ["Company headcount", e.companyHeadcounts.join(", ")],
    ["Role types", e.roleTypes.join(", ")],
  ].filter(([, value]) => value);
  return rows.length ? ["### Raydar screening preferences", ...rows.map(([label, value]) => `- **${label}:** ${value}`)].join("\n") : "";
}

async function extractWithOpenAI(rows, fetchImpl) {
  const apiKey = process.env.OPENAI_API_KEY || "";
  if (!apiKey) throw new Error("OpenAI API key not configured");
  const model = process.env.PARAAI_OPENAI_MODEL || "gpt-5.6-luna";
  const response = await fetchImpl("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      reasoning_effort: "none",
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: JSON.stringify(rows) },
      ],
      tools: [{
        type: "function",
        function: {
          name: "record_candidate_preferences",
          description: "Record only the candidate preferences explicitly supported by the transcript.",
          parameters: schema,
        },
      }],
      tool_choice: { type: "function", function: { name: "record_candidate_preferences" } },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message || `OpenAI extraction failed: ${response.status}`);
  const call = body?.choices?.[0]?.message?.tool_calls?.find((item) => item?.function?.name === "record_candidate_preferences");
  let input = null;
  try { input = JSON.parse(call?.function?.arguments || "null"); } catch {}
  if (!input) throw new Error("OpenAI extraction returned no structured preferences");
  return { extracted: normalizeExtraction(input), model: body?.model || model, usage: body?.usage || null, provider: "openai" };
}

async function extractWithAnthropic(rows, fetchImpl) {
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API || "";
  if (!apiKey) throw new Error("Anthropic API key not configured");
  const response = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.PARAAI_MODEL || "claude-fable-5",
      max_tokens: 4096,
      system: prompt,
      messages: [{ role: "user", content: JSON.stringify(rows) }],
      tools: [{ name: "record_candidate_preferences", description: "Record only the candidate preferences explicitly supported by the transcript.", input_schema: schema }],
      tool_choice: { type: "tool", name: "record_candidate_preferences" },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message || `Claude extraction failed: ${response.status}`);
  const tool = (body?.content || []).find((item) => item?.type === "tool_use" && item?.name === "record_candidate_preferences");
  if (!tool?.input) throw new Error("Claude extraction returned no structured preferences");
  return { extracted: normalizeExtraction(tool.input), model: body?.model || process.env.PARAAI_MODEL || "claude-fable-5", usage: body?.usage || null, provider: "anthropic" };
}

export async function extractPreferences(transcript, { fetchImpl = fetch } = {}) {
  const rows = (Array.isArray(transcript) ? transcript : [])
    .map((row) => ({ role: row?.role === "candidate" ? "candidate" : "agent", speaker: text(row?.speaker), text: text(row?.text) }))
    .filter((row) => row.text);
  if (!rows.length) throw new Error("screening transcript is empty");

  const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API);
  const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
  if (!hasAnthropic && !hasOpenAI) throw new Error("No extraction model API key configured");
  if (hasAnthropic) {
    try { return await extractWithAnthropic(rows, fetchImpl); }
    catch (error) {
      if (!hasOpenAI) throw error;
    }
  }
  return extractWithOpenAI(rows, fetchImpl);
}
