import assert from "node:assert/strict";
import test from "node:test";

import { buildParaAIStatusIndex } from "../api/roster/_lib/paraai-status.mjs";

test("Paraform connector provenance is exposed only for an unambiguous identity", () => {
  const index = buildParaAIStatusIndex([
    { id: "one", name: "Ada Lovelace", source_info: "CONNECTOR_REFERRAL" },
    { id: "two", name: "Grace Hopper", source_info: "MANUAL" },
  ], { membershipPredicate: () => false });
  const ada = index.statuses.find((status) => status.name === "Ada Lovelace");
  const grace = index.statuses.find((status) => status.name === "Grace Hopper");
  assert.equal(ada.acquisitionSource, "Connector");
  assert.equal(ada.acquisitionSourceEvidence, "paraform_connector");
  assert.equal(grace.acquisitionSource, null);

  const ambiguous = buildParaAIStatusIndex([
    { id: "a", name: "Same Name", source_info: "CONNECTOR_REFERRAL" },
    { id: "b", name: "Same Name", source_info: "MANUAL" },
  ], { membershipPredicate: () => false });
  assert.equal(ambiguous.statuses[0].ambiguous, true);
  assert.equal(ambiguous.statuses[0].acquisitionSource, null);
});
