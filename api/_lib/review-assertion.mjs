import { createHash, createHmac, randomUUID } from 'node:crypto';

const b64 = value => Buffer.from(value).toString('base64url');
const bodyHash = value => createHash('sha256').update(String(value || '')).digest('hex');

export function issueReviewAssertion({ actorEmail, method, path, caseId = null, version = null, rawBody = '', now = Date.now(), jti = randomUUID() }, secret) {
  if (!secret) throw new Error('post_call_review_assertion_not_configured');
  const payload = { aud: 'raydar-post-call-review-v1', actor: String(actorEmail || '').trim().toLowerCase(), sessionReviewAccess: true,
    method: String(method).toUpperCase(), path, caseId: caseId || null, version: Number.isSafeInteger(version) ? version : null,
    bodyHash: bodyHash(rawBody), iat: Math.floor(now / 1000), exp: Math.floor((now + 60_000) / 1000), jti };
  const encoded = b64(JSON.stringify(payload));
  return `${encoded}.${createHmac('sha256', secret).update(encoded).digest('base64url')}`;
}
