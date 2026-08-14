import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const applicants = await readFile(new URL("../applicants.html", import.meta.url), "utf8");

test("Passed decisions expose Interview beside Undo", () => {
  assert.match(
    applicants,
    /const interview = decision\.action === "pass" && !ack[\s\S]*?data-act="interview"[\s\S]*?>Interview<\/button>/,
  );
  assert.match(
    applicants,
    /<div class="decided-actions">' \+ interview \+ undo \+ "<\/div>"/,
  );
});

test("the Passed correction reuses the normal interview decision path", () => {
  assert.match(applicants, /const action = act\.dataset\.act;/);
  assert.match(applicants, /await decide\(key, action, row\);/);
  assert.match(applicants, /body: JSON\.stringify\(\{ key, action, name: row\?\.name, roleTitle: row\?\.roleTitle \}\)/);
});
