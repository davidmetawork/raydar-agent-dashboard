import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const dashboard = await readFile(new URL("../index.html", import.meta.url), "utf8");

function shortcutRenderer() {
  const start = dashboard.indexOf("    const esc =");
  const end = dashboard.indexOf("    /* END:PARAFORM-DISPLAY-IDENTITY */", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const context = vm.createContext({ String, encodeURIComponent });
  vm.runInContext(
    `${dashboard.slice(start, end)}\nglobalThis.renderShortcuts = personShortcuts;`,
    context,
  );
  return context.renderShortcuts;
}

test("Recent interviews render LinkedIn and Raydar shortcuts from the exact bot id", () => {
  assert.match(dashboard, /const CALL_BOT_ID = \/\^\[A-Za-z0-9_-\]\{5,128\}\$\//u);
  assert.match(dashboard, /const personShortcuts = \(row\) => \{/u);
  assert.match(dashboard, /if \(!CALL_BOT_ID\.test\(botId\)\) return "";/u);
  assert.match(dashboard, /api\/linkedin\?bot=\$\{encodedBotId\}/u);
  assert.match(dashboard, /href="\/c\/\$\{encodedBotId\}"/u);
  assert.match(
    dashboard,
    /<span class="person-cell">\$\{nameLink\(displayName\(c\)\)\}\$\{personShortcuts\(c\)\}/u,
  );
});

test("Profile shortcuts are branded, accessible, and open without replacing Monitor", () => {
  assert.match(dashboard, /\.person-shortcuts \{ display:inline-flex; align-items:center; gap:4px;/u);
  assert.match(dashboard, /width:17px; height:17px; display:inline-grid; place-items:center;/u);
  assert.match(dashboard, /border:0; border-radius:4px; background:transparent; padding:0;/u);
  assert.match(dashboard, /\.person-shortcut svg \{ display:block; width:15px; height:15px; \}/u);
  assert.match(dashboard, /<path fill="#0A66C2" d="M20\.447/u);
  assert.match(dashboard, /<svg viewBox="1145\.967 795\.987 149\.896 149\.273" aria-hidden="true">/u);
  assert.match(dashboard, /<path fill="currentColor" d="M1273\.44/u);
  assert.match(dashboard, /class="person-shortcut linkedin" data-shortcut="linkedin"/u);
  assert.match(dashboard, /class="person-shortcut raydar" data-shortcut="raydar"/u);
  assert.match(dashboard, /role="group" aria-label="Links for \$\{escAttr\(name\)\}"/u);
  assert.match(dashboard, /aria-label="Open \$\{escAttr\(name\)\} on LinkedIn"/u);
  assert.match(dashboard, /aria-label="Open \$\{escAttr\(name\)\}’s Raydar call"/u);
  assert.equal((dashboard.match(/target="_blank" rel="noopener noreferrer"/gu) || []).length >= 2, true);
  assert.match(dashboard, /@media \(prefers-reduced-motion:reduce\)/u);
});

test("Profile shortcuts do not repeat name search or add render-time profile fetches", () => {
  const helper = dashboard.match(/const personShortcuts = \(row\) => \{([\s\S]*?)\n    \};/u)?.[1] || "";
  assert.doesNotMatch(helper, /paraformQ|fetch\(|\/api\/lookup|candidate_first_name/u);
  assert.match(helper, /row\?\.botId/u);
});

test("Profile shortcut rendering is exact-id-only and escapes accessible labels", () => {
  const render = shortcutRenderer();
  const first = render({
    id: "vapi_wrong_99999",
    botId: "recall_exact_12345",
    candidate: "Same Name",
    paraformName: `Zoë "Ace" O'Neil & <Lead>`,
  });
  const second = render({ botId: "recall_exact_67890", candidate: "Same Name" });

  assert.equal((first.match(/<a /gu) || []).length, 2);
  assert.match(first, /api\/linkedin\?bot=recall_exact_12345/u);
  assert.match(first, /href="\/c\/recall_exact_12345"/u);
  assert.doesNotMatch(first, /vapi_wrong_99999/u);
  assert.match(first, /Zoë &quot;Ace&quot; O&#39;Neil &amp; &lt;Lead&gt;/u);
  assert.doesNotMatch(first, /<Lead>|javascript:/u);
  assert.match(second, /recall_exact_67890/u);
  assert.notEqual(first, second);
  assert.equal(render({ candidate: "No bot" }), "");
  assert.equal(render({ botId: `bad\"><script>`, candidate: "Unsafe" }), "");
});
