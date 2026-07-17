import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dashboard = await readFile(new URL("../index.html", import.meta.url), "utf8");

test("Candidates roster uses a fixed eight-column viewport layout", () => {
  assert.match(dashboard, /#cd-table-wrap \{ overflow-x:hidden; \}/);
  assert.match(dashboard, /#cd-table-wrap \.cd-table \{ table-layout:fixed; \}/);
  assert.match(
    dashboard,
    /<th>Date<\/th><th>Candidate<\/th><th>Source<\/th><th>Call Type<\/th><th>Call Status<\/th><th>Para AI<\/th><th>Outcome<\/th><th>Notes<\/th>/,
  );

  const widths = [...dashboard.matchAll(
    /#cd-table-wrap \.cd-table th:nth-child\(\d+\) \{ width:(\d+)%/g,
  )].map((match) => Number(match[1]));
  assert.deepEqual(widths, [11, 18, 10, 9, 12, 11, 18, 11]);
  assert.equal(widths.reduce((total, width) => total + width, 0), 100);
});

test("Candidates roster becomes labeled cards below 800 pixels", () => {
  assert.match(dashboard, /@media \(max-width:800px\)/);
  assert.match(dashboard, /#cd-table-wrap \.cd-table tr \{\s*display:grid/);
  for (const label of [
    "Date",
    "Candidate",
    "Source",
    "Call Type",
    "Call Status",
    "Para AI",
    "Outcome",
    "Notes",
  ]) {
    assert.match(dashboard, new RegExp(`content:"${label}"`));
  }
});
