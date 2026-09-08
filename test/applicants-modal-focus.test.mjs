import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const page = await readFile(new URL("../applicants.html", import.meta.url), "utf8");
const start = page.indexOf("function restoreProfileFocus");
const end = page.indexOf("function closeProfile", start);
assert.ok(start >= 0 && end > start, "profile-focus helper is extractable from the shipped page");

function harness({ links = [], view = "review" } = {}) {
  const calls = [];
  const pill = { focus: (options) => calls.push(["pill", options]) };
  const nodes = links.map(({ key, visible = true, name = key }) => ({
    dataset: { open: key },
    getClientRects: () => visible ? [{}] : [],
    focus: (options) => calls.push([name, options]),
  }));
  const context = {
    STATE: { view },
    requestAnimationFrame: (fn) => fn(),
    document: { querySelectorAll: (selector) => selector === "[data-open]" ? nodes : [] },
    $: (id) => id === "pillReview" ? pill : null,
  };
  const { restoreProfileFocus } = runInNewContext(`${page.slice(start, end)}; ({ restoreProfileFocus })`, context);
  return { calls, restoreProfileFocus };
}

test("profile close restores focus to the current visible link for its exact application key", () => {
  const h = harness({ links: [
    { key: "other-application", name: "other" },
    { key: "application-42", visible: false, name: "stale" },
    { key: "application-42", name: "current" },
  ] });
  h.restoreProfileFocus("application-42");
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][0], "current");
  assert.equal(h.calls[0][1].preventScroll, true);
});

test("profile close falls back to the active view control when its virtualized opener is absent", () => {
  const h = harness({ links: [], view: "review" });
  h.restoreProfileFocus(null);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][0], "pill");
  assert.equal(h.calls[0][1].preventScroll, true);
});

test("the modal stores only the opener key and restores focus after close", () => {
  assert.match(page, /returnFocusKey: restoreFocus \? key : null/);
  assert.match(page, /const returnFocusKey = STATE\.modal\?\.returnFocusKey \|\| null/);
  assert.match(page, /restoreProfileFocus\(returnFocusKey\)/);
  assert.match(page, /openProfile\(open\.dataset\.open, \{ restoreFocus: true \}\)/);
});
