// Dashboard verification pin for retained Human Intro outcome receipts.
//
// The outcome signer is deliberately independent from the Calendar producer.
// The secret is deployment-only while this code owns the approved key ID and
// domain-separated public commitment.

import {
  createHash,
  timingSafeEqual,
} from "node:crypto";

export const HUMAN_INTRO_OUTCOME_RECEIPT_KEY_ENV =
  "PARAAI_HUMAN_INTRO_OUTCOME_RECEIPT_KEY";
export const HUMAN_INTRO_OUTCOME_RECEIPT_APPROVED_KEY_ID =
  "human-intro-outcome-2026-07-v1";
export const HUMAN_INTRO_OUTCOME_RECEIPT_APPROVED_KEY_COMMITMENT =
  "5fa149a97bd22518d9d71312dd818924640d814c664ad92fa09640af2458dc57";

const KEY = /^[A-Za-z0-9_-]{43}$/u;
const KEY_ID = /^[a-z0-9][a-z0-9._:-]{0,79}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;

export class HumanIntroOutcomeReceiptKeyError extends Error {
  constructor(code) {
    super(code);
    this.name = "HumanIntroOutcomeReceiptKeyError";
    this.code = code;
  }
}

function fail(code) {
  throw new HumanIntroOutcomeReceiptKeyError(code);
}

function sameDigest(left, right) {
  if (!DIGEST.test(left) || !DIGEST.test(right)) return false;
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return (
    leftBytes.length === rightBytes.length
    && timingSafeEqual(leftBytes, rightBytes)
  );
}

export function humanIntroOutcomeReceiptKeyCommitment(key) {
  if (typeof key !== "string" || !KEY.test(key)) {
    fail("HUMAN_INTRO_OUTCOME_RECEIPT_KEY_INVALID");
  }
  let decoded;
  try {
    decoded = Buffer.from(key, "base64url");
  } catch {
    fail("HUMAN_INTRO_OUTCOME_RECEIPT_KEY_INVALID");
  }
  if (
    decoded.length !== 32
    || decoded.toString("base64url") !== key
  ) {
    fail("HUMAN_INTRO_OUTCOME_RECEIPT_KEY_INVALID");
  }
  return createHash("sha256")
    .update("phase4-human-intro-outcome-verification-key-v1")
    .update("\0")
    .update(JSON.stringify(key))
    .digest("hex");
}

export function verifyHumanIntroOutcomeReceiptKey({
  key,
  approvedKeyId,
  approvedKeyCommitment,
} = {}) {
  if (
    typeof approvedKeyId !== "string"
    || !KEY_ID.test(approvedKeyId)
    || typeof approvedKeyCommitment !== "string"
    || !DIGEST.test(approvedKeyCommitment)
  ) {
    fail("HUMAN_INTRO_OUTCOME_RECEIPT_KEY_PIN_INVALID");
  }
  const commitment =
    humanIntroOutcomeReceiptKeyCommitment(key);
  if (!sameDigest(commitment, approvedKeyCommitment)) {
    fail("HUMAN_INTRO_OUTCOME_RECEIPT_KEY_COMMITMENT_MISMATCH");
  }
  return Object.freeze({
    key,
    keyId: approvedKeyId,
    keyCommitment: commitment,
  });
}

export function loadApprovedHumanIntroOutcomeReceiptKey(
  env = process.env,
) {
  return verifyHumanIntroOutcomeReceiptKey({
    key: env?.[HUMAN_INTRO_OUTCOME_RECEIPT_KEY_ENV],
    approvedKeyId:
      HUMAN_INTRO_OUTCOME_RECEIPT_APPROVED_KEY_ID,
    approvedKeyCommitment:
      HUMAN_INTRO_OUTCOME_RECEIPT_APPROVED_KEY_COMMITMENT,
  });
}

export function humanIntroOutcomeReceiptKeyConfigured(
  env = process.env,
) {
  try {
    loadApprovedHumanIntroOutcomeReceiptKey(env);
    return true;
  } catch {
    return false;
  }
}
