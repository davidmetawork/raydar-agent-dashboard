import { ResumeContractError, deepFreeze, normalizeEvidenceText } from "../resume/source-bundle.mjs";

const CLAIM_IDS_SCHEMA = {
  type: "array",
  items: { type: "string", minLength: 1, maxLength: 200 },
  minItems: 1,
  uniqueItems: true,
};

const CONTENT_NODE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "text", "claim_ids", "emphasis"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 200 },
    text: { type: "string", minLength: 1, maxLength: 2_000 },
    claim_ids: CLAIM_IDS_SCHEMA,
    emphasis: {
      type: "array",
      items: { type: "string", minLength: 1, maxLength: 200 },
      maxItems: 3,
      uniqueItems: true,
    },
  },
};

const ENTRY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "header", "body"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 200 },
    header: { type: "array", items: CONTENT_NODE_SCHEMA, minItems: 1, maxItems: 5 },
    body: { type: "array", items: CONTENT_NODE_SCHEMA, maxItems: 12 },
  },
};

const SECTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "title", "kind", "placement", "entries"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 200 },
    title: { type: "string", minLength: 1, maxLength: 120 },
    kind: {
      type: "string",
      enum: ["experience", "projects", "education", "skills", "details", "metrics", "custom"],
    },
    placement: { type: "string", enum: ["main", "sidebar"] },
    entries: { type: "array", items: ENTRY_SCHEMA, minItems: 1, maxItems: 20 },
  },
};

export const RESUME_AST_JSON_SCHEMA = deepFreeze({
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "candidate", "summary", "sections", "page_preference"],
  properties: {
    schema_version: { type: "string", const: "raydar.resume.ast.v1" },
    candidate: {
      type: "object",
      additionalProperties: false,
      required: ["name", "headline", "contact"],
      properties: {
        name: CONTENT_NODE_SCHEMA,
        headline: CONTENT_NODE_SCHEMA,
        contact: { type: "array", items: CONTENT_NODE_SCHEMA, maxItems: 5 },
      },
    },
    summary: {
      anyOf: [CONTENT_NODE_SCHEMA, { type: "null" }],
    },
    sections: { type: "array", items: SECTION_SCHEMA, minItems: 1, maxItems: 12 },
    page_preference: { type: "integer", enum: [1, 2] },
  },
});

export const STRATEGY_JSON_SCHEMA = deepFreeze({
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "target_narrative",
    "document",
    "selected_claim_ids",
    "deliberate_omissions",
  ],
  properties: {
    schema_version: { type: "string", const: "raydar.resume.strategy.v1" },
    target_narrative: { type: "string", minLength: 1, maxLength: 2_000 },
    document: RESUME_AST_JSON_SCHEMA,
    selected_claim_ids: {
      type: "array",
      items: { type: "string", minLength: 1, maxLength: 200 },
      minItems: 1,
      uniqueItems: true,
    },
    deliberate_omissions: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claim_id", "reason_code"],
        properties: {
          claim_id: { type: "string", minLength: 1, maxLength: 200 },
          reason_code: {
            type: "string",
            enum: ["low_role_relevance", "redundant", "page_constraint", "weaker_evidence"],
          },
        },
      },
    },
  },
});

export const VALIDATOR_JSON_SCHEMA = deepFreeze({
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "results"],
  properties: {
    schema_version: { type: "string", const: "raydar.resume.grounding-validation.v1" },
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claim_id", "verdict", "evidence_ids", "rewrite", "reason_code"],
        properties: {
          claim_id: { type: "string", minLength: 1, maxLength: 200 },
          verdict: {
            type: "string",
            enum: ["supported", "supportable_after_narrowing", "unsupported"],
          },
          evidence_ids: {
            type: "array",
            items: { type: "string", minLength: 1, maxLength: 200 },
            uniqueItems: true,
          },
          rewrite: { type: ["string", "null"], maxLength: 4_000 },
          reason_code: {
            type: "string",
            enum: ["direct_support", "narrowing_required", "no_candidate_evidence", "contradicted"],
          },
        },
      },
    },
  },
});

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, code, path) {
  if (!plainObject(value)) throw new ResumeContractError(code, `${path} must be an object`, { path });
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) {
    throw new ResumeContractError(code, `${path} does not match the strict schema`, { path, actual, expected });
  }
}

