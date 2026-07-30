// Dashboard verification pin for retained Human Intro Calendar receipts.
//
// The secret is supplied only through the deployment environment. Its public
// key ID and domain-separated commitment are code-owned, so an environment
// change alone cannot substitute another receipt producer.

import {
  createHash,
  timingSafeEqual,
} from "node:crypto";

export const HUMAN_INTRO_CALENDAR_RECEIPT_KEY_ENV =
  "PARAAI_HUMAN_INTRO_CALENDAR_RECEIPT_KEY";
export const HUMAN_INTRO_CALENDAR_RECEIPT_APPROVED_KEY_ID =
  "human-intro-calendar-2026-07-v1";
export const HUMAN_INTRO_CALENDAR_RECEIPT_APPROVED_KEY_COMMITMENT =
  "035621c0b7f655c314ca7501c0bcf68a4587c2808c23b3816448512439e947c2";

const KEY = /^[A-Za-z0-9_-]{43}$/u;
const KEY_ID = /^[a-z0-9][a-z0-9._:-]{0,79}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;

export class HumanIntroCalendarReceiptKeyError extends Error {
  constructor(code) {
    super(code);
    this.name = "HumanIntroCalendarReceiptKeyError";
    this.code = code;
  }
}

function fail(code) {
  throw new HumanIntroCalendarReceiptKeyError(code);
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

export function humanIntroCalendarReceiptKeyCommitment(key) {
  if (typeof key !== "string" || !KEY.test(key)) {
    fail("HUMAN_INTRO_CALENDAR_RECEIPT_KEY_INVALID");
  }
  let decoded;
  try {
    decoded = Buffer.from(key, "base64url");
  } catch {
    fail("HUMAN_INTRO_CALENDAR_RECEIPT_KEY_INVALID");
  }
  if (
    decoded.length !== 32
    || decoded.toString("base64url") !== key
  ) {
    fail("HUMAN_INTRO_CALENDAR_RECEIPT_KEY_INVALID");
  }
  return createHash("sha256")
    .update("phase4-human-intro-calendar-verification-key-v1")
    .update("\0")
    .update(JSON.stringify(key))
    .digest("hex");
}

export function verifyHumanIntroCalendarReceiptKey({
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
    fail("HUMAN_INTRO_CALENDAR_RECEIPT_KEY_PIN_INVALID");
  }
  const commitment =
    humanIntroCalendarReceiptKeyCommitment(key);
  if (!sameDigest(commitment, approvedKeyCommitment)) {
    fail("HUMAN_INTRO_CALENDAR_RECEIPT_KEY_COMMITMENT_MISMATCH");
  }
  return Object.freeze({
    key,
    keyId: approvedKeyId,
    keyCommitment: commitment,
  });
}

export function loadApprovedHumanIntroCalendarReceiptKey(
  env = process.env,
) {
  return verifyHumanIntroCalendarReceiptKey({
    key: env?.[HUMAN_INTRO_CALENDAR_RECEIPT_KEY_ENV],
    approvedKeyId:
      HUMAN_INTRO_CALENDAR_RECEIPT_APPROVED_KEY_ID,
    approvedKeyCommitment:
      HUMAN_INTRO_CALENDAR_RECEIPT_APPROVED_KEY_COMMITMENT,
  });
}

export function humanIntroCalendarReceiptKeyConfigured(
  env = process.env,
) {
  try {
    loadApprovedHumanIntroCalendarReceiptKey(env);
    return true;
  } catch {
    return false;
  }
}
