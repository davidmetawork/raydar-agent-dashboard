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
    excludedParaformLocations: { type: "array", items: { type: "string", enum: [...PARAAI_LOCATIONS] } },
    relocation: {
      type: "object",
      additionalProperties: false,
      properties: {
        open: { type: ["boolean", "null"] },
        scope: { type: ["string", "null"] },
        evidence: { type: ["string", "null"] },
      },
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
    marketStatus: {
      type: "object",
      additionalProperties: false,
      properties: {
        activelyOnMarket: { type: ["boolean", "null"] },
        openToOpportunities: { type: ["boolean", "null"] },
        consentToTalentNetwork: { type: ["boolean", "null"] },
        evidence: { type: "array", items: { type: "string" } },
      },
    },
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
        baseMinIsHardFloor: { type: ["boolean", "null"] },
        baseMinEvidence: { type: ["string", "null"] },
        currency: { type: ["string", "null"] },
        notes: { type: ["string", "null"] },
      },
    },
    companyStages: { type: "array", items: { type: "string", enum: [...FUNDING_ROUNDS] } },
    excludedCompanyStages: { type: "array", items: { type: "string", enum: [...FUNDING_ROUNDS] } },
    openToStartups: { type: ["boolean", "null"] },
    startupOpennessEvidence: { type: ["string", "null"] },
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
- Map explicitly acceptable target locations to Paraform's exact location enum in paraformLocations: ${[...PARAAI_LOCATIONS].join(", ")}. Put explicitly rejected locations in excludedParaformLocations. Set relocation.open true only when the candidate explicitly says they are willing to relocate or move for a role, summarize limits in relocation.scope, and preserve a short exact candidate quote in relocation.evidence. Do not treat the candidate's current residence as a preference unless they explicitly say they want to work there. Remote is a workplace type, not a location. New Jersey maps to new_york only when it is explicitly an acceptable target location.
- Normalize funding to PRE_SEED, SEED, SERIES_A, SERIES_B, SERIES_C, SERIES_D_PLUS, or UNKNOWN. UNKNOWN means the explicit Paraform option “Other (e.g. Legal, Healthcare)”; it never means no preference. If the candidate has no company-stage preference, return an empty array so a human can review it.
- Set openToStartups true only when the candidate explicitly says they are broadly open to startups without restricting that openness to a particular funding stage. Preserve a short candidate quote in startupOpennessEvidence. Put explicitly rejected stages in excludedCompanyStages. A specific stage preference remains specific and must not be broadened by the extractor.
- Normalize immigration to CITIZEN, VISA, or GREEN_CARD. H-1B/OPT/visa sponsorship => VISA. No sponsorship needed because they are a citizen => CITIZEN. Permanent resident => GREEN_CARD.
- Compensation baseMin/baseMax are pure base salary only. Exclude equity and bonus. Set baseMinIsHardFloor true only for explicit floor language such as “no lower than”, “won't go below”, or “my minimum is”; preserve that candidate statement in baseMinEvidence. Targets, preferences, and approximate ranges are not hard floors. Put OTE in compensation.ote only when OTE is explicitly discussed.
- marketStatus must be evidence-based. activelyOnMarket is true only when the candidate explicitly says they are currently searching or interviewing. openToOpportunities is true when they explicitly say they are open to considering a new role. consentToTalentNetwork is true only when they explicitly agree that Raydar may share their profile, resume, screening call, and preferences with Paraform's Talent Network or Para AI. Never infer consent. Include short verbatim candidate statements in evidence; omit interviewer language.
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
    evidence: text(raw.relocation.evidence) || null,
  } : { open: null, scope: null, evidence: null };
  const processes = raw.otherInterviewProcesses && typeof raw.otherInterviewProcesses === "object" ? {
    count: integer(raw.otherInterviewProcesses.count),
    stages: strings(raw.otherInterviewProcesses.stages),
    details: text(raw.otherInterviewProcesses.details) || null,
  } : { count: null, stages: [], details: null };
  const compensation = raw.compensation && typeof raw.compensation === "object" ? {
    baseMin: number(raw.compensation.baseMin),
    baseMax: number(raw.compensation.baseMax),
    ote: number(raw.compensation.ote),
    baseMinIsHardFloor: typeof raw.compensation.baseMinIsHardFloor === "boolean" ? raw.compensation.baseMinIsHardFloor : null,
    baseMinEvidence: text(raw.compensation.baseMinEvidence) || null,
    currency: text(raw.compensation.currency) || null,
    notes: text(raw.compensation.notes) || null,
  } : {
    baseMin: null,
    baseMax: null,
    ote: null,
    baseMinIsHardFloor: null,
    baseMinEvidence: null,
    currency: null,
    notes: null,
  };
  const sponsorship = raw.sponsorship && typeof raw.sponsorship === "object" ? {
    required: typeof raw.sponsorship.required === "boolean" ? raw.sponsorship.required : null,
    statuses: enumStrings(raw.sponsorship.statuses, SPONSORSHIP_STATUSES),
    kind: text(raw.sponsorship.kind) || null,
  } : { required: null, statuses: [], kind: null };
  const marketStatus = raw.marketStatus && typeof raw.marketStatus === "object" ? {
    activelyOnMarket: typeof raw.marketStatus.activelyOnMarket === "boolean" ? raw.marketStatus.activelyOnMarket : null,
    openToOpportunities: typeof raw.marketStatus.openToOpportunities === "boolean" ? raw.marketStatus.openToOpportunities : null,
    consentToTalentNetwork: typeof raw.marketStatus.consentToTalentNetwork === "boolean" ? raw.marketStatus.consentToTalentNetwork : null,
    evidence: strings(raw.marketStatus.evidence).map((item) => item.slice(0, 280)).slice(0, 5),
    evidenceVerified: raw.marketStatus.evidenceVerified === true,
    consentVerifiedFromTranscript: raw.marketStatus.consentVerifiedFromTranscript === true,
  } : {
    activelyOnMarket: null,
    openToOpportunities: null,
    consentToTalentNetwork: null,
    evidence: [],
    evidenceVerified: false,
    consentVerifiedFromTranscript: false,
  };
  return {
    locations: strings(raw.locations),
    paraformLocations: lowerEnumStrings(raw.paraformLocations, PARAAI_LOCATIONS),
    excludedParaformLocations: lowerEnumStrings(raw.excludedParaformLocations, PARAAI_LOCATIONS),
    relocation,
    otherInterviewProcesses: processes,
    interviewingCompanies: strings(raw.interviewingCompanies),
    offMarketTimeline: text(raw.offMarketTimeline) || null,
    searchActivity: text(raw.searchActivity) || null,
    marketStatus,
    industries: {
      interested: strings(raw.industries?.interested),
      notInterested: strings(raw.industries?.notInterested),
    },
    obstacles: strings(raw.obstacles),
    workplaceTypes: enumStrings(raw.workplaceTypes, WORKPLACE_TYPES),
    roleTypes: strings(raw.roleTypes),
    compensation,
    companyStages: enumStrings(raw.companyStages, FUNDING_ROUNDS),
    excludedCompanyStages: enumStrings(raw.excludedCompanyStages, FUNDING_ROUNDS),
    openToStartups: typeof raw.openToStartups === "boolean" ? raw.openToStartups : null,
    startupOpennessEvidence: text(raw.startupOpennessEvidence) || null,
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
    ["Market confirmation", e.marketStatus.evidence.join(" · ")],
    ["Industries interested", e.industries.interested.join(", ")],
    ["Industries not interested", e.industries.notInterested.join(", ")],
    ["Upcoming obstacles / trips", e.obstacles.join("; ")],
    ["Relocation scope", e.relocation.scope],
    ["Startup openness", e.startupOpennessEvidence],
    ["Company headcount", e.companyHeadcounts.join(", ")],
    ["Role types", e.roleTypes.join(", ")],
  ].filter(([, value]) => value);
  return rows.length ? ["### Raydar screening preferences", ...rows.map(([label, value]) => `- **${label}:** ${value}`)].join("\n") : "";
}

