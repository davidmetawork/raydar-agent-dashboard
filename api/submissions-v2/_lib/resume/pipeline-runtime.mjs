import { ResumeContractError, canonicalJson, sha256 } from "./source-bundle.mjs";

export const GENERATION_DEADLINE_MS = 5 * 60_000;
export const GENERATION_BUDGET_CENTS = 200;

const DEFAULT_RATES = Object.freeze({
  "claude-opus-5": Object.freeze({ input: 5, output: 25 }),
  "claude-opus-4-8": Object.freeze({ input: 5, output: 25 }),
  "gpt-5.4-2026-03-05": Object.freeze({ input: 2.5, output: 15 }),
});

const clean = (value, limit = 500) => String(value ?? "").replace(/[\r\n]+/gu, " ").trim().slice(0, limit);
const CONTRACT_PATH = /^document\.(?:candidate\.(?:name|headline|contact\[\d{1,2}\])|summary|sections\[\d{1,2}\]\.entries\[\d{1,2}\]\.(?:header|body)\[\d{1,2}\])$/u;

function safeContractDetails(error) {
  if (error?.details?.contractCode !== "RESUME_FILLER_OR_REPETITION") return undefined;
  const path = String(error.details.contractPath || "");
  return {
    contractCode: "RESUME_FILLER_OR_REPETITION",
    contractPath: path.length <= 160 && CONTRACT_PATH.test(path) ? path : null,
  };
}

export class ResumePipelineError extends Error {
  constructor(code, safeMessage, {
    retryable = false,
    checkpoint = undefined,
    cause = undefined,
    details = undefined,
  } = {}) {
    super(clean(safeMessage) || "Resume preparation failed safely.", { cause });
    this.name = "ResumePipelineError";
    this.code = clean(code, 120) || "resume_pipeline_failed";
    this.safeMessage = this.message;
    this.retryable = Boolean(retryable);
    if (checkpoint !== undefined) this.checkpoint = checkpoint;
    if (details !== undefined) this.details = details;
  }
}

function configuredRate(model, direction, env) {
  const normalized = String(model || "").toUpperCase().replace(/[^A-Z0-9]+/gu, "_");
  const key = `SUBMISSIONS_V2_${normalized}_${direction.toUpperCase()}_PER_MILLION_USD`;
  const configured = Number(env?.[key]);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return DEFAULT_RATES[model]?.[direction] ?? null;
}

export function forecastModelCostCents({
  model,
  input,
  maximumOutputTokens,
  attempts = 1,
  env = process.env,
}) {
  const inputRate = configuredRate(model, "input", env);
  const outputRate = configuredRate(model, "output", env);
  if (!inputRate || !outputRate) {
    throw new ResumePipelineError("model_price_unconfigured", "The approved model cost forecast is not configured.");
  }
  const body = typeof input === "string" ? input : canonicalJson(input);
  // Four UTF-8 characters per token underestimates some payloads, so use 2.5.
  const inputTokens = Math.max(1, Math.ceil(Buffer.byteLength(body, "utf8") / 2.5));
  const outputTokens = Math.max(1, Number(maximumOutputTokens) || 1);
  const calls = Math.max(1, Number(attempts) || 1);
  const dollarsPerCall = ((inputTokens * inputRate) + (outputTokens * outputRate)) / 1_000_000;
  return Math.max(1, Math.ceil(dollarsPerCall * 100 * calls));
}

export function createGenerationBudget({
  deadlineAt,
  budgetCents = GENERATION_BUDGET_CENTS,
  spentCents = 0,
  now = Date.now,
} = {}) {
  const deadline = Number(deadlineAt);
  const ceiling = Math.max(1, Math.min(GENERATION_BUDGET_CENTS, Number(budgetCents) || GENERATION_BUDGET_CENTS));
  let spent = Math.max(0, Number(spentCents) || 0);

  function assertTime(minimumRemainingMs = 1) {
    if (!Number.isFinite(deadline) || now() + Math.max(1, minimumRemainingMs) > deadline) {
      throw new ResumePipelineError("generation_deadline_exhausted", "Resume preparation reached its five-minute deadline.", {
        retryable: true,
      });
    }
  }

  return Object.freeze({
    get deadlineAt() { return deadline; },
    get spentCents() { return spent; },
    get remainingCents() { return Math.max(0, ceiling - spent); },
    assertTime,
    reserve(cents, { minimumRemainingMs = 1 } = {}) {
      assertTime(minimumRemainingMs);
      const value = Math.max(1, Math.ceil(Number(cents) || 0));
      if (spent + value > ceiling) {
        throw new ResumePipelineError("generation_budget_exhausted", "Resume preparation reached its two-dollar model-cost ceiling.");
      }
      spent += value;
      return value;
    },
    snapshot() {
      return { budget_cents: ceiling, spent_cents: spent, deadline_at_ms: deadline };
    },
  });
}

export function checkpointDigest(value) {
  return sha256(canonicalJson(value));
}

export function pipelineError(error, {
  code = "resume_pipeline_failed",
  safeMessage = "Resume preparation failed safely.",
  retryable = true,
  checkpoint = undefined,
} = {}) {
  if (error instanceof ResumePipelineError) {
    if (checkpoint !== undefined && error.checkpoint === undefined) error.checkpoint = checkpoint;
    return error;
  }
  if (error instanceof ResumeContractError) {
    return new ResumePipelineError(error.code || code, safeMessage, {
      retryable: false,
      checkpoint,
      cause: error,
      details: error.details,
    });
  }
  return new ResumePipelineError(error?.code || code, error?.safeMessage || safeMessage, {
    retryable: error?.retryable !== false && retryable,
    checkpoint,
    cause: error,
    details: safeContractDetails(error),
  });
}

export const pipelineRuntimeInternals = Object.freeze({ DEFAULT_RATES, configuredRate, clean, safeContractDetails });
