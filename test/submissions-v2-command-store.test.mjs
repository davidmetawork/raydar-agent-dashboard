import test from "node:test";
import assert from "node:assert/strict";
import { requestDigest } from "../api/submissions-v2/_lib/command-store.mjs";

test("command request digest is stable across object key order", () => {
  assert.equal(requestDigest("add", { b: 2, a: { y: 2, x: 1 } }), requestDigest("add", { a: { x: 1, y: 2 }, b: 2 }));
  assert.notEqual(requestDigest("add", { a: 1 }), requestDigest("add", { a: 2 }));
});
