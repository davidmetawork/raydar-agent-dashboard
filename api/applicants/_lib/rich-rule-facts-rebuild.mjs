// Derived-cache preparation only: no provider calls or candidate decisions.
import { getJson, hashGetMany, hashSetJson, K } from "./kv.mjs";
import { readActivePublication, readPublishedArtifacts, verifyGeneration } from "./generation.mjs";
import { directoryFromFacts } from "./facts.mjs";
import { richBindingsForSnapshot, richProfileMatches } from "./rich-profile.mjs";
import { richReceiptMatches, richRuleFactsFromProfile, richRuleFactsMatch } from "./rich-rule-facts.mjs";
import { richProfileReceiptsFor, richRuleFactsFor } from "./rule-store.mjs";

const reply = (status, body) => ({ status, body });

export async function prepareRichRuleFacts(body, {
  readJson = getJson,
  readActive = () => readActivePublication({ readJson }),
  readArtifacts = (pointer) => readPublishedArtifacts(pointer, { readJson }),
  readMany = hashGetMany, writeHash = hashSetJson,
  now = () => new Date().toISOString(),
} = {}) {
  const publication = await readActive();
  if (!publication) return reply(503, { ok: false, error: "generation_unavailable" });
  if (String(body.generationId || "") !== publication.generationId
    || String(body.generationDigest || "") !== publication.digest) {
    return reply(409, { ok: false, error: "generation_changed_refresh_required",
      generationId: publication.generationId, generationDigest: publication.digest });
  }
  const artifacts = await readArtifacts(publication);
  if (!artifacts || !verifyGeneration(artifacts).ok) {
    return reply(503, { ok: false, error: "generation_unavailable" });
  }
  const cursor = Number(body.cursor ?? 0);
  const batchSize = Number(body.batchSize ?? 25);
  if (!Number.isSafeInteger(cursor) || cursor < 0
    || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 50) {
    return reply(400, { ok: false, error: "invalid_prepare_profile_facts_page" });
  }
  const snapshot = { ...artifacts.snapshot, queue: artifacts.queue.rows };
  const bindings = richBindingsForSnapshot(snapshot);
  const keys = [...new Set((artifacts.queue?.rows || [])
    .map((row) => row?.profileKey || row?.cuId).filter((key) => bindings.has(key)))].sort();
  const page = keys.slice(cursor, cursor + batchSize);
  const [receipts, storedFacts] = await Promise.all([
    richProfileReceiptsFor(page, { readMany }),
    richRuleFactsFor(page, { readMany }),
  ]);
  const preparedAt = Date.parse(now());
  const projected = {};
  const schools = {};
  const companies = {};
  const unavailable = [];
  const errors = [];
  let alreadyReady = 0;
  const prepareOne = async (key) => {
    const binding = bindings.get(key);
    const receipt = receipts[key];
    if (!richReceiptMatches(binding, receipt, { now: preparedAt })) {
      unavailable.push({ key, reason: "rich_profile_receipt_unavailable" });
      return;
    }
    if (richRuleFactsMatch({ binding, facts: storedFacts[key], receipt, now: preparedAt })) {
      alreadyReady += 1;
      return;
    }
    try {
      const profile = await readJson(K.richProfile(key));
      if (!richProfileMatches(binding, profile, { now: preparedAt })
        || profile.profileEnrichedAt !== receipt.profileEnrichedAt
        || profile.richProfileRetainedUntil !== receipt.richProfileRetainedUntil) {
        unavailable.push({ key, reason: "rich_profile_cache_unavailable" });
        return;
      }
      const factsRow = richRuleFactsFromProfile(profile, {
        now: preparedAt, receiptVersion: Number(receipt.v) || 0,
      });
      if (!factsRow) {
        unavailable.push({ key, reason: "rich_profile_cache_invalid" });
        return;
      }
      projected[key] = factsRow;
    } catch (error) {
      errors.push({ key, reason: String(error?.message || error).slice(0, 120) });
    }
  };
  for (let offset = 0; offset < page.length; offset += 5) {
    await Promise.all(page.slice(offset, offset + 5).map(prepareOne));
  }
  const freshReceipts = await richProfileReceiptsFor(Object.keys(projected), { readMany });
  for (const key of Object.keys(projected)) {
    if (!richRuleFactsMatch({ binding: bindings.get(key), facts: projected[key], receipt: freshReceipts[key], now: Date.parse(now()) })) {
      delete projected[key];
      unavailable.push({ key, reason: "rich_profile_receipt_changed" });
    }
  }
  const current = await readActive();
  if (!current || current.generationId !== publication.generationId || current.digest !== publication.digest) {
    return reply(409, { ok: false, error: "generation_changed_refresh_required",
      generationId: current?.generationId || null, generationDigest: current?.digest || null });
  }
  if (Object.keys(projected).length) await writeHash(K.richRuleFacts, projected);
  const [readback, finalReceipts, finalPublication] = await Promise.all([
    richRuleFactsFor(Object.keys(projected), { readMany }),
    richProfileReceiptsFor(Object.keys(projected), { readMany }), readActive(),
  ]);
  if (finalPublication?.generationId !== publication.generationId || finalPublication?.digest !== publication.digest) {
    return reply(409, { ok: false, error: "generation_changed_refresh_required",
      generationId: finalPublication?.generationId || null, generationDigest: finalPublication?.digest || null });
  }
  let verified = 0;
  for (const key of Object.keys(projected)) {
    if (!richRuleFactsMatch({ binding: bindings.get(key), facts: readback[key], receipt: finalReceipts[key], now: Date.parse(now()) })) {
      errors.push({ key, reason: "rich_profile_projection_readback_failed" });
      continue;
    }
    verified += 1;
    const directory = directoryFromFacts(readback[key]);
    Object.assign(schools, directory.schools);
    Object.assign(companies, directory.companies);
  }
  if (Object.keys(schools).length) await writeHash(K.schools, schools);
  if (Object.keys(companies).length) await writeHash(K.companies, companies);
  const nextCursor = cursor + page.length < keys.length ? cursor + page.length : null;
  return reply(200, {
    ok: true, generationId: publication.generationId, generationDigest: publication.digest,
    cursor, nextCursor,
    coverage: { total: keys.length, processed: page.length, projected: Object.keys(projected).length,
      alreadyReady, readbackVerified: verified, unavailable: unavailable.length, errors: errors.length,
      remaining: Math.max(0, keys.length - cursor - page.length), complete: nextCursor == null },
    unavailable, errors,
  });
}
