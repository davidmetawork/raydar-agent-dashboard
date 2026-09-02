import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const vercel = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
const rulesTick = await readFile(new URL("../api/applicants/rules-tick.mjs", import.meta.url), "utf8");
const rulesUi = await readFile(new URL("../applicants-rules.js", import.meta.url), "utf8");

test("Applicants rules have no scheduled trigger", () => {
  assert.equal(vercel.crons.some(({ path }) => path === "/api/applicants/rules-tick"), false);
  assert.doesNotMatch(rulesTick, /cronAuth|APPHUB_SYNC_KEY/);
  assert.match(rulesTick, /req\.method !== "POST"/);
  assert.match(rulesTick, /authHandler = requireAuth/);
});

test("the Rules view owns the only browser execution control", () => {
  assert.match(rulesUi, /Run rules now/);
  assert.match(rulesUi, /fetch\("\/api\/applicants\/rules-tick"/);
  assert.match(rulesUi, /method: "POST"/);
  assert.match(rulesUi, /Rules run only when you press this button/);
});
