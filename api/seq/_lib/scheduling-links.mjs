export const AGENT_SCHEDULING_URL = "https://book.raydar.xyz/agent";
export const HUMAN_SCHEDULING_URL = "https://book.raydar.xyz/intro";

// These are candidate-facing sequence URLs only. Calendly cancellation and
// rescheduling URLs are deliberately not matched.
const LEGACY_RULES = [
  {
    callType: "agent",
    pattern: /(?<![a-z0-9@._/-])(?:(?:https?:)?\/\/)?(?:www\.)?paraform\.com(?::(?:80|443))?\/cal\/raydar\/15min\/?(?:[?#][^\s<>"']*)?[)\],.;:!?]*(?=$|[\s<>"'])/gi,
    replacement: AGENT_SCHEDULING_URL,
  },
  {
    callType: "human",
    // Live Paraform content uses `raydar-xyz`; the legacy URL supplied in the
    // cutover brief uses `raydar.xyz`. Both are the same Intro Call intent.
    pattern: /(?<![a-z0-9@._/-])(?:(?:https?:)?\/\/)?(?:www\.)?calendly\.com(?::(?:80|443))?\/raydar[-.]xyz\/?(?:[?#][^\s<>"']*)?[)\],.;:!?]*(?=$|[\s<>"'])/gi,
    replacement: HUMAN_SCHEDULING_URL,
  },
  {
    callType: "human",
    pattern: /(?<![a-z0-9@._/-])(?:(?:https?:)?\/\/)?(?:www\.)?calendly\.com(?::(?:80|443))?\/noah-raydar\/new-role-chat\/?(?:[?#][^\s<>"']*)?[)\],.;:!?]*(?=$|[\s<>"'])/gi,
    replacement: HUMAN_SCHEDULING_URL,
  },
];
const NATIVE_RULES = [
  {
    callType: "agent",
    pattern:
      /(?<![a-z0-9@._/-])(?:(?:https?:)?\/\/)?(?:www\.)?book\.raydar\.xyz(?::(?:80|443))?\/agent\/?(?:[?#][^\s<>"']*)?[)\],.;:!?]*(?=$|[\s<>"'])/gi,
    replacement: AGENT_SCHEDULING_URL,
  },
  {
    callType: "human",
    pattern:
      /(?<![a-z0-9@._/-])(?:(?:https?:)?\/\/)?(?:www\.)?book\.raydar\.xyz(?::(?:80|443))?\/intro\/?(?:[?#][^\s<>"']*)?[)\],.;:!?]*(?=$|[\s<>"'])/gi,
    replacement: HUMAN_SCHEDULING_URL,
  },
  {
    // `/human` is the superseded public path. Keep recognizing it so existing
    // sequence copy is normalized to `/intro` instead of falling out of pause
    // scope while the Scheduler's permanent redirect preserves old links.
    callType: "human",
    pattern:
      /(?<![a-z0-9@._/-])(?:(?:https?:)?\/\/)?(?:www\.)?book\.raydar\.xyz(?::(?:80|443))?\/human\/?(?:[?#][^\s<>"']*)?[)\],.;:!?]*(?=$|[\s<>"'])/gi,
    replacement: HUMAN_SCHEDULING_URL,
  },
];

const ANY_LEGACY_CALENDAR_URL =
  /(?<![a-z0-9@._/-])(?:(?:https?:)?\/\/)?(?:www\.)?(?:paraform\.com\/cal\/[^\s<>'"]+|calendly\.com\/[^\s<>'"]+)/gi;
const CALENDLY_MANAGEMENT_URL =
  /^(?:(?:https?:)?\/\/)?(?:www\.)?calendly\.com\/(?:cancellations|reschedulings)(?:\/|$)/i;

const CALLOUT_COPY_RULES = [
  {
    pattern: /if opposed to the agent chat please grab a time with me directly/gi,
    replacement: "if you prefer a phone call, use Raydar's Intro Call option:",
  },
  {
    pattern: /if you don't want to chat with the agent,\s*grab a time with me directly/gi,
    replacement: "If you prefer a phone call, use Raydar's Intro Call option:",
  },
  {
    pattern: /Interested\?(?:\s|&nbsp;)+Grab(?:\s|&nbsp;)+a(?:\s|&nbsp;)+time(?:\s|&nbsp;)+here:(?:\s|&nbsp;)*/gi,
    replacement: "Interested? Book an Intro Call with Raydar here: ",
  },
];

function trimProsePunctuation(value) {
  let url = String(value || "").replace(/[.,;:!?}\]]+$/u, "");
  while (url.endsWith(")")) {
    const opens = (url.match(/\(/gu) || []).length;
    const closes = (url.match(/\)/gu) || []).length;
    if (closes <= opens) break;
    url = url.slice(0, -1);
  }
  return url;
}

const SOURCE_ATTRIBUTION = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

function schedulingUrl(callType, sourceAttribution = null) {
  const url = callType === "agent" ? AGENT_SCHEDULING_URL : HUMAN_SCHEDULING_URL;
  if (sourceAttribution == null) return url;
  const source = String(sourceAttribution).trim().toLowerCase();
  if (!SOURCE_ATTRIBUTION.test(source)) {
    const error = new Error("SCHEDULING_SOURCE_ATTRIBUTION_INVALID");
    error.code = "SCHEDULING_SOURCE_ATTRIBUTION_INVALID";
    throw error;
  }
  return `${url}?src=${encodeURIComponent(source)}`;
}

function canonicalizeNativeAnchorLabel(
  value,
  callType,
  sourceAttribution = null,
) {
  const baseUrl = callType === "agent"
    ? AGENT_SCHEDULING_URL
    : HUMAN_SCHEDULING_URL;
  const url = schedulingUrl(callType, sourceAttribution);
  const label = callType === "agent"
    ? "Book an Agent Call with Raydar"
    : "Book an Intro Call with Raydar";
  const escapedUrl = baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(<a\\b[^>]*\\bhref\\s*=\\s*)(["'])${escapedUrl}(?:\\?src=[a-z0-9._-]{1,64})?\\2([^>]*)>[\\s\\S]*?<\\/a>`,
    "gi",
  );
  let count = 0;
  const next = value.replace(
    pattern,
    (match, prefix, quote, suffix) => {
      const replacement = `${prefix}${quote}${url}${quote}${suffix}>${label}</a>`;
      if (replacement !== match) count++;
      return replacement;
    },
  );
  return { value: next, count };
}

export function rewriteLegacySchedulingLinks(value, {
  agentSourceAttribution = null,
  humanSourceAttribution = null,
} = {}) {
  let output = String(value ?? "");
  const replacements = { agent: 0, human: 0 };
  const copyNormalizations = { callouts: 0, agentLabels: 0, humanLabels: 0 };
  const sources = {
    agent: agentSourceAttribution,
    human: humanSourceAttribution,
  };
  for (const rule of LEGACY_RULES) {
    output = output.replace(rule.pattern, (match) => {
      replacements[rule.callType]++;
      const suffix = match.match(/[)\],.;:!?]+$/u)?.[0] || "";
      return `${schedulingUrl(rule.callType, sources[rule.callType])}${suffix}`;
    });
  }
  for (const rule of NATIVE_RULES) {
    output = output.replace(rule.pattern, (match) => {
      const suffix = match.match(/[)\],.;:!?]+$/u)?.[0] || "";
      return `${schedulingUrl(rule.callType, sources[rule.callType])}${suffix}`;
    });
  }
  const hasHumanSchedulingUrl = NATIVE_RULES
    .filter((rule) => rule.callType === "human")
    .some((rule) => {
      rule.pattern.lastIndex = 0;
      return rule.pattern.test(output);
    });
  if (hasHumanSchedulingUrl) {
    for (const rule of CALLOUT_COPY_RULES) {
      output = output.replace(rule.pattern, () => {
        copyNormalizations.callouts++;
        return rule.replacement;
      });
    }
  }
  const agentAnchors = canonicalizeNativeAnchorLabel(
    output,
    "agent",
    agentSourceAttribution,
  );
  output = agentAnchors.value;
  copyNormalizations.agentLabels = agentAnchors.count;
  const humanAnchors = canonicalizeNativeAnchorLabel(
    output,
    "human",
    humanSourceAttribution,
  );
  output = humanAnchors.value;
  copyNormalizations.humanLabels = humanAnchors.count;
  return {
    value: output,
    replacements,
    copyNormalizations,
    changed: output !== String(value ?? ""),
  };
}

export function findLegacySchedulingLinks(value) {
  const source = String(value ?? "");
  const known = [];
  for (const rule of LEGACY_RULES) {
    rule.pattern.lastIndex = 0;
    for (const match of source.matchAll(rule.pattern)) {
      known.push({
        callType: rule.callType,
        value: trimProsePunctuation(match[0]),
      });
    }
  }
  const knownValues = new Set(known.map((item) => item.value.toLowerCase()));
  const unknown = [...source.matchAll(ANY_LEGACY_CALENDAR_URL)]
    .map((match) => trimProsePunctuation(match[0]))
    .filter((url) => !CALENDLY_MANAGEMENT_URL.test(url))
    .filter((url) => !knownValues.has(url.toLowerCase()));
  return { known, unknown: [...new Set(unknown)] };
}

export function hasCandidateSchedulingLink(value) {
  const source = String(value ?? "");
  for (const rule of NATIVE_RULES) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(source)) return true;
  }
  const legacy = findLegacySchedulingLinks(source);
  return legacy.known.length > 0 || legacy.unknown.length > 0;
}