export function enforceTranscriptSemantics(extracted, rows = []) {
  const normalized = normalizeExtraction(extracted);
  const transcript = Array.isArray(rows) ? rows : [];
  const candidateRows = transcript
    .filter((row) => row?.role === "candidate")
    .map((row) => text(row?.text))
    .filter(Boolean);
  const candidateText = candidateRows.join(" ");
  const explicitlyDiscussedOte = /\bOTE\b|on[\s-]*target earnings/i.test(candidateText);
  const compact = (value) => text(value)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const compactCandidateRows = candidateRows.map(compact);
  const quoteRow = (quote) => {
    const wanted = compact(quote);
    if (wanted.length < 8) return -1;
    return compactCandidateRows.findIndex((row) => row.includes(wanted));
  };
  const moneyAmounts = (value) => {
    const amounts = [];
    for (const match of String(value || "").matchAll(/\$?\s*(\d+(?:,\d{3})*(?:\.\d+)?)\s*(k|thousand)?\b/gi)) {
      const numeric = Number(match[1].replaceAll(",", ""));
      if (!Number.isFinite(numeric)) continue;
      amounts.push(Math.round(numeric * (match[2] ? 1_000 : 1)));
    }
    return amounts;
  };
  const evidence = normalized.marketStatus.evidence.filter((quote) => {
    const wanted = compact(quote);
    return wanted.length >= 8 && compactCandidateRows.some((row) => row.includes(wanted));
  });

  const answer = (value) => {
    const valueText = compact(value);
    if (!valueText) return null;
    if (/\b(no|not|dont|do not|cant|cannot|wouldnt|rather not)\b/.test(valueText)) return false;
    return /^(yes|yeah|yep|sure|absolutely|definitely|correct|okay|ok|of course|i am|im open|that is fine|thats fine)\b/.test(valueText)
      ? true
      : null;
  };
  let finalOpen = null;
  let finalConsent = null;
  let finalEvidence = "";
  for (let index = 0; index < transcript.length; index++) {
    const row = transcript[index];
    if (row?.role !== "agent") continue;
    const question = compact(row?.text);
    const combined =
      question.includes("open to new opportunities") &&
      question.includes("share") &&
      question.includes("paraform") &&
      (question.includes("talent network") || question.includes("para ai"));
    const openOnly =
      question.includes("are you currently open to new opportunities") &&
      !question.includes("share");
    const consentOnly =
      question.includes("share") &&
      question.includes("paraform") &&
      (question.includes("is it okay") || question.includes("okay for raydar"));
    if (!combined && !openOnly && !consentOnly) continue;
    const response = transcript.slice(index + 1).find((next) => next?.role === "candidate");
    const responseText = text(response?.text);
    const parsed = answer(responseText);
    if (combined && parsed === true) {
      finalOpen = true;
      finalConsent = true;
      finalEvidence = responseText;
    } else if (openOnly && parsed != null) {
      finalOpen = parsed;
      finalEvidence = responseText || finalEvidence;
    } else if (consentOnly && parsed != null) {
      finalConsent = parsed;
      finalEvidence = responseText || finalEvidence;
    }
  }
  if (finalEvidence) evidence.push(finalEvidence.slice(0, 280));
  const verifiedEvidence = [...new Set(evidence)].slice(0, 5);
  const hasVerifiedEvidence = verifiedEvidence.length > 0;
  const hardFloorLanguage = /\b(no lower than|wont go below|will not go below|cannot go below|cant go below|minimum(?: base| salary| compensation)? is|hard minimum|salary floor|base floor)\b/;
  const hardFloorFlexible = /\b(not (?:a )?hard minimum|not (?:my )?minimum|flexible|target|ideally|around|roughly|approximately)\b/;
  const statedBaseMin = normalized.compensation.baseMin;
  const hardFloorRow = statedBaseMin == null ? -1 : compactCandidateRows.findIndex((row, index) => (
    hardFloorLanguage.test(row) &&
    !hardFloorFlexible.test(row) &&
    moneyAmounts(candidateRows[index]).includes(Math.round(statedBaseMin))
  ));
  const quotedHardFloorRow = quoteRow(normalized.compensation.baseMinEvidence);
  const hardFloorVerified = normalized.compensation.baseMinIsHardFloor === true &&
    hardFloorRow >= 0 &&
    (quotedHardFloorRow === hardFloorRow || !normalized.compensation.baseMinEvidence);

  const startupPositive = /\b(open to|would consider|will consider|interested in|okay with|fine with|willing to join|happy to join)\b[^.]{0,60}\b(startup|start up|startups)\b/;
  const startupPositiveReverse = /\b(startup|start up|startups)\b[^.]{0,45}\b(fine|okay|good|interesting|an option)\b/;
  const startupNegative = /\b(not|dont|do not|wont|wouldnt|never|avoid|exclude|rule out|ruling out|no)\b[^.]{0,60}\b(startup|start up|startups)\b/;
  const startupNegativeReverse = /\b(startup|start up|startups)\b[^.]{0,45}\b(not|no|never|avoid|exclude|rule out|not for me|arent|are not)\b/;
  const startupRow = compactCandidateRows.findIndex((row) => (
    (startupPositive.test(row) || startupPositiveReverse.test(row)) &&
    !startupNegative.test(row) &&
    !startupNegativeReverse.test(row)
  ));
  const quotedStartupRow = quoteRow(normalized.startupOpennessEvidence);
  const startupVerified = normalized.openToStartups === true &&
    startupRow >= 0 &&
    (quotedStartupRow === startupRow || !normalized.startupOpennessEvidence);

  const relocationPositive = /\b(open to|willing to|would|could|can|happy to|okay with)\b[^.]{0,60}\b(relocat|relocating|move|moving)\b/;
  const relocationPositiveReverse = /\b(relocat|relocating|move|moving)\b[^.]{0,45}\b(for the right|to [a-z]|would|could|can|open|willing)\b/;
  const relocationNegative = /\b(not|dont|do not|wont|wouldnt|cannot|cant|never)\b[^.]{0,60}\b(relocat|relocating|move|moving)\b/;
  const relocationNegativeReverse = /\b(relocat|relocating|move|moving)\b[^.]{0,45}\b(not|no|never|off the table)\b/;
  const hasMappedRelocationExclusions = normalized.excludedParaformLocations.length > 0;
  const relocationRow = compactCandidateRows.findIndex((row) => (
    (relocationPositive.test(row) || relocationPositiveReverse.test(row)) &&
    !relocationNegative.test(row) &&
    (!relocationNegativeReverse.test(row) || hasMappedRelocationExclusions)
  ));
  const quotedRelocationRow = quoteRow(normalized.relocation.evidence);
  const relocationVerified = normalized.relocation.open === true &&
    relocationRow >= 0 &&
    (quotedRelocationRow === relocationRow || !normalized.relocation.evidence);
  return {
    ...normalized,
    relocation: {
      ...normalized.relocation,
      open: relocationVerified,
      evidence: relocationVerified
        ? (normalized.relocation.evidence || candidateRows[relocationRow].slice(0, 280))
        : null,
    },
    compensation: {
      ...normalized.compensation,
      ote: explicitlyDiscussedOte ? normalized.compensation.ote : null,
      baseMinIsHardFloor: hardFloorVerified,
      baseMinEvidence: hardFloorVerified
        ? (normalized.compensation.baseMinEvidence || candidateRows[hardFloorRow].slice(0, 280))
        : null,
    },
    openToStartups: startupVerified,
    startupOpennessEvidence: startupVerified
      ? (normalized.startupOpennessEvidence || candidateRows[startupRow].slice(0, 280))
      : null,
    marketStatus: {
      ...normalized.marketStatus,
      activelyOnMarket: hasVerifiedEvidence ? normalized.marketStatus.activelyOnMarket : null,
      openToOpportunities: finalOpen ?? (hasVerifiedEvidence ? normalized.marketStatus.openToOpportunities : null),
      consentToTalentNetwork: finalConsent,
      evidence: verifiedEvidence,
      evidenceVerified: hasVerifiedEvidence,
      consentVerifiedFromTranscript: finalConsent === true,
    },
  };
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
    try {
      const result = await extractWithAnthropic(rows, fetchImpl);
      return { ...result, extracted: enforceTranscriptSemantics(result.extracted, rows) };
    }
    catch (error) {
      if (!hasOpenAI) throw error;
    }
  }
  const result = await extractWithOpenAI(rows, fetchImpl);
  return { ...result, extracted: enforceTranscriptSemantics(result.extracted, rows) };
}
