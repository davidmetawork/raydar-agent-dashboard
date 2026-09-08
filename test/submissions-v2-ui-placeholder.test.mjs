import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import * as ui from "../submissions-v2-ui-state.mjs";

const source = readFileSync(new URL("../submissions-v2.js", import.meta.url), "utf8");

// Execute the production loading and rendering functions. The DOM and request
// stubs keep the regression local while preserving the render-cache lifecycle.
function fixture() {
  const rows = [{ case_id: "candidate-role-one", candidate_name: "Avery" }];
  const state = {
    page: "interested", query: "Avery", rows, totalCount: 1, nextCursor: null,
    generating: new Set(), rowActions: new Set(), pendingDownloads: new Map(),
    listSequence: 0, renderedRowsKey: null, rowsDirty: false,
  };
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, {
      innerHTML: "", hidden: true, attributes: {},
      setAttribute(name, value) { this.attributes[name] = value; },
    });
    return nodes.get(id);
  };
  let requestFailure = false;
  const context = vm.createContext({
    ...ui,
    STATE: state,
    HTMLElement: class {},
    AbortController,
    URLSearchParams,
    $: node,
    rowRenderKey: () => ui.listRenderKey(state),
    request: async () => {
      if (requestFailure) throw new Error("Temporary list failure");
      return { rows: structuredClone(rows), total_count: 1, next_cursor: null };
    },
    isGenerationActive: () => false,
    resumeUiState: () => ({ preparing: false }),
    focusedRowDescendant: () => null,
    restoreFocusedRowDescendant() {},
    rowGroupHtml: (_key, _label, items) => items.map((row) => `<article>${row.candidate_name}</article>`).join(""),
    PAGE_LABELS: { interested: "Interested" },
    EMPTY: { interested: "No candidates" },
    esc: (value) => String(value),
    persistPendingDownloads() {},
    renderHealth() {},
    toast() {},
    bindRows() {},
    reportHeight() {},
    requestAnimationFrame: (callback) => callback(),
  });
  vm.runInContext(source.slice(
    source.indexOf("function replaceRowsPlaceholder("),
    source.indexOf("\nfunction rowGroupHtml("),
  ), context);
  vm.runInContext(source.slice(
    source.indexOf("async function loadRows("),
    source.indexOf("\nfunction updatePageTabs("),
  ), context);
  vm.runInContext("renderRows()", context);
  return {
    state,
    node,
    setFailure(value) { requestFailure = value; },
    load: (options = {}) => {
      context.loadOptions = options;
      return vm.runInContext("loadRows(loadOptions)", context);
    },
  };
}

test("an identical foreground list reload restores rows after its loading placeholder", async () => {
  const view = fixture();
  const initial = view.node("rows").innerHTML;
  assert.match(initial, /<article>Avery<\/article>/u);

  // A trailing space in the search field trims to this same query and causes
  // a foreground request whose rows and render key are unchanged.
  await view.load();
  assert.equal(view.node("rows").innerHTML, initial);
  assert.doesNotMatch(view.node("rows").innerHTML, /Loading submissions/u);
  await view.load({ refresh: true, background: true });
  assert.equal(view.node("rows").innerHTML, initial);
});

test("an identical successful poll recovers from a foreground list error placeholder", async () => {
  const view = fixture();
  const initial = view.node("rows").innerHTML;
  view.setFailure(true);
  await view.load();
  assert.match(view.node("rows").innerHTML, /Submissions are unavailable/u);

  view.setFailure(false);
  await view.load({ refresh: true, background: true });
  assert.equal(view.node("rows").innerHTML, initial);
  assert.equal(view.node("rows").attributes["aria-busy"], "false");
});
