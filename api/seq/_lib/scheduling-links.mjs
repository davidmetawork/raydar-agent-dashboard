export const AGENT_SCHEDULING_URL = "https://book.raydar.xyz/agent";
export const HUMAN_SCHEDULING_URL = "https://book.raydar.xyz/human";

// These are candidate-facing sequence URLs only. Calendly cancellation and
// rescheduling URLs are deliberately not matched.
const LEGACY_RULES = [
  {
    callType: "agent",
    pattern: /(?:https?:\/\/)?(?:www\.)?paraform\.com\/cal\/raydar\/15min\/?(?=$|[\s<>'")\],.;:])/gi,
    replacement: AGENT_SCHEDULING_URL,
  },
  {
    callType: "human",
    // Live Paraform content uses `raydar-xyz`; the legacy URL supplied in the
    // cutover brief uses `raydar.xyz`. Both are the same Human Call intent.
    pattern: /(?:https?:\/\/)?(?:www\.)?calendly\.com\/raydar[-.]xyz\/?(?=$|[\s<>'")\],.;:])/gi,
    replacement: HUMAN_SCHEDULING_URL,
  },
  {
    callType: "human",
    pattern: /(?:https?:\/\/)?(?:www\.)?calendly\.com\/noah-raydar\/new-role-chat\/?(?:\?back=1)?(?=$|[\s<>'")\],.;:])/gi,
    replacement: HUMAN_SCHEDULING_URL,
  },
];

const ANY_LEGACY_CALENDAR_URL =
  /(?:https?:\/\/)?(?:www\.)?(?:paraform\.com\/cal\/[^\s<>'"]+|calendly\.com\/[^\s<>'"]+)/gi;

const CALLOUT_COPY_RULES = [
  {
    pattern: /if opposed to the agent chat please grab a time with me directly/gi,
    replacement: "if you prefer a phone call, use Raydar's Human Call option:",
  },
  {
    pattern: /if you don't want to chat with the agent,\s*grab a time with me directly/gi,
    replacement: "If you prefer a phone call, use Raydar's Human Call option:",
  },
  {
    pattern: /Interested\?(?:\s|&nbsp;)+Grab(?:\s|&nbsp;)+a(?:\s|&nbsp;)+time(?:\s|&nbsp;)+here:(?:\s|&nbsp;)*/gi,
    replacement: "Interested? Book a Human Call with Raydar here: ",
  },
];

function canonicalizeNativeAnchorLabel(value, callType) {
  const url = callType === "agent" ? AGENT_SCHEDULING_URL : HUMAN_SCHEDULING_URL;
  const label = callType === "agent"
    ? "Book an Agent Call with Raydar"
    : "Book a Human Call with Raydar";
  const escapedUrl = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(<a\\b[^>]*\\bhref\\s*=\\s*)(["'])${escapedUrl}\\2([^>]*)>[\\s\\S]*?<\\/a>`,
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

export function rewriteLegacySchedulingLinks(value) {
  let output = String(value ?? "");
  const replacements = { agent: 0, human: 0 };
  const copyNormalizations = { callouts: 0, agentLabels: 0, humanLabels: 0 };
  for (const rule of LEGACY_RULES) {
    output = output.replace(rule.pattern, () => {
      replacements[rule.callType]++;
      return rule.replacement;
    });
  }
  for (const rule of CALLOUT_COPY_RULES) {
    output = output.replace(rule.pattern, () => {
      copyNormalizations.callouts++;
      return rule.replacement;
    });
  }
  const agentAnchors = canonicalizeNativeAnchorLabel(output, "agent");
  output = agentAnchors.value;
  copyNormalizations.agentLabels = agentAnchors.count;
  const humanAnchors = canonicalizeNativeAnchorLabel(output, "human");
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
      known.push({ callType: rule.callType, value: match[0] });
    }
  }
  const knownValues = new Set(known.map((item) => item.value.toLowerCase()));
  const unknown = [...source.matchAll(ANY_LEGACY_CALENDAR_URL)]
    .map((match) => match[0])
    .filter((url) => !knownValues.has(url.toLowerCase()));
  return { known, unknown: [...new Set(unknown)] };
}