function strictString(value, path, { max = 4_000, nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string") throw new ResumeContractError("MODEL_OUTPUT_SCHEMA_INVALID", `${path} must be text`, { path });
  const result = normalizeEvidenceText(value).slice(0, max);
  if (!result) throw new ResumeContractError("MODEL_OUTPUT_SCHEMA_INVALID", `${path} cannot be empty`, { path });
  return result;
}

function uniqueStrings(value, path, { min = 0, max = 200 } = {}) {
  if (!Array.isArray(value) || value.length < min) {
    throw new ResumeContractError("MODEL_OUTPUT_SCHEMA_INVALID", `${path} must be an array`, { path });
  }
  const result = value.map((item, index) => strictString(item, `${path}[${index}]`, { max }));
  if (new Set(result).size !== result.length) {
    throw new ResumeContractError("MODEL_OUTPUT_SCHEMA_INVALID", `${path} contains duplicates`, { path });
  }
  return result;
}

export function assertStrictStrategy(value) {
  exactKeys(value, [
    "schema_version",
    "target_narrative",
    "document",
    "selected_claim_ids",
    "deliberate_omissions",
  ], "STRATEGY_SCHEMA_INVALID", "strategy");
  if (value.schema_version !== "raydar.resume.strategy.v1") {
    throw new ResumeContractError("STRATEGY_SCHEMA_INVALID", "Strategy schema version is invalid");
  }
  const selectedClaimIds = uniqueStrings(value.selected_claim_ids, "strategy.selected_claim_ids", { min: 1 });
  if (!Array.isArray(value.deliberate_omissions)) {
    throw new ResumeContractError("STRATEGY_SCHEMA_INVALID", "strategy.deliberate_omissions must be an array");
  }
  const omissions = value.deliberate_omissions.map((item, index) => {
    exactKeys(item, ["claim_id", "reason_code"], "STRATEGY_SCHEMA_INVALID", `strategy.deliberate_omissions[${index}]`);
    const reasonCode = strictString(item.reason_code, `strategy.deliberate_omissions[${index}].reason_code`, { max: 80 });
    if (!["low_role_relevance", "redundant", "page_constraint", "weaker_evidence"].includes(reasonCode)) {
      throw new ResumeContractError("STRATEGY_SCHEMA_INVALID", "Strategy omission reason is invalid", { reasonCode });
    }
    return {
      claim_id: strictString(item.claim_id, `strategy.deliberate_omissions[${index}].claim_id`, { max: 200 }),
      reason_code: reasonCode,
    };
  });
  if (!plainObject(value.document)) {
    throw new ResumeContractError("STRATEGY_SCHEMA_INVALID", "strategy.document must be an object");
  }
  return deepFreeze({
    schema_version: value.schema_version,
    target_narrative: strictString(value.target_narrative, "strategy.target_narrative", { max: 2_000 }),
    document: value.document,
    selected_claim_ids: selectedClaimIds,
    deliberate_omissions: omissions,
  });
}

export function assertStrictValidation(value, expectedClaims) {
  exactKeys(value, ["schema_version", "results"], "VALIDATOR_SCHEMA_INVALID", "validation");
  if (value.schema_version !== "raydar.resume.grounding-validation.v1" || !Array.isArray(value.results)) {
    throw new ResumeContractError("VALIDATOR_SCHEMA_INVALID", "Validator schema version or results are invalid");
  }
  const expected = new Map(expectedClaims.map((claim) => [claim.id, claim]));
  if (expected.size !== expectedClaims.length) {
    throw new ResumeContractError("VALIDATOR_INPUT_INVALID", "Validator input contains duplicate claim ids");
  }
  const seen = new Set();
  const results = value.results.map((item, index) => {
    exactKeys(
      item,
      ["claim_id", "verdict", "evidence_ids", "rewrite", "reason_code"],
      "VALIDATOR_SCHEMA_INVALID",
      `validation.results[${index}]`,
    );
    const claimId = strictString(item.claim_id, `validation.results[${index}].claim_id`, { max: 200 });
    if (!expected.has(claimId) || seen.has(claimId)) {
      throw new ResumeContractError("VALIDATOR_SCHEMA_INVALID", "Validator returned an unknown or duplicate claim id", { claimId });
    }
    seen.add(claimId);
    const verdict = strictString(item.verdict, `validation.results[${index}].verdict`, { max: 80 });
    if (!["supported", "supportable_after_narrowing", "unsupported"].includes(verdict)) {
      throw new ResumeContractError("VALIDATOR_SCHEMA_INVALID", "Validator verdict is invalid", { claimId, verdict });
    }
    const evidenceIds = uniqueStrings(item.evidence_ids, `validation.results[${index}].evidence_ids`);
    const allowedEvidence = new Set(expected.get(claimId).evidence.map((entry) => entry.evidenceId));
    if (evidenceIds.some((id) => !allowedEvidence.has(id))) {
      throw new ResumeContractError("VALIDATOR_SCHEMA_INVALID", "Validator cited evidence outside the claim packet", { claimId });
    }
    const rewrite = item.rewrite === null ? null : strictString(item.rewrite, `validation.results[${index}].rewrite`);
    if ((verdict === "supportable_after_narrowing") !== Boolean(rewrite)) {
      throw new ResumeContractError("VALIDATOR_SCHEMA_INVALID", "Only a narrowing verdict may contain a rewrite", { claimId });
    }
    if (verdict === "supported" && !evidenceIds.length) {
      throw new ResumeContractError("VALIDATOR_SCHEMA_INVALID", "A supported verdict requires candidate evidence", { claimId });
    }
    const reasonCode = strictString(item.reason_code, `validation.results[${index}].reason_code`, { max: 80 });
    if (!["direct_support", "narrowing_required", "no_candidate_evidence", "contradicted"].includes(reasonCode)) {
      throw new ResumeContractError("VALIDATOR_SCHEMA_INVALID", "Validator reason code is invalid", { claimId, reasonCode });
    }
    return { claim_id: claimId, verdict, evidence_ids: evidenceIds, rewrite, reason_code: reasonCode };
  });
  if (seen.size !== expected.size) {
    throw new ResumeContractError("VALIDATOR_SCHEMA_INVALID", "Validator did not return exactly one result per claim", {
      missingClaimIds: [...expected.keys()].filter((id) => !seen.has(id)),
    });
  }
  return deepFreeze({ schema_version: value.schema_version, results });
}
