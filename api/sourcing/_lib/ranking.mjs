// Identity-minimized, schema-constrained candidate evaluation. Paraform does
// retrieval; this module decides which retrieved profiles are worth filing.

const text = (value) => String(value ?? "").trim();
const list = (value) => Array.isArray(value) ? value : [];
const hiddenKey = /^(?:name|full_?name|first_?name|last_?name|email|phone|avatar|photo|image|linkedin(?:Slug|Url)?|linkedin_slug|linkedin_url|url|website|slug|id|candidate.*id|saved.*id)$/i;

function sanitize(value, depth = 0) {
  if (depth > 5 || value == null) return undefined;
  if (typeof value === "string") return text(value).slice(0, 1200) || undefined;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => sanitize(item, depth + 1)).filter((item) => item !== undefined);
  if (typeof value !== "object") return undefined;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (hiddenKey.test(key)) continue;
    const cleaned = sanitize(item, depth + 1);
    if (cleaned === undefined) continue;
    if (Array.isArray(cleaned) && !cleaned.length) continue;
    if (cleaned && typeof cleaned === "object" && !Array.isArray(cleaned) && !Object.keys(cleaned).length) continue;
    out[key] = cleaned;
  }
  return out;
}

export function candidateEvaluationProfile(raw = {}, normalized = {}, index = 0) {
  const safe = {
    candidateRef: `profile-${index + 1}`,
    currentTitle: text(normalized.title),
    currentCompany: text(normalized.company),
    location: text(normalized.location),
    profile: sanitize(raw),
  };
  const serialized = JSON.stringify(safe);
  if (serialized.length <= 9_000) return safe;
  return { ...safe, profile: { truncatedProfileText: serialized.slice(0, 7_500) } };
}

const evaluationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["evaluations"],
  properties: {
    evaluations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["candidateRef", "score", "hardRequirementsMet", "confidence", "strengths", "concerns", "reason"],
        properties: {
          candidateRef: { type: "string" },
          score: { type: "integer", minimum: 0, maximum: 100 },
          hardRequirementsMet: { type: "boolean" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          strengths: { type: "array", maxItems: 4, items: { type: "string" } },
          concerns: { type: "array", maxItems: 4, items: { type: "string" } },
          reason: { type: "string" },
        },
      },
    },
  },
};

const systemPrompt = `You are a conservative recruiting sourcer. Evaluate every supplied profile independently against the job rubric and reviewer calibration.

Rules:
- A hard requirement is pass/fail. Set hardRequirementsMet=false when the profile contradicts one or lacks enough evidence for a requirement explicitly marked MUST or REJECT.
- Never infer an unshown skill, credential, employer, location, or tenure.
- Native filters control retrieval but do not prove fit; inspect the actual evidence.
- Score 90-100 exceptional, 80-89 strong, 70-79 plausible with gaps, below 70 weak.
- A high score cannot override hardRequirementsMet=false.
- Give concise, evidence-specific strengths, concerns, and reason. Evaluate every candidateRef exactly once.`;

function outputText(body) {
  if (text(body?.output_text)) return text(body.output_text);
  for (const item of list(body?.output)) {
    for (const content of list(item?.content)) {
      if (text(content?.text)) return text(content.text);
    }
  }
  return "";
}

async function evaluateBatch(batch, context, fetchImpl) {
  const apiKey = process.env.OPENAI_API_KEY || "";
  if (!apiKey) throw new Error("OpenAI ranking key not configured");
  const model = process.env.SOURCING_OPENAI_MODEL || "gpt-5.6-terra";
  const response = await fetchImpl("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      store: false,
      reasoning: { effort: "low" },
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify({
          jobRubric: context.rubric,
          reviewerCriteria: context.agentCriteria,
          approvedCalibrations: context.adjustments,
          candidates: batch,
        }) },
      ],
      text: { format: { type: "json_schema", name: "candidate_evaluations", strict: true, schema: evaluationSchema } },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message || `OpenAI ranking failed: ${response.status}`);
  let parsed = null;
  try { parsed = JSON.parse(outputText(body)); } catch {}
  if (!Array.isArray(parsed?.evaluations)) throw new Error("OpenAI ranking returned no structured evaluations");
  return { evaluations: parsed.evaluations, model: body?.model || model, usage: body?.usage || null };
}

async function pool(items, concurrency, fn) {
  const output = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await fn(items[index], index);
    }
  }));
  return output;
}

export async function evaluateCandidates(candidates, context = {}, { fetchImpl = fetch } = {}) {
  const profiles = list(candidates).map((item, index) => candidateEvaluationProfile(item.raw, item.candidate, index));
  const batches = [];
  for (let index = 0; index < profiles.length; index += 10) batches.push(profiles.slice(index, index + 10));
  const responses = await pool(batches, 3, (batch) => evaluateBatch(batch, context, fetchImpl));
  const byRef = new Map(responses.flatMap((response) => response.evaluations).map((evaluation) => [text(evaluation.candidateRef), evaluation]));
  const evaluations = profiles.map((profile, index) => {
    const source = byRef.get(profile.candidateRef);
    if (!source) return { candidateId: candidates[index].candidate.candidateId, score: 0, hardRequirementsMet: false, confidence: "low", strengths: [], concerns: ["No evaluator result"], reason: "The evaluator did not return this profile." };
    return {
      candidateId: candidates[index].candidate.candidateId,
      score: Math.min(100, Math.max(0, Math.trunc(Number(source.score) || 0))),
      hardRequirementsMet: source.hardRequirementsMet === true,
      confidence: ["high", "medium", "low"].includes(source.confidence) ? source.confidence : "low",
      strengths: list(source.strengths).map(text).filter(Boolean).slice(0, 4),
      concerns: list(source.concerns).map(text).filter(Boolean).slice(0, 4),
      reason: text(source.reason).slice(0, 600),
    };
  });
  return {
    evaluations,
    model: responses.map((response) => response.model).find(Boolean) || process.env.SOURCING_OPENAI_MODEL || "gpt-5.6-terra",
    usage: responses.map((response) => response.usage).filter(Boolean),
    batches: batches.length,
  };
}
