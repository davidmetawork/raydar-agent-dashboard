import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { issueReviewAssertion } from '../api/_lib/review-assertion.mjs';

test('Review assertion binds actor, method, path, version and exact body', () => {
  const assertion = issueReviewAssertion({ actorEmail: 'David@Raydar.xyz', method: 'POST', path: '/api/v2/reviews/r1/actions', caseId: 'r1', version: 7, rawBody: '{"action":"resume"}', now: 1_700_000_000_000, jti: 'fixed' }, 'shared-secret');
  const [encoded, signature] = assertion.split('.');
  assert.equal(signature, createHmac('sha256', 'shared-secret').update(encoded).digest('base64url'));
  const body = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  assert.equal(body.actor, 'david@raydar.xyz');
  assert.equal(body.method, 'POST');
  assert.equal(body.path, '/api/v2/reviews/r1/actions');
  assert.equal(body.caseId, 'r1');
  assert.equal(body.version, 7);
});
