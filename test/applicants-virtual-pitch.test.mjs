// The virtual list's row pitch.
//
// Every row used to be a fixed 260px box (360px under 820px width). MEASURED
// live on the Review list 2026-09-04, the content wrapper inside it ran 126px
// to 209px tall, so real cards carried 51px to 134px of dead space each, and a
// card taller than the box was cut off with nothing to say so.
//
// The pitch stays UNIFORM — the whole virtualizer is one multiplication
// against it, and per-row heights would mean measuring 4,345 rows to know
// where row 900 begins. What changed is where the number comes from.
//
// These tests run the page's own virtualization source in a VM against a
// fake layout, so the arithmetic that positions the window is exercised
// rather than pattern-matched. Whether .rc-main is content-sized is a layout
// fact measured on the live page, not something a fake DOM can prove.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const applicants = await readFile(new URL("../applicants.html", import.meta.url), "utf8");
const blockStart = applicants.indexOf("/** All rows are already local");
const blockEnd = applicants.indexOf("function renderReview()");
assert.ok(blockStart > 0 && blockEnd > blockStart, "the virtualization block is extractable");
const source = applicants.slice(blockStart, blockEnd);

const ROW_CHROME = 30; // 14px padding top and bottom, 1px border top and bottom

/** A fake list element with just enough layout to run the real code.
 *  `viewport` is shared with the VM's `window`, so a test can widen or narrow
 *  the page between paints exactly as a real resize does. */
function fakeList({ viewport, clientHeight = 640 } = {}) {
  const list = {
    _virtual: null,
    _rows: [],
    scrollTop: 0,
    clientHeight,
    classList: { toggle() {} },
    _style: new Map(),
    style: {
      setProperty: (name, value) => list._style.set(name, value),
      removeProperty: (name) => list._style.delete(name),
    },
    addEventListener() {},
    paints: 0,
    spaceHeights: [],
    set innerHTML(html) {
      list.paints += 1;
      const space = /class="virtual-space" style="height:(\d+(?:\.\d+)?)px"/.exec(html);
      list.spaceHeights.push(space ? Number(space[1]) : null);
      const box = list._virtualRowHeight ?? (viewport.innerWidth <= 820 ? 360 : 260);
      list._rows = [...html.matchAll(/<row h=(\d+)>/g)].map(([, h]) => {
        const content = Number(h);
        const row = {
          children: [{ offsetHeight: 48 }, { offsetHeight: content }],
          clientHeight: box,
          scrollHeight: Math.max(box, content + ROW_CHROME),
          marks: [],
        };
        // Bound to the row, not to classList: `this` inside a bare object
        // method is the classList literal, which has no marks array.
        row.classList = { toggle: (name, on) => row.marks.push([name, on]) };
        return row;
      });
    },
    querySelectorAll(selector) {
      return selector === ".virtual-window > .row" ? list._rows : [];
    },
  };
  return list;
}

function run({ rows, innerWidth = 1440, clientHeight = 640 } = {}) {
  const viewport = {
    innerWidth,
    getComputedStyle: () => ({
      paddingTop: "14px", paddingBottom: "14px",
      borderTopWidth: "1px", borderBottomWidth: "1px",
    }),
  };
  const list = fakeList({ viewport, clientHeight });
  const api = runInNewContext(
    `${source}; ({ paintList, renderVirtual, virtualRowHeight })`,
    { window: viewport, requestAnimationFrame: (fn) => fn(), $: () => null },
  );
  const build = (row) => `<row h=${row.h}>`;
  api.paintList(list, rows, build);
  /** Repaint the same list, optionally at a different width or with a
   *  different population — the two things that happen to a live list. */
  const repaint = ({ width, rows: next } = {}) => {
    if (width != null) viewport.innerWidth = width;
    if (next) api.paintList(list, next, build);
    else api.renderVirtual(list);
  };
  return { list, api, viewport, repaint };
}

const uniform = (count, h) => Array.from({ length: count }, () => ({ h }));

test("a page of thin cards shrinks the pitch to what the content needs", () => {
  // 130px of content in a 260px box was 100px of dead space per row.
  const { list, api } = run({ rows: uniform(500, 130) });
  assert.equal(api.virtualRowHeight(list), 160, "130 content + 30 chrome");
  assert.equal(list._style.get("--row-h"), "160px", "the CSS box follows the same number");
});

test("a dense page grows the pitch instead of clipping", () => {
  const { list, api } = run({ rows: uniform(500, 280) });
  assert.equal(api.virtualRowHeight(list), 310);
  assert.equal(list._rows.every((row) => row.scrollHeight <= row.clientHeight), true, "nothing cut off");
});

test("the pitch is the TALLEST painted row, so no card is clipped to suit a thin one", () => {
  const rows = uniform(500, 130);
  rows[3] = { h: 210 };
  const { list, api } = run({ rows });
  assert.equal(api.virtualRowHeight(list), 240);
});

test("the measurement converges: one extra paint, never a loop", () => {
  const { list } = run({ rows: uniform(500, 130) });
  // First paint at the fallback pitch, one repaint at the measured pitch.
  // A third would mean the measurement depends on the box it produced.
  assert.equal(list.paints, 2);
});

