import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

function key(env = process.env) {
  const configured = String(env.SUBMISSIONS_V2_ENCRYPTION_KEY || "").trim();
  if (!configured) throw Object.assign(new Error("Private-data encryption is not configured."), { code: "encryption_not_configured", status: 503 });
  const bytes = Buffer.from(configured, configured.includes("-") || configured.includes("_") ? "base64url" : "base64");
  if (bytes.length !== 32) throw Object.assign(new Error("Private-data encryption key is invalid."), { code: "encryption_key_invalid", status: 503 });
  return bytes;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((name) => [name, canonical(value[name])]));
  }
  return value;
}

export function encryptJson(value, { context = "submissions-v2", env = process.env, deterministic = false } = {}) {
  const plaintext = Buffer.from(JSON.stringify(canonical(value)), "utf8");
  const encryptionKey = key(env);
  // Deterministic private-object paths require byte-identical crash replay.
  // A keyed, context-and-plaintext-bound nonce stays unique for different
  // messages while making the same logical write exactly reproducible.
  const nonce = deterministic
    ? createHmac("sha256", encryptionKey)
      .update("submissions-v2:deterministic-aead-nonce:v1\0")
      .update(String(context))
      .update("\0")
      .update(plaintext)
      .digest().subarray(0, 12)
    : randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    context,
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    digest: createHash("sha256").update(ciphertext).digest("hex"),
  };
}

export function decryptJson(envelope, { context = envelope?.context || "submissions-v2", env = process.env } = {}) {
  if (Number(envelope?.version) !== 1 || envelope?.algorithm !== "aes-256-gcm") throw Object.assign(new Error("Private-data envelope is unsupported."), { code: "encrypted_payload_unsupported" });
  const decipher = createDecipheriv("aes-256-gcm", key(env), Buffer.from(envelope.nonce, "base64url"));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64url")), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}
