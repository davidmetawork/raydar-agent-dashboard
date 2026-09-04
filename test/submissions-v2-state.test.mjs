import assert from "node:assert/strict";
import test from "node:test";

import { isVisiblePair } from "../api/submissions-v2/_lib/state.mjs";

const pair = (workflow_state, intent_state) => ({
  workflow_state,
  intent_state,
  submission_status: "none",
});

test("positive intent is visible while its resume is still preparing", () => {
  assert.equal(isVisiblePair(pair("preparing_resume", "interested")), true);
  assert.equal(isVisiblePair(pair("classifying", "unknown")), false);
});
