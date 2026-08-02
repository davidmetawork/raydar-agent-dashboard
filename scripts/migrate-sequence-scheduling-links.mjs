#!/usr/bin/env node
/**
 * Reversible Paraform sequence-link migration.
 *
 * Default mode is a read-only audit. `--apply` is intentionally impossible
 * until the two production routes respond, the dashboard reports the native
 * webhook/index enabled and healthy, an explicit cutover phrase is present,
 * and a private absolute manifest path is supplied. Every write is read back.
 * Any partial failure rolls all already-written sequences back and verifies the
 * rollback before exiting non-zero.
 *
 * This script never prints step bodies, sender addresses, credentials, or
 * candidate data. The private rollback manifest contains exact sequence steps,
 * is created mode 0600, and must never be committed.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  BASE,
  headers,
  trpcGet,
  trpcPost,
  withThrottleRetry,
} from "../api/seq/_lib/core.mjs";
import {
  AGENT_SCHEDULING_URL,
  HUMAN_SCHEDULING_URL,
  findLegacySchedulingLinks,
  hasCandidateSchedulingLink,
  rewriteLegacySchedulingLinks,
} from "../api/seq/_lib/scheduling-links.mjs";
import {
  BOOKING_STOP_REVIEWED_CATALOG_FLOOR,
  BOOKING_STOP_SCOPE_SCHEMA,
  bookingStopScopeDigest,
  isNudgeSequence,
} from "../api/seq/_lib/booking-stop.mjs";

const APPLY_PHRASE = "APPLY_ALL_RAYDAR_SEQUENCE_LINKS";
const ROLLBACK_PHRASE = "ROLLBACK_ALL_RAYDAR_SEQUENCE_LINKS";
const EDIT_FREEZE_PHRASE = "PARAFORM_SEQUENCE_EDIT_FREEZE_CONFIRMED";
const MANIFEST_SCHEMA = "raydar-sequence-link-migration-v4";
const MIGRATION_CODE_VERSION = "raydar-sequence-link-migration-2026-08-02-v6";
const REVIEWED_SEQUENCE_CATALOG_FLOOR = 75;
const HEALTH_URL = "https://monitor.raydar.xyz/api/seq/health";
const MAX_CUTOVER_WEBHOOK_AGE_MINUTES = 60;
const MAX_CUTOVER_SWEEP_AGE_MINUTES = 90;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stable(value[key])]),
  );
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

export function sequenceSourceAttribution(sequenceId, callType) {
  const id = String(sequenceId || "");
  const type = String(callType || "").trim().toLowerCase();
  if (!id || !["agent", "human"].includes(type)) {
    fail("SEQUENCE_SOURCE_ATTRIBUTION_INVALID");
  }
  const opaqueSequence = createHash("sha256")
    .update(id)
    .digest("hex")
    .slice(0, 16);
  return `paraform_sequence_${type}.${opaqueSequence}`;
}

const URL_TOKEN_PATTERN =
  /(?:https?:\/\/|www\.)[^\s<>"']+|(?<![@\w.-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?![a-z0-9.-])(?:\/[^\s<>"']*)?/giu;
const SCHEDULING_CONTEXT =
  /\b(?:availability|book(?:ing)?|calendar|call|chat|choose\s+a\s+time|find\s+a\s+slot|grab\s+a\s+time|meet(?:ing)?|pick\s+a\s+time|schedul(?:e|ing)|select\s+availability|time\s+slot)\b/iu;
const SCHEDULING_PATH =
  /(?:^|\/)(?:appointment|book(?:ing|withme)?|cal|calendar|meet(?:ing|ings)?|schedule|scheduler|time-slot)(?:\/|$)/iu;
const SCHEDULING_PROVIDER_DOMAINS = [
  "acuityscheduling.com",
  "book.ms",
  "cal.com",
  "calday.com",
  "calendly.com",
  "cally.com",
  "chili-piper.com",
  "chilipiper.com",
  "doodle.com",
  "oncehub.com",
  "savvycal.com",
  "scheduleonce.com",
  "squarespacescheduling.com",
  "tidycal.com",
  "usemotion.com",
  "youcanbook.me",
  "zcal.co",
  "zencal.io",
];
// Exact non-scheduling URLs that a complete production audit placed in
// scheduling language context. Keeping this classification explicit makes a
// later path change fail closed and require a fresh human review.
const REVIEWED_NON_SCHEDULING_URLS = new Set([
  "222.place/",
  "allenai.org/",
  "assorthealth.com/",
  "atoms.co/",
  "blacksmith.sh/",
  "cascading.ai/",
  "ci3.googleusercontent.com/mail-sig/AIorK4xrSWbvRa8isfubR1cUwnjSVKXOI9E17M2Hg3AtJDhCKVL9rI7MAqwHBUotP2HImZGeV08ojy0",
  "ci3.googleusercontent.com/mail-sig/AIorK4yScHWoyXgyhat5thauMBsl80kT8Kc-u2NxBciVeEtjQjdzb5qJusiJIe0eD87IR-n7GslGGT4",
  "decagon.ai/",
  "dioptra.ai/",
  "eliseai.com/",
  "fermatcommerce.com/",
  "hadrius.com/",
  "inworld.ai/",
  "linkedin.com/in/davidphillips97",
  "linkedin.com/in/traviskalanick",
  "litellm.ai/",
  "loancrate.com/",
  "loopai.com/",
  "mai.co/",
  "makipeople.com/",
  "mavenclinic.com/",
  "neocognition.io/",
  "next.js/",
  "node.js/",
  "nuancelabs.ai/",
  "opal.dev/",
  "optimizedhq.com/",
  "owner.com/",
  "paraform.com/",
  "paraform.com/browse",
  "paraform.com/company/decagon/cmcicwo5v00b9ic04vjfsoqzd",
  "paraform.com/company/neocognition/cmpejiwh000020cjykwkd1wy3",
  "paraform.com/new/browse",
  "paraform.com/role/cm7yebfm2000nl20c6n513pyi",
  "paraform.com/role/cmebszpta004wl50czo9b0sag",
  "paraform.com/role/cmn4apavl000w0cjp8z4k993a",
  "paraform.com/role/cmnxt4ge600010clalsuicaxr",
  "paraform.com/role/cmongspcu00050cle568v11e1",
  "paraform.com/role/cmpol5bmh00000cjpz3jr3leh",
  "paraform.com/share/222place/cmnyxau3l000f0cjfx7tsbp7s",
  "paraform.com/share/allen-institute-for-ai-(ai2)/cmr0qiknq00000dl5tk7290uv",
  "paraform.com/share/conduct.ai/cmre07ikz00000cl2se5mvlm0",
  "paraform.com/share/fermat/cmrl2akd2001b0cl1q24753ox",
  "paraform.com/share/firecrawl/cmro9t9cr00000cjuc78z4hpq",
  "paraform.com/share/inworld/cmraz5w2v00020cjl5sp4s768",
  "paraform.com/share/litellm/cmrb6lftc00000dlacbr8a4y1",
  "paraform.com/share/mai-agents/cmodlh67j000007kz2yc78514",
  "paraform.com/share/nuance-labs/cmlvhi30p00000ckvs4jkzom3",
  "paraform.com/share/opal-security/cmrbaxptt00000dl723actyqx",
  "paraform.com/share/superpanel/cmre0yczy00000ckzz4njni17",
  "paraform.com/share/unframe-ai/cmr9gqoiy000v0djyisuoz67a",
  "paraform.com/share/varick-agents/cmpd8764c00000dkvfh28009p",
  "paraform.com/share/vmax/cmpfs9svc00000djd0s4l698h",
  "paraform.com/share/volition-capital/cmq5jvr5000000bjl5n1qyrb9",
  "raydar.xyz/",
  "reducto.ai/",
  "rime.ai/",
  "semgrep.dev/",
  "strala.ai/",
  "superpanel.io/",
  "synthbee.com/",
  "triumpharcade.com/",
  "unframe.ai/",
  "varickagents.com/",
  "vmax.ai/",
  "volitioncapital.com/",
  "waystationai.com/",
  "withfulcrum.com/",
]);
const FORBIDDEN_SCHEDULING_IDENTITY = [
  {
    category: "personal-calendar",
    pattern:
      /\b(?:my|david(?:'s)?|noah(?:'s)?|alzen(?:'s)?|vanessa(?:'s)?)\s+(?:availability|booking\s+link|cal(?:endar)?|schedule)\b/iu,
  },
  {
    category: "personal-conversation",
    pattern:
      /\b(?:book|call|chat|connect|meet|pick|schedule|speak|time)\b[^.!?\n]{0,48}\b(?:with|for)\s+(?:me|david|noah|alzen|vanessa)\b/iu,
  },
  {
    category: "direct-person-reference",
    pattern:
      /\b(?:(?:call|chat|connect|meet|speak)(?:ing)?\s+with\s+(?:me|david|noah|alzen|vanessa)|me\s+directly|(?:david|noah|alzen|vanessa)\s+(?:can|will|'ll)\s+(?:call|chat|connect|meet|speak))\b/iu,
  },
  {
    category: "personal-callback",
    pattern:
      /\b(?:i(?:'ll|\s+will)|david|noah|alzen|vanessa)\s+(?:personally\s+)?(?:call|phone)\s+you\b/iu,
  },
];

function isDomain(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function trimUrlToken(value) {
  let token = String(value || "").trim();
  token = token.replace(/&(?:nbsp|quot|apos);?$/iu, "");
  token = token.replace(/[.,;:!?}\]]+$/u, "");
  while (token.endsWith(")")) {
    const opens = (token.match(/\(/gu) || []).length;
    const closes = (token.match(/\)/gu) || []).length;
    if (closes <= opens) break;
    token = token.slice(0, -1);
  }
  return token;
}

function parsePublicUrl(value) {
  const token = trimUrlToken(value);
  if (
    !token
    || token.includes("\\")
    || /(?:^|\/)\.{1,2}(?:\/|$)/u.test(
      token.replace(/^[a-z]+:\/\/[^/]+/iu, ""),
    )
  ) {
    return null;
  }
  let parsed;
  try {
    parsed = new URL(
      /^(?:https?:\/\/)/iu.test(token) ? token : `https://${token}`,
    );
  } catch {
    return null;
  }
  if (
    !["http:", "https:"].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || !parsed.hostname
  ) {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./u, "");
  const pathname = parsed.pathname.replace(/\/+$/u, "") || "/";
  return { host, pathname, port: parsed.port };
}

function classifyPublicUrl({ host, pathname, port }, context) {
  if (!port && REVIEWED_NON_SCHEDULING_URLS.has(`${host}${pathname}`)) {
    return "other-reviewed";
  }
  if (
    host === "book.raydar.xyz"
    && !port
    && ["/agent", "/human"].includes(pathname.toLowerCase())
  ) {
    return "native";
  }
  if (
    host === "paraform.com"
    && !port
    && pathname.toLowerCase() === "/cal/raydar/15min"
  ) {
    return "legacy-agent";
  }
  if (
    host === "calendly.com"
    && !port
    && [
      "/raydar-xyz",
      "/raydar.xyz",
      "/noah-raydar/new-role-chat",
    ].includes(pathname.toLowerCase())
  ) {
    return "legacy-human";
  }
  if (
    host === "calendly.com"
    && !port
    && /^\/(?:cancellations|reschedulings)(?:\/|$)/iu.test(pathname)
  ) {
    return "scheduling-management";
  }

  const provider =
    SCHEDULING_PROVIDER_DOMAINS.some((domain) => isDomain(host, domain))
    || (isDomain(host, "paraform.com") && /^\/cal(?:\/|$)/iu.test(pathname))
    || (
      isDomain(host, "hubspot.com")
      && /(?:^|\/)meetings(?:\/|$)/iu.test(pathname)
    )
    || host === "meetings.hubspot.com"
    || host === "scheduler.zoom.us"
    || host === "calendar.app.google"
    || (
      host === "calendar.google.com"
      && /\/appointments\/schedules(?:\/|$)/iu.test(pathname)
    )
    || (
      ["outlook.office.com", "outlook.office365.com"].includes(host)
      && /^\/(?:book|bookwithme)(?:\/|$)/iu.test(pathname)
    )
    || (
      host === "book.raydar.xyz"
      && !["/agent", "/human"].includes(pathname.toLowerCase())
    );
  if (provider) return "scheduling-provider-unclassified";
  if (SCHEDULING_PATH.test(pathname) || SCHEDULING_CONTEXT.test(context)) {
    return "scheduling-context-unclassified";
  }
  return "other-unreviewed";
}

function classifyUrlToken(token, parsed, context) {
  if (!parsed) return "invalid-url-unreviewed";
  const classification = classifyPublicUrl(parsed, context);
  if (classification === "native" || classification.startsWith("legacy-")) {
    const recognized = hasCandidateSchedulingLink(token);
    const rewritten = rewriteLegacySchedulingLinks(token);
    if (
      !recognized
      || (
        classification.startsWith("legacy-")
        && !rewritten.changed
      )
    ) {
      return `${classification}-unclassified`;
    }
  }
  return classification;
}

function localUrlContext(source, index, length) {
  const before = source.slice(0, index);
  const boundary =
    /(?:[.!?](?:\s|&nbsp;)+|\r?\n|<\/(?:div|li|p|td)>|<br\b[^>]*>)/giu;
  let start = Math.max(0, index - 160);
  for (const match of before.matchAll(boundary)) {
    start = Math.max(start, match.index + match[0].length);
  }
  const after = source.slice(index + length);
  boundary.lastIndex = 0;
  const next = boundary.exec(after);
  const end = Math.min(
    source.length,
    index + length + (next ? next.index : 160),
  );
  return source.slice(start, end).replace(/<[^>]*>/gu, " ");
}

export function inventoryUrlsFromText(value) {
  const source = String(value ?? "");
  const found = [];
  URL_TOKEN_PATTERN.lastIndex = 0;
  for (const match of source.matchAll(URL_TOKEN_PATTERN)) {
    const token = trimUrlToken(match[0]);
    const parsed = parsePublicUrl(token);
    const context = localUrlContext(source, match.index, token.length);
    const classification = classifyUrlToken(token, parsed, context);
    found.push({
      host: parsed
        ? (parsed.port ? `${parsed.host}:${parsed.port}` : parsed.host)
        : "invalid",
      path: parsed?.pathname || "/",
      classification,
    });
  }
  return found;
}

export function inventorySchedulingIdentityContext(value) {
  const source = String(value ?? "");
  const findings = [];
  const relevantUrls = [];
  URL_TOKEN_PATTERN.lastIndex = 0;
  for (const match of source.matchAll(URL_TOKEN_PATTERN)) {
    const token = trimUrlToken(match[0]);
    const parsed = parsePublicUrl(token);
    if (!parsed) continue;
    const context = localUrlContext(source, match.index, token.length)
      .replace(/&nbsp;/giu, " ")
      .replace(/\s+/gu, " ")
      .trim();
    const classification = classifyUrlToken(token, parsed, context);
    if (
      classification !== "native"
      && !classification.startsWith("legacy-")
      && classification !== "scheduling-provider-unclassified"
    ) {
      continue;
    }
    relevantUrls.push(parsed);
  }
  if (!relevantUrls.length) return [];
  const wholeField = source
    .replace(/<[^>]*>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  for (const rule of FORBIDDEN_SCHEDULING_IDENTITY) {
    if (!rule.pattern.test(wholeField)) continue;
    for (const parsed of relevantUrls) {
      findings.push({
        host: parsed.port ? `${parsed.host}:${parsed.port}` : parsed.host,
        path: parsed.pathname,
        category: rule.category,
        contextDigest: digest(wholeField.toLowerCase()),
      });
    }
  }
  return findings.filter((finding, index, all) =>
    all.findIndex((candidate) =>
      candidate.host === finding.host
      && candidate.path === finding.path
      && candidate.category === finding.category
      && candidate.contextDigest === finding.contextDigest) === index);
}

function parseArgs(argv) {
  const out = { mode: "audit", manifest: null };
  for (const arg of argv) {
    if (arg === "--audit") out.mode = "audit";
    else if (arg === "--apply") out.mode = "apply";
    else if (arg === "--rollback") out.mode = "rollback";
    else if (arg.startsWith("--manifest=")) out.manifest = arg.slice("--manifest=".length);
    else fail("ARGUMENT_INVALID");
  }
  return out;
}

function requirePrivateManifestPath(value) {
  if (!value || !path.isAbsolute(value)) fail("ABSOLUTE_MANIFEST_PATH_REQUIRED");
  const resolved = path.resolve(value);
  const repo = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  if (resolved === repo || resolved.startsWith(`${repo}${path.sep}`)) {
    fail("MANIFEST_MUST_BE_OUTSIDE_REPOSITORY");
  }
  return resolved;
}

// Paraform changes these server-owned fields independently of template
// semantics. Every other returned step field is safety-bearing and must survive
// the migration exactly: attachments, delays, weights, task/channel kind,
// stable identity, and creation metadata.
const VOLATILE_STEP_FIELDS = new Set([
  "bounced_count",
  "clicked_count",
  "interested_count",
  "opened_count",
  "replied_count",
  "sent_email_count",
  "updated_at",
]);

// Paraform's sequence mutation is now eventually consistent: the first
// successful getCampaign after updateSequenceSteps can still return the old
// text for tens of seconds. Poll a bounded two-minute window and require one
// complete exact projection; a permanent mismatch still fails closed and
// enters the rollback path. The longer final delay also gives a rollback write
// enough time to settle before it is reported as needing manual recovery.
export const READBACK_DELAYS_MS = Object.freeze([
  0,
  1_000,
  2_000,
  4_000,
  8_000,
  15_000,
  30_000,
  60_000,
]);

export async function readCampaignFresh(id, {
  fetchImpl = fetch,
  nonce = randomUUID(),
} = {}) {
  const input = encodeURIComponent(JSON.stringify({
    json: { campaign_id: id },
    meta: { values: {}, v: 1 },
  }));
  const response = await fetchImpl(
    `${BASE}/trpc/campaigns.getCampaign?input=${input}`
      + `&raydar_readback=${encodeURIComponent(nonce)}`,
    {
      headers: { ...headers(), "cache-control": "no-cache" },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (response.status === 401) fail("AUTH_EXPIRED");
  if (response.status === 429 || response.status >= 500) {
    fail("SEQUENCE_READBACK_TRANSPORT_FAILED");
  }
  if (!response.ok) fail("SEQUENCE_READBACK_REJECTED");
  const body = await response.json();
  if (body?.error) fail("SEQUENCE_READBACK_REJECTED");
  const campaign = body?.result?.data?.json;
  if (!campaign || typeof campaign !== "object") {
    fail("SEQUENCE_READBACK_INVALID");
  }
  return campaign;
}

function stepProjection(step) {
  return Object.fromEntries(
    Object.entries(step || {})
      .filter(([key]) => !VOLATILE_STEP_FIELDS.has(key))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function stepTextProjection(step) {
  const fieldState = (field) => Object.hasOwn(step || {}, field)
    ? { present: true, value: step[field] }
    : { present: false };
  return {
    id: step?.id ?? null,
    step_number: step?.step_number ?? null,
    subject: fieldState("subject"),
    body: fieldState("body"),
  };
}

function stepTextDigest(steps) {
  return digest((steps || []).map(stepTextProjection));
}

function mergeStepText(currentSteps, desiredSteps) {
  const desiredById = new Map(
    (desiredSteps || []).map((step) => [String(step?.id || ""), step]),
  );
  if (
    currentSteps.length !== desiredSteps.length
    || desiredById.size !== desiredSteps.length
  ) {
    fail("SEQUENCE_STEP_IDENTITY_DRIFT");
  }
  return currentSteps.map((current) => {
    const desired = desiredById.get(String(current?.id || ""));
    if (
      !desired
      || current.step_number !== desired.step_number
    ) {
      fail("SEQUENCE_STEP_IDENTITY_DRIFT");
    }
    const merged = { ...current };
    for (const field of ["subject", "body"]) {
      if (Object.hasOwn(desired, field)) merged[field] = desired[field];
      else delete merged[field];
    }
    return merged;
  });
}

function exactStepReadback(expected, actual) {
  const wanted = expected.map(stepProjection);
  const got = actual.map(stepProjection);
  return digest(wanted) === digest(got);
}

export function planSequence(sequence, campaign) {
  const steps = Array.isArray(campaign?.steps) ? campaign.steps : [];
  const sourceAttribution = {
    agent: sequenceSourceAttribution(sequence?.id, "agent"),
    human: sequenceSourceAttribution(sequence?.id, "human"),
  };
  const afterSteps = [];
  const changedSteps = [];
  const unknown = [];
  let agent = 0;
  let human = 0;
  let callouts = 0;
  let agentLabels = 0;
  let humanLabels = 0;
  const urls = [];
  const identityContextFindings = [];

  for (const step of steps) {
    let next = { ...step };
    const changedFields = [];
    for (const field of ["subject", "body"]) {
      const before = String(step?.[field] ?? "");
      const found = findLegacySchedulingLinks(before);
      for (const url of found.unknown) {
        const parsed = parsePublicUrl(url);
        unknown.push({
          step: step.step_number ?? null,
          field,
          host: parsed
            ? (parsed.port ? `${parsed.host}:${parsed.port}` : parsed.host)
            : "invalid",
          path: parsed?.pathname || "/",
        });
      }
      urls.push(...inventoryUrlsFromText(before).map((url) => ({
        ...url,
        step: step.step_number ?? null,
        field,
      })));
      const rewritten = rewriteLegacySchedulingLinks(before, {
        agentSourceAttribution: sourceAttribution.agent,
        humanSourceAttribution: sourceAttribution.human,
      });
      if (rewritten.changed) {
        next[field] = rewritten.value;
        changedFields.push(field);
        agent += rewritten.replacements.agent;
        human += rewritten.replacements.human;
        callouts += rewritten.copyNormalizations.callouts;
        agentLabels += rewritten.copyNormalizations.agentLabels;
        humanLabels += rewritten.copyNormalizations.humanLabels;
      }
    }
    if (changedFields.length) {
      changedSteps.push({
        step: step.step_number ?? null,
        fields: changedFields,
      });
    }
    afterSteps.push(next);
    for (const field of ["subject", "body"]) {
      identityContextFindings.push(
        ...inventorySchedulingIdentityContext(next?.[field]).map((finding) => ({
          ...finding,
          step: step.step_number ?? null,
          field,
        })),
      );
    }
  }

  return {
    id: sequence.id,
    name: sequence.name,
    enabled: Boolean(sequence.enabled),
    beforeSteps: steps,
    afterSteps,
    changedSteps,
    replacements: { agent, human },
    copyNormalizations: { callouts, agentLabels, humanLabels },
    unknown,
    urls,
    identityContextFindings,
    sourceAttribution,
    linkBearing: steps.some((step) =>
      ["subject", "body"].some((field) =>
        hasCandidateSchedulingLink(step?.[field]))),
    changed: changedSteps.length > 0,
    beforeDigest: digest(steps.map(stepProjection)),
    afterDigest: digest(afterSteps.map(stepProjection)),
    beforeTextDigest: stepTextDigest(steps),
    afterTextDigest: stepTextDigest(afterSteps),
  };
}

export async function loadPlans({
  listSequences = async () =>
    withThrottleRetry(() =>
      trpcGet("campaigns.getListOfCampaignsOptimized", {}, 1)),
  // Every catalog snapshot participates in the transactional proof. Use the
  // same nonce/no-store path as per-write verification so the final full
  // catalog pass cannot mistake a provider cache entry for rollback-worthy
  // drift.
  readCampaign = async (id) =>
    withThrottleRetry(() => readCampaignFresh(id)),
  minimumSequenceCount = REVIEWED_SEQUENCE_CATALOG_FLOOR,
} = {}) {
  const sequences = await listSequences();
  if (
    !Array.isArray(sequences)
    || !Number.isInteger(minimumSequenceCount)
    || minimumSequenceCount < 1
    || sequences.length < minimumSequenceCount
  ) {
    fail("SEQUENCE_CATALOG_INVALID");
  }
  const seenSequenceIds = new Set();
  for (const sequence of sequences) {
    if (
      !sequence
      || typeof sequence !== "object"
      || typeof sequence.id !== "string"
      || !sequence.id
      || seenSequenceIds.has(sequence.id)
    ) {
      fail("SEQUENCE_CATALOG_INVALID");
    }
    seenSequenceIds.add(sequence.id);
  }
  const plans = [];
  for (const sequence of sequences) {
    const campaign = await readCampaign(sequence.id);
    if (
      !campaign
      || typeof campaign !== "object"
      || !Array.isArray(campaign.steps)
      || (sequence.enabled && !campaign.steps.length)
    ) {
      fail("SEQUENCE_CAMPAIGN_INVALID");
    }
    const seenStepIds = new Set();
    for (const step of campaign.steps) {
      if (
        !step
        || typeof step !== "object"
        || Array.isArray(step)
        || typeof step.id !== "string"
        || !step.id
        || seenStepIds.has(step.id)
        || !Number.isInteger(step.step_number)
      ) {
        fail("SEQUENCE_CAMPAIGN_INVALID");
      }
      seenStepIds.add(step.id);
    }
    plans.push(planSequence(sequence, campaign));
  }
  return {
    sequenceCount: sequences.length,
    catalogDigest: digest(
      sequences
        .map((sequence) => ({
          id: sequence.id,
          name: sequence.name ?? null,
          enabled: Boolean(sequence.enabled),
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    ),
    contentDigest: digest(
      plans
        .map((plan) => ({
          id: plan.id,
          beforeDigest: plan.beforeDigest,
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    ),
    totalStepCount: plans.reduce(
      (sum, plan) => sum + plan.beforeSteps.length,
      0,
    ),
    plans,
  };
}

function requireStableSnapshot(expected, actual) {
  if (
    actual.sequenceCount !== expected.sequenceCount
    || actual.catalogDigest !== expected.catalogDigest
    || actual.contentDigest !== expected.contentDigest
    || actual.totalStepCount !== expected.totalStepCount
  ) {
    fail("SEQUENCE_SNAPSHOT_UNSTABLE");
  }
}

function migrationSourceCommit() {
  const value = String(
    process.env.SCHEDULER_SEQUENCE_MIGRATION_SOURCE_SHA || "",
  ).trim();
  if (!/^[a-f0-9]{40}$/u.test(value)) {
    fail("MIGRATION_SOURCE_SHA_REQUIRED");
  }
  return value;
}

function redactedInventory(
  sequenceCount,
  plans,
  catalogDigest,
  contentDigest = null,
  totalStepCount = null,
) {
  const changed = plans.filter((plan) => plan.changed);
  const urlMap = new Map();
  for (const plan of plans) {
    for (const url of plan.urls) {
      const key = `${url.classification}\n${url.host}\n${url.path}`;
      const existing = urlMap.get(key) || {
        host: url.host,
        path: url.path,
        classification: url.classification,
        occurrences: 0,
        locations: [],
      };
      existing.occurrences++;
      existing.locations.push({
        sequenceId: plan.id,
        sequenceName: plan.name,
        enabled: plan.enabled,
        step: url.step,
        field: url.field,
      });
      urlMap.set(key, existing);
    }
  }
  const urls = [...urlMap.values()].sort((left, right) =>
    left.host.localeCompare(right.host)
    || left.path.localeCompare(right.path)
    || left.classification.localeCompare(right.classification));
  const byClassification = Object.fromEntries(
    [...new Set(urls.map((url) => url.classification))]
      .sort()
      .map((classification) => [
        classification,
        urls
          .filter((url) => url.classification === classification)
          .reduce((sum, url) => sum + url.occurrences, 0),
      ]),
  );
  const requiringClassification = urls.filter((url) =>
    url.classification.endsWith("-unclassified")
    || url.classification.endsWith("-unreviewed"));
  return {
    schema: MANIFEST_SCHEMA,
    mode: "audit",
    sequenceCount,
    catalogDigest,
    contentDigest,
    totalStepCount,
    bookingStopScopeSchema: BOOKING_STOP_SCOPE_SCHEMA,
    bookingStopScopeDigest: bookingStopScopeDigest(plans.map((plan) => ({
      id: plan.id,
      enabled: plan.enabled,
      linkBearing: plan.linkBearing,
      nudgeBearing: isNudgeSequence(plan),
      selected: isNudgeSequence(plan) || (plan.enabled && plan.linkBearing),
    }))),
    sequencesWithLegacyLinks: changed.length,
    enabledWithLegacyLinks: changed.filter((plan) => plan.enabled).length,
    disabledWithLegacyLinks: changed.filter((plan) => !plan.enabled).length,
    agentReplacements: changed.reduce((sum, plan) => sum + plan.replacements.agent, 0),
    humanReplacements: changed.reduce((sum, plan) => sum + plan.replacements.human, 0),
    calloutCopyNormalizations: changed.reduce((sum, plan) => sum + plan.copyNormalizations.callouts, 0),
    agentLinkLabelNormalizations: changed.reduce((sum, plan) => sum + plan.copyNormalizations.agentLabels, 0),
    humanLinkLabelNormalizations: changed.reduce((sum, plan) => sum + plan.copyNormalizations.humanLabels, 0),
    unknownLegacyLinks: plans.reduce((sum, plan) => sum + plan.unknown.length, 0),
    urlInventory: {
      uniqueUrls: urls.length,
      occurrences: urls.reduce((sum, url) => sum + url.occurrences, 0),
      byClassification,
      requiringClassification: requiringClassification.length,
      urls,
    },
    identityContextFindings: {
      count: plans.reduce(
        (sum, plan) => sum + plan.identityContextFindings.length,
        0,
      ),
      findings: plans.flatMap((plan) =>
        plan.identityContextFindings.map((finding) => ({
          sequenceId: plan.id,
          sequenceName: plan.name,
          enabled: plan.enabled,
          ...finding,
        }))),
    },
    sequences: changed.map((plan) => ({
      id: plan.id,
      name: plan.name,
      enabled: plan.enabled,
      changedSteps: plan.changedSteps,
      replacements: plan.replacements,
      copyNormalizations: plan.copyNormalizations,
      unknown: plan.unknown,
      beforeDigest: plan.beforeDigest,
      afterDigest: plan.afterDigest,
      beforeTextDigest: plan.beforeTextDigest,
      afterTextDigest: plan.afterTextDigest,
    })),
  };
}

function schedulerHealthUrl() {
  const readKey = String(
    process.env.RAYDAR_SCHEDULER_INTEGRATION_READ_KEY || "",
  ).trim();
  let base;
  try {
    base = new URL(
      String(process.env.RAYDAR_SCHEDULER_INTEGRATION_URL || ""),
    );
  } catch {
    fail("SCHEDULER_READINESS_CONFIG_INVALID");
  }
  if (
    base.protocol !== "https:"
    || base.username
    || base.password
    || base.search
    || base.hash
    || (base.pathname !== "/" && base.pathname !== "")
    || readKey.length < 32
    || /\s/u.test(readKey)
  ) {
    fail("SCHEDULER_READINESS_CONFIG_INVALID");
  }
  return {
    url: new URL("/api/health", base),
    readKey,
  };
}

export async function requireCutoverReadiness(
  fetchImpl = fetch,
  expectedScopeDigest = null,
) {
  for (const url of [AGENT_SCHEDULING_URL, HUMAN_SCHEDULING_URL]) {
    const expectedRoute = url === AGENT_SCHEDULING_URL ? "agent" : "human";
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      fail("SCHEDULER_ROUTE_UNAVAILABLE");
    }
    if (
      !response.ok
      || response.headers.get("x-raydar-scheduler-route") !== expectedRoute
    ) {
      fail("SCHEDULER_ROUTE_UNAVAILABLE");
    }
  }

  let response;
  try {
    response = await fetchImpl(HEALTH_URL, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    fail("BOOKING_STOP_HEALTH_UNAVAILABLE");
  }
  const health = await response.json().catch(() => null);
  const native = health?.bookingStop?.raydarScheduler;
  if (!response.ok
    || health?.ok !== true
    || health?.cookieSet !== true
    || health?.paraform !== "live"
    || health?.bookingStop?.stale !== false
    || native?.enabled !== true
    || native?.applyEnabled !== true
    || native?.webhookConfigured !== true
    || native?.webhookVerified !== true
    || native?.pauseCanaryConfigured !== true
    || native?.pauseCanaryVerified !== true
    || native?.latestWebhookApply !== true
    || native?.latestWebhookDeferred !== false
    || !Number.isInteger(native?.latestWebhookAgeMinutes)
    || native.latestWebhookAgeMinutes < 0
    || native.latestWebhookAgeMinutes > MAX_CUTOVER_WEBHOOK_AGE_MINUTES
    || native?.lastWebhookApply !== true
    || native?.lastWebhookDeferred !== false
    || !Number.isInteger(native?.lastWebhookMatched)
    || native.lastWebhookMatched < 1
    || !Number.isInteger(native?.lastWebhookPaused)
    || native.lastWebhookPaused < 1
    || !Number.isInteger(native?.lastWebhookAgeMinutes)
    || native.lastWebhookAgeMinutes < 0
    || native.lastWebhookAgeMinutes > MAX_CUTOVER_WEBHOOK_AGE_MINUTES
    || native?.indexConfigured !== true
    || native?.lastSweepCalendlyComplete !== true
    || native?.lastSweepEnabled !== true
    || native?.lastSweepComplete !== true
    || !Number.isInteger(native?.bookingsLastPass)
    || native.bookingsLastPass < 1
    || native?.lastSweepLinkScopeComplete !== true
    || native?.lastSweepScopeSchema !== BOOKING_STOP_SCOPE_SCHEMA
    || !/^[a-f0-9]{64}$/u.test(String(native?.lastSweepScopeDigest || ""))
    || native?.lastSweepScopeCatalogFloor
      !== BOOKING_STOP_REVIEWED_CATALOG_FLOOR
    || (
      expectedScopeDigest
      && native.lastSweepScopeDigest !== expectedScopeDigest
    )
    || !Number.isInteger(native?.lastSweepSequenceCatalogCount)
    || native.lastSweepSequenceCatalogCount
      < REVIEWED_SEQUENCE_CATALOG_FLOOR
    || native?.lastSweepSequenceScopeScanned
      !== native.lastSweepSequenceCatalogCount
    || !Number.isInteger(native?.lastSweepLinkSequences)
    || native.lastSweepLinkSequences < 1
    || !Number.isInteger(native?.lastSweepEnabledLinkSequences)
    || native.lastSweepEnabledLinkSequences < 1
    || !Number.isInteger(native?.lastSweepCoveredEnabledLinkSequences)
    || native.lastSweepCoveredEnabledLinkSequences
      !== native.lastSweepEnabledLinkSequences
    || native.lastSweepLinkSequences
      < native.lastSweepEnabledLinkSequences) {
    fail("BOOKING_STOP_NOT_CUTOVER_READY");
  }
  if (
    native?.latestSweepAttemptStatus !== "success"
    || native?.latestSweepAttemptCurrent !== true
    || !Number.isInteger(native?.latestSweepAttemptAgeMinutes)
    || native.latestSweepAttemptAgeMinutes < 0
    || native.latestSweepAttemptAgeMinutes > MAX_CUTOVER_SWEEP_AGE_MINUTES
    || native?.leadIndexCurrent !== true
    || !Number.isInteger(native?.leadIndexAgeMinutes)
    || native.leadIndexAgeMinutes < 0
    || native.leadIndexAgeMinutes > MAX_CUTOVER_SWEEP_AGE_MINUTES
  ) {
    fail("BOOKING_STOP_NOT_CUTOVER_READY");
  }

  const scheduler = schedulerHealthUrl();
  let schedulerResponse;
  try {
    schedulerResponse = await fetchImpl(scheduler.url, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${scheduler.readKey}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    fail("SCHEDULER_READINESS_UNAVAILABLE");
  }
  const schedulerHealth = await schedulerResponse.json().catch(() => null);
  if (
    !schedulerResponse.ok
    || schedulerHealth?.schema !== "raydar-scheduler-health-v1"
    || schedulerHealth?.readyForCutover !== true
    || schedulerHealth?.migrationComplete !== false
  ) {
    fail("SCHEDULER_NOT_CUTOVER_READY");
  }
}

async function writeManifest(manifestPath, changed, sourceCommit) {
  const payload = {
    schema: MANIFEST_SCHEMA,
    codeVersion: MIGRATION_CODE_VERSION,
    sourceCommit,
    createdAt: new Date().toISOString(),
    targets: {
      agent: AGENT_SCHEDULING_URL,
      human: HUMAN_SCHEDULING_URL,
    },
    sourceAttributionStrategy: {
      schema: "raydar-sequence-source-v1",
      format: "paraform_sequence_<call-type>.<sha256(sequence-id)[0:16]>",
    },
    sequences: changed.map((plan) => ({
      id: plan.id,
      name: plan.name,
      enabledAtSnapshot: plan.enabled,
      beforeSteps: plan.beforeSteps,
      afterSteps: plan.afterSteps,
      beforeDigest: plan.beforeDigest,
      afterDigest: plan.afterDigest,
      beforeTextDigest: plan.beforeTextDigest,
      afterTextDigest: plan.afterTextDigest,
    })),
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

export async function updateAndVerify(entry, steps, {
  direction = "apply",
  readCampaign = async (id) => withThrottleRetry(() =>
    readCampaignFresh(id)),
  writeSteps = async (id, value) => withThrottleRetry(() =>
    trpcPost("campaigns.updateSequenceSteps", {
      campaign_id: id,
      steps: value,
    }, 1)),
  readbackDelaysMs = READBACK_DELAYS_MS,
  sleepImpl = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
} = {}) {
  const beforeWrite = await readCampaign(entry.id);
  const currentSteps = Array.isArray(beforeWrite?.steps)
    ? beforeWrite.steps
    : [];
  if (direction === "apply") {
    const currentDigest = digest(currentSteps.map(stepProjection));
    if (currentDigest !== entry.beforeDigest) {
      fail("SEQUENCE_PREWRITE_DRIFT");
    }
  } else if (direction === "rollback") {
    const currentTextDigest = stepTextDigest(currentSteps);
    if (
      currentTextDigest !== entry.beforeTextDigest
      && currentTextDigest !== entry.afterTextDigest
    ) {
      fail("ROLLBACK_CURRENT_STATE_DRIFT");
    }
  } else {
    fail("MIGRATION_DIRECTION_INVALID");
  }

  // Rebase only the intended subject/body edits onto the immediately current
  // server objects. This preserves delays, attachments, weights, task kinds,
  // counters, and any other Paraform-managed fields rather than replaying a
  // stale full-step snapshot.
  const merged = mergeStepText(currentSteps, steps);
  await writeSteps(entry.id, merged);
  for (const delayMs of readbackDelaysMs) {
    if (delayMs > 0) await sleepImpl(delayMs);
    const readback = await readCampaign(entry.id);
    const readbackSteps = Array.isArray(readback?.steps) ? readback.steps : [];
    if (exactStepReadback(merged, readbackSteps)) return;
  }
  fail("SEQUENCE_READBACK_MISMATCH");
}

export async function rollbackEntries(entries, writeAndVerify = updateAndVerify) {
  const failures = [];
  for (const entry of [...entries].reverse()) {
    try {
      await writeAndVerify(entry, entry.beforeSteps, {
        direction: "rollback",
      });
    }
    catch { failures.push({ id: entry.id, name: entry.name }); }
  }
  if (failures.length) {
    const error = new Error("ROLLBACK_READBACK_FAILED");
    error.code = "ROLLBACK_READBACK_FAILED";
    error.failures = failures;
    throw error;
  }
}

export async function migratePlansTransaction(changed, {
  writeAndVerify = updateAndVerify,
  verifyComplete = async () => {},
} = {}) {
  const attempted = [];
  try {
    for (const plan of changed) {
      // Include the current target before issuing its write. If the write
      // succeeds but the read-back request fails or detects drift, this target
      // must still be restored from the pre-write manifest.
      attempted.push(plan);
      await writeAndVerify(plan, plan.afterSteps, {
        direction: "apply",
      });
    }
    await verifyComplete();
    return attempted;
  } catch (error) {
    try {
      await rollbackEntries(attempted, writeAndVerify);
    } catch (rollbackError) {
      rollbackError.cause = error;
      throw rollbackError;
    }
    throw error;
  }
}

async function applyMigration(args) {
  if (process.env.SCHEDULER_SEQUENCE_LINK_CUTOVER !== APPLY_PHRASE) {
    fail("APPLY_CONFIRMATION_MISSING");
  }
  if (process.env.SCHEDULER_SEQUENCE_EDIT_FREEZE_ACK !== EDIT_FREEZE_PHRASE) {
    fail("SEQUENCE_EDIT_FREEZE_ACK_MISSING");
  }
  const sourceCommit = migrationSourceCommit();
  const manifestPath = requirePrivateManifestPath(args.manifest);
  await requireCutoverReadiness();

  const snapshot = await loadPlans();
  const {
    sequenceCount,
    catalogDigest,
    contentDigest,
    totalStepCount,
    plans,
  } = snapshot;
  const inventory = redactedInventory(
    sequenceCount,
    plans,
    catalogDigest,
    contentDigest,
    totalStepCount,
  );
  if (inventory.unknownLegacyLinks) fail("UNKNOWN_SCHEDULING_LINKS_REQUIRE_CLASSIFICATION");
  if (inventory.urlInventory.requiringClassification) {
    fail("UNCLASSIFIED_SCHEDULING_LINKS_REQUIRE_CLASSIFICATION");
  }
  if (inventory.identityContextFindings.count) {
    fail("PERSON_SPECIFIC_SCHEDULING_COPY_REMAINS");
  }
  const stableSnapshot = await loadPlans();
  requireStableSnapshot(snapshot, stableSnapshot);
  await requireCutoverReadiness(fetch, inventory.bookingStopScopeDigest);

  const changed = plans.filter((plan) => plan.changed);
  if (!changed.length) return { ...inventory, mode: "apply", alreadyMigrated: true };

  await writeManifest(manifestPath, changed, sourceCommit);
  // The inventory read is deliberately complete and can take close to a minute.
  // Re-check immediately before the first candidate-facing mutation.
  await requireCutoverReadiness(fetch, inventory.bookingStopScopeDigest);
  const applied = await migratePlansTransaction(changed, {
    verifyComplete: async () => {
      // Route/booking-stop readiness is part of post-write read-back. If the
      // destination degraded during the batch, restoring legacy links is safer
      // than leaving a partially operational cutover.
      await requireCutoverReadiness(fetch, inventory.bookingStopScopeDigest);
      const final = await loadPlans();
      const remaining = final.plans.filter((plan) => plan.changed || plan.unknown.length);
      if (remaining.length) fail("POST_MIGRATION_LEGACY_LINKS_REMAIN");
      const finalInventory = redactedInventory(
        final.sequenceCount,
        final.plans,
        final.catalogDigest,
        final.contentDigest,
        final.totalStepCount,
      );
      if (
        final.sequenceCount !== sequenceCount
        || final.catalogDigest !== catalogDigest
        || finalInventory.bookingStopScopeDigest
          !== inventory.bookingStopScopeDigest
      ) {
        fail("POST_MIGRATION_CATALOG_DRIFT");
      }
      if (finalInventory.urlInventory.requiringClassification) {
        fail("POST_MIGRATION_UNCLASSIFIED_SCHEDULING_LINKS_REMAIN");
      }
      if (finalInventory.identityContextFindings.count) {
        fail("POST_MIGRATION_PERSON_SPECIFIC_COPY_REMAINS");
      }
      const finalStable = await loadPlans();
      requireStableSnapshot(final, finalStable);
      const finalById = new Map(final.plans.map((plan) => [plan.id, plan]));
      for (const expected of plans) {
        const expectedDigest = expected.changed
          ? expected.afterDigest
          : expected.beforeDigest;
        if (finalById.get(expected.id)?.beforeDigest !== expectedDigest) {
          fail("POST_MIGRATION_READBACK_DRIFT");
        }
      }
      await requireCutoverReadiness(fetch, inventory.bookingStopScopeDigest);
    },
  });

  return {
    ...inventory,
    mode: "apply",
    migrated: applied.length,
    readbackVerified: applied.length,
    rollbackManifest: manifestPath,
  };
}

async function rollbackMigration(args) {
  if (process.env.SCHEDULER_SEQUENCE_LINK_CUTOVER !== ROLLBACK_PHRASE) {
    fail("ROLLBACK_CONFIRMATION_MISSING");
  }
  if (process.env.SCHEDULER_SEQUENCE_EDIT_FREEZE_ACK !== EDIT_FREEZE_PHRASE) {
    fail("SEQUENCE_EDIT_FREEZE_ACK_MISSING");
  }
  const manifestPath = requirePrivateManifestPath(args.manifest);
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (manifest?.schema !== MANIFEST_SCHEMA
    || manifest?.codeVersion !== MIGRATION_CODE_VERSION
    || !/^[a-f0-9]{40}$/u.test(String(manifest?.sourceCommit || ""))
    || manifest?.targets?.agent !== AGENT_SCHEDULING_URL
    || manifest?.targets?.human !== HUMAN_SCHEDULING_URL
    || !Array.isArray(manifest.sequences)
    || !manifest.sequences.length) {
    fail("ROLLBACK_MANIFEST_INVALID");
  }
  const seenIds = new Set();
  for (const entry of manifest.sequences) {
    if (typeof entry?.id !== "string"
      || !entry.id
      || seenIds.has(entry.id)
      || !Array.isArray(entry.beforeSteps)
      || !Array.isArray(entry.afterSteps)
      || entry.beforeDigest !== digest(entry.beforeSteps.map(stepProjection))
      || entry.afterDigest !== digest(entry.afterSteps.map(stepProjection))
      || entry.beforeTextDigest !== stepTextDigest(entry.beforeSteps)
      || entry.afterTextDigest !== stepTextDigest(entry.afterSteps)) {
      fail("ROLLBACK_MANIFEST_INVALID");
    }
    seenIds.add(entry.id);
  }
  if (migrationSourceCommit() !== manifest.sourceCommit) {
    fail("ROLLBACK_SOURCE_SHA_MISMATCH");
  }

  // Never overwrite post-cutover operator edits. Every target must still equal
  // the exact native state captured in the manifest (or already be restored).
  for (const entry of manifest.sequences) {
    const current = await withThrottleRetry(() =>
      trpcGet("campaigns.getCampaign", {
        campaign_id: entry.id,
      }, 1));
    const currentTextDigest = stepTextDigest(current?.steps || []);
    if (
      currentTextDigest !== entry.afterTextDigest
      && currentTextDigest !== entry.beforeTextDigest
    ) {
      fail("ROLLBACK_CURRENT_STATE_DRIFT");
    }
  }
  await rollbackEntries(manifest.sequences);
  return {
    schema: MANIFEST_SCHEMA,
    mode: "rollback",
    restored: manifest.sequences.length,
    readbackVerified: manifest.sequences.length,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.mode === "apply") return applyMigration(args);
  if (args.mode === "rollback") return rollbackMigration(args);
  const {
    sequenceCount,
    catalogDigest,
    contentDigest,
    totalStepCount,
    plans,
  } = await loadPlans();
  return redactedInventory(
    sequenceCount,
    plans,
    catalogDigest,
    contentDigest,
    totalStepCount,
  );
}

const isCli = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  main().then(
    (result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`),
    (error) => {
      process.stderr.write(`${JSON.stringify({
        ok: false,
        error: String(error?.code || error?.message || "migration_failed"),
        rollbackFailures: error?.failures || undefined,
      })}\n`);
      process.exitCode = 1;
    },
  );
}
