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

test("Call Type stays explicit and editable instead of defaulting unknown rows to Agent", () => {
  assert.match(dashboard, /<option value="unknown">Unknown<\/option>/);
  assert.match(dashboard, /const CD_TYPES\s*= \["Agent","Human"\]/);
  assert.match(dashboard, /cdSelect\(i,"source",CD_SOURCES,r\.source,"Unknown"\)/);
  assert.match(dashboard, /cdSelect\(i,"callType",CD_TYPES,r\.callType,"Unknown"\)/);
  assert.match(dashboard, /return t==="human" \? "human" : t==="agent" \? "agent" : "unknown"/);
  assert.match(dashboard, /row\.sourceEvidence!=="manual"/);
  assert.doesNotMatch(dashboard, /cdAutoSource/);
  assert.doesNotMatch(dashboard, /typePill/);
});
