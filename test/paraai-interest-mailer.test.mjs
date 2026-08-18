import test from "node:test";
import assert from "node:assert/strict";
import { gmailMailer } from "../api/paraai/_lib/interest.mjs";

// Regression for the 2026-08-18 mailer fix: gmailMailer used to hand
// deliverMessage a prebuilt MIME blob, and deliverMessage — which builds the
// MIME itself from message fields — produced "From: undefined" mail Gmail
// could not deliver, with no actionKey reconciliation marker. The contract is
// FIELD-FORM: deliver receives the raw fields, never a built blob.
test("gmailMailer hands deliver the field-form message, not a built MIME", async () => {
  let seen = null;
  const mailer = gmailMailer({
    mailbox: "david@raydar.xyz",
    deliver: async (args) => { seen = args; return { delivery: "sent", id: "m1" }; },
  });
  const out = await mailer({
    to: "candidate@example.com",
    subject: "Your roles",
    text: "plain body",
    html: "<p>plain body</p>",
    candidate: { candidateUserId: "cu_1", batchId: "b_9" },
  });

  assert.equal(seen.mailbox, "david@raydar.xyz");
  const m = seen.message;
  assert.equal(m.from, "David Phillips <david@raydar.xyz>");
  assert.equal(m.to, "candidate@example.com");
  assert.equal(m.subject, "Your roles");
  assert.equal(m.bodyText, "plain body");
  assert.equal(m.bodyHtml, "<p>plain body</p>");
  // the reconciliation marker the old code dropped
  assert.equal(m.actionKey, "interest:cu_1:b_9");
  // deterministic Message-ID present and returned
  assert.ok(m.messageId && m.messageId === out.messageId);
  // and never the built-blob shape
  assert.ok(!("raw" in m), "must not pass a prebuilt MIME blob");
  assert.equal(out.delivery, "sent");
});
