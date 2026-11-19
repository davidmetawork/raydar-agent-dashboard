import { createHash } from "node:crypto";

const ACCOUNT_RECORDS = [
  { key: "david", displayName: "David Phillips", userId: "clskvclu80066l60fhutn6kks" },
  { key: "kyra", displayName: "Kyra Wyman", userId: "cmcxp87p900gcl804d503p9qj" },
  { key: "noah", displayName: "Noah Kingsdale", userId: "clzhgrt4i0016jj0c78dmtn6r" },
  { key: "alzen", displayName: "Alzen Flores", userId: "cm3c5y4dr001jmk0cr6ko45ti" },
  { key: "vanessa", displayName: "Vanessa Vallador", userId: "cm1p6u5h10000l60c5u6wo13q" },
];

export const PARAFORM_ACCOUNTS = Object.freeze(Object.fromEntries(
  ACCOUNT_RECORDS.map((account) => [account.key, Object.freeze({ ...account })]),
));

const ACCOUNT_ALIASES = new Map([
  ["kira", "kyra"],
]);

function invalidAccount() {
  const error = new Error("PARAFORM_ACCOUNT_INVALID");
  error.code = "PARAFORM_ACCOUNT_INVALID";
  return error;
}

export function normalizeParaformAccountKey(value) {
  const requested = String(value ?? "").trim().toLowerCase();
  const key = ACCOUNT_ALIASES.get(requested) ?? requested;
  if (!Object.hasOwn(PARAFORM_ACCOUNTS, key)) throw invalidAccount();
  return key;
}

export function paraformAccount(value) {
  return PARAFORM_ACCOUNTS[normalizeParaformAccountKey(value)];
}

export function paraformAccountSessionNamespace(value) {
  // n8n variable keys cap out below the readable private-env names once a
  // 13-digit generation and `_PARTS` suffix are appended. Keep the durable
  // store namespace compact; env keys remain explicit below.
  return `PARAFORM_${normalizeParaformAccountKey(value).toUpperCase()}_SESSION`;
}

export function paraformAccountEnvKeys(value) {
  const namespace = `PARAFORM_ACCOUNT_${normalizeParaformAccountKey(value).toUpperCase()}_SESSION_COOKIE`;
  return Object.freeze({
    cookie: namespace,
    cookieName: `${namespace}_NAME`,
    userId: `${namespace}_USER_ID`,
  });
}

export function parseParaformAccountPool(value) {
  const requested = Array.isArray(value)
    ? value
    : String(value ?? "").split(",");
  const keys = requested
    .map((entry) => String(entry ?? "").trim())
    .filter(Boolean)
    .map(normalizeParaformAccountKey);
  if (keys.length === 0) {
    const error = new Error("PARAFORM_ACCOUNT_POOL_EMPTY");
    error.code = "PARAFORM_ACCOUNT_POOL_EMPTY";
    throw error;
  }
  if (new Set(keys).size !== keys.length) {
    const error = new Error("PARAFORM_ACCOUNT_POOL_DUPLICATE");
    error.code = "PARAFORM_ACCOUNT_POOL_DUPLICATE";
    throw error;
  }
  return Object.freeze(keys);
}

function rendezvousScore(workKey, accountKey) {
  return createHash("sha256")
    .update(String(workKey))
    .update("\0")
    .update(accountKey)
    .digest()
    .readBigUInt64BE(0);
}

/**
 * Select one stable owner for a work item. This is intentionally not request
 * round-robin: mutations and retries for the same work key remain on one
 * account, and adding/removing an account remaps only the keys it wins/owned.
 */
export function selectParaformAccountForWork(workKey, accountPool) {
  const key = String(workKey ?? "").trim();
  if (!key) {
    const error = new Error("PARAFORM_WORK_KEY_REQUIRED");
    error.code = "PARAFORM_WORK_KEY_REQUIRED";
    throw error;
  }
  const accounts = parseParaformAccountPool(accountPool);
  let selected = accounts[0];
  let selectedScore = rendezvousScore(key, selected);
  for (const account of accounts.slice(1)) {
    const score = rendezvousScore(key, account);
    if (score > selectedScore || (score === selectedScore && account < selected)) {
      selected = account;
      selectedScore = score;
    }
  }
  return selected;
}