test("the pitch is bounded at both ends", () => {
  const tiny = run({ rows: uniform(10, 10) });
  assert.equal(tiny.api.virtualRowHeight(tiny.list), 150, "a floor, so rows stay readable");
  const huge = run({ rows: uniform(10, 4000) });
  assert.equal(huge.api.virtualRowHeight(huge.list), 340,
    "a ceiling, so one runaway row cannot make a 2,000,000px virtual-space");
});

test("a card taller than the ceiling is marked, not silently cut off", () => {
  const { list } = run({ rows: uniform(20, 4000) });
  const marks = list._rows.flatMap((row) => row.marks);
  assert.ok(marks.length > 0, "every painted row is evaluated");
  assert.ok(marks.some(([name, on]) => name === "row-clipped" && on === true));
});

test("the virtual space is exactly rows * pitch, so the scrollbar cannot lie", () => {
  const { list, api } = run({ rows: uniform(500, 130) });
  const pitch = api.virtualRowHeight(list) + 9; // VIRTUAL_GAP
  assert.equal(list.spaceHeights.at(-1), 500 * pitch - 9);
});

test("a mobile viewport keeps its own bounds and fallback", () => {
  const { list, api } = run({ rows: uniform(50, 90), innerWidth: 390, clientHeight: 600 });
  assert.equal(api.virtualRowHeight(list), 200, "the mobile floor, not the desktop one");
});

test("the pitch never shrinks under a reader mid-scroll", () => {
  // Scrolling a tall card out of view must not pull every row up by 80px.
  const { list, api, repaint } = run({ rows: uniform(500, 210) });
  assert.equal(api.virtualRowHeight(list), 240);
  list._virtual.rows = uniform(500, 130);
  repaint();
  assert.equal(api.virtualRowHeight(list), 240, "the tallest seen, not the tallest visible");
});

test("a measurement does not survive the breakpoint it was taken at", () => {
  // The narrow layout stacks .rc-main, so it measures taller and has a taller
  // ceiling (460). Carried onto a desktop whose ceiling is 340, that number
  // would reinstate exactly the dead space this change removes.
  const { list, api, repaint } = run({ rows: uniform(200, 430), innerWidth: 390 });
  assert.equal(api.virtualRowHeight(list), 460, "the narrow ceiling");
  repaint({ width: 1440 });
  assert.ok(api.virtualRowHeight(list) <= 340, `stuck at ${api.virtualRowHeight(list)}`);
});

test("the sticky floor is still bounded by the ceiling", () => {
  const { list, api, repaint } = run({ rows: uniform(200, 4000) });
  assert.equal(api.virtualRowHeight(list), 340);
  repaint({ rows: uniform(200, 5000) });
  assert.equal(api.virtualRowHeight(list), 340, "growth cannot walk past the ceiling");
});

test("only the rows in the window are mounted, whatever the pitch", () => {
  const { list } = run({ rows: uniform(5000, 130) });
  assert.ok(list._rows.length < 40, `mounted ${list._rows.length} of 5000`);
});

// ---------------------------------------------------------------------------
// THE PITCH IS THE MAP FROM scrollTop TO A ROW INDEX (2026-09-04 review).
// A fixed pitch could never move a reader; a measured one can, and silently:
// changing the pitch under a scrolled list re-interprets the SAME scrollTop as
// a different row. At 190 -> 340 the row at index 900 becomes index 513, with
// nothing on screen to say the list jumped.
// ---------------------------------------------------------------------------

test("growing the pitch mid-scroll keeps the reader on the same row", () => {
  // Thin rows everywhere, a band of tall ones around index 900 — so the pitch
  // is measured small at the top and only grows once the reader gets there.
  const rows = uniform(2000, 130);
  for (let i = 890; i < 910; i += 1) rows[i] = { h: 300 };
  const { list, api } = run({ rows });
  assert.equal(api.virtualRowHeight(list), 160, "measured from the thin rows at the top");

  list.scrollTop = 900 * (api.virtualRowHeight(list) + 9);
  api.renderVirtual(list);

  assert.equal(api.virtualRowHeight(list), 330, "the tall band grew the pitch");
  assert.equal(Math.round(list.scrollTop / (api.virtualRowHeight(list) + 9)), 900,
    "still row 900 — not row 435");
});

test("a list still at the top costs no extra paint when the pitch changes", () => {
  // The anchor correction is only for a scrolled list. scrollTop 0 maps to
  // index 0 at every pitch, so the two-paint convergence above is untouched.
  const { list } = run({ rows: uniform(500, 130) });
  assert.equal(list.scrollTop, 0);
  assert.equal(list.paints, 2);
});

test("a shrinking pitch holds the reader's row too", () => {
  // The narrow -> wide resize shrinks the pitch by more than 200px. Without
  // the anchor the reader would be thrown FORWARD instead of back.
  const rows = uniform(2000, 430);
  const { list, api, repaint } = run({ rows, innerWidth: 390 });
  assert.equal(api.virtualRowHeight(list), 460);
  list.scrollTop = 600 * (api.virtualRowHeight(list) + 9);
  repaint({ width: 1440 });
  assert.equal(Math.round(list.scrollTop / (api.virtualRowHeight(list) + 9)), 600);
});
