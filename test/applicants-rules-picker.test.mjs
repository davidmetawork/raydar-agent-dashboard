// The school/company picker in the rules editor. Directories run to thousands
// of entries, so the checkbox list is a WINDOW over them — and a window is
// only usable if the filter searches the whole directory. Until 2026-08-25 the
// filter hid already-drawn rows instead, which left everything past the cap
// unreachable: alphabetically that meant UC Berkeley, Yale and Stanford could
// not be picked at all. These run the shipped builder rather than matching its
// source, because the bug lived in behaviour that source-shape assertions
// cannot see.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../applicants-rules.js", import.meta.url), "utf8");

function between(text, start, end) {
  const from = text.indexOf(start);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  const to = text.indexOf(end, from);
  assert.notEqual(to, -1, `missing end marker: ${end}`);
  return text.slice(from, to + end.length);
}

// The shipped builder, lifted whole so this harness cannot drift from it.
const context = vm.createContext({ String, Object, Array, Number, JSON, console });
vm.runInContext(
  'const enc = (s) => String(s ?? "").replace(/[&<>"\']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", \'"\': "&quot;", "\'": "&#39;" }[c]));\n'
  + between(source, "const PICK_WINDOW =", "\n")
  + between(source, "function pickListHtml(", "\n  }\n"),
  context,
);
const PICK_WINDOW = vm.runInContext("PICK_WINDOW", context);
const build = (options, chosen, needle) => {
  context.__opts = options; context.__chosen = chosen; context.__needle = needle;
  return vm.runInContext("pickListHtml(__opts, __chosen, 0, __needle)", context);
};
const checked = (html) => [...html.matchAll(/value="([^"]+)"/g)].map((m) => m[1]);

// A directory shaped like the live one: far more entries than the window, with
// the schools people actually ask for sorted past the cut.
const directory = [];
for (let i = 0; i < 1_200; i += 1) directory.push([`id-${i}`, `Andhra Institute ${String(i).padStart(4, "0")}`]);
directory.push(["berk", "University of California, Berkeley"]);
directory.push(["yale", "Yale University"]);
directory.sort((a, b) => String(a[1]).localeCompare(String(b[1])));

test("the first render draws only the window, and says how much it is hiding", () => {
  const html = build(directory, [], "");
  assert.equal(checked(html).length, PICK_WINDOW);
  assert.match(html, new RegExp(`${directory.length - PICK_WINDOW} more`));
  assert.ok(!checked(html).includes("yale"), "the fixture puts Yale past the window");
});

test("a filter term reaches an entry the window never drew", () => {
  assert.deepEqual(checked(build(directory, [], "yale")), ["yale"]);
  assert.deepEqual(checked(build(directory, [], "berkeley")), ["berk"]);
  // Case and stray spacing are how people actually type into a filter box.
  assert.deepEqual(checked(build(directory, [], "  YALE ")), ["yale"]);
});

test("a chosen entry survives any filter term, so an edit cannot hide its own selection", () => {
  const html = build(directory, ["yale"], "berkeley");
  assert.deepEqual(checked(html).sort(), ["berk", "yale"]);
  assert.match(html, /value="yale" checked/);
});

test("a term that matches nothing says so instead of rendering an empty box", () => {
  const html = build(directory, [], "wharton");
  assert.deepEqual(checked(html), []);
  assert.match(html, /Nothing here matches that/);
});

test("labels are escaped, because directory names come from Paraform", () => {
  const html = build([["x", 'Ampersand & "Quote" <School>']], [], "");
  assert.match(html, /Ampersand &amp; &quot;Quote&quot; &lt;School&gt;/);
  assert.ok(!html.includes("<School>"));
});

test("the filter re-renders the list and rebinds it, rather than hiding rows", () => {
  // The two halves of the fix that live in the DOM wiring: any return to
  // label.style.display would silently restore the unreachable directory.
  assert.match(source, /list\.innerHTML = pickListHtml\(pickOptions\[index\] \|\| \[\], chosen, index, e\.target\.value\)/);
  assert.match(source, /bindPicks\(list, condition\)/);
  assert.ok(!/\.multi label.*style\.display/s.test(source.slice(source.indexOf('part === "filter"'), source.indexOf('part === "from"'))),
    "the filter no longer hides drawn rows");
});
