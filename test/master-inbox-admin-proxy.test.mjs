import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../api/master-inbox/admin.mjs", import.meta.url), "utf8");

test("Master Inbox admin proxy is authenticated and exposes only frozen operator resources", () => {
  assert.match(source, /requireMasterInboxAuth/);
  assert.match(source, /mailbox:\s*\{\s*path:\s*"\/api\/admin\/mailbox"/);
  assert.match(source, /backfill:\s*\{\s*path:\s*"\/api\/admin\/backfill"/);
  assert.match(source, /operations:\s*\{\s*path:\s*"\/api\/admin\/operations"/);
  assert.doesNotMatch(source, /worker\/tick|release-sends|retention/);
});
