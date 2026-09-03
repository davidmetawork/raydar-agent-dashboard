import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { issueReviewAssertion } from '../api/_lib/review-assertion.mjs';
import reviewHandler, { canonicalReviewAssertionPath, upstream } from '../api/post-call/review.mjs';

function responseCapture() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return body; },
    end() { this.ended = true; },
  };
}

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

test('Review list filters are not part of the backend assertion route', () => {
  assert.equal(canonicalReviewAssertionPath('/api/v2/reviews?status=open&limit=50'), '/api/v2/reviews');
});

test('Review keeps the signed actor assertion when a separate action credential is used', async () => {
  const keys = [
    'POST_CALL_BASE',
    'POST_CALL_MONITOR_API_KEY',
    'POST_CALL_REVIEW_FEED_API_KEY',
    'POST_CALL_REVIEW_ACTION_API_KEY',
    'POST_CALL_REVIEW_ASSERTION_SECRET',
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  let request;
  try {
    Object.assign(process.env, {
      POST_CALL_BASE: 'https://raydar-post-call.vercel.app',
      POST_CALL_MONITOR_API_KEY: 'legacy-key',
      POST_CALL_REVIEW_FEED_API_KEY: 'feed-key',
      POST_CALL_REVIEW_ACTION_API_KEY: 'action-key',
      POST_CALL_REVIEW_ASSERTION_SECRET: 'shared-secret',
    });
    const fetchImpl = async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    await upstream(
      '/api/v2/reviews/r1/actions?identitySearch=ignored-by-assertion',
      { email: 'David@Raydar.xyz' },
      { caseId: 'r1', version: 7 },
      { method: 'POST', body: '{"action":"resume"}' },
      { fetchImpl, serviceKey: process.env.POST_CALL_REVIEW_ACTION_API_KEY },
    );

    assert.equal(request.url, 'https://raydar-post-call.vercel.app/api/v2/reviews/r1/actions?identitySearch=ignored-by-assertion');
    assert.equal(request.init.headers.authorization, 'Bearer action-key');
    const [encoded] = request.init.headers['x-raydar-review-assertion'].split('.');
    const claim = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    assert.equal(claim.actor, 'david@raydar.xyz');
    assert.equal(claim.method, 'POST');
    assert.equal(claim.path, '/api/v2/reviews/r1/actions');
    assert.equal(claim.caseId, 'r1');
    assert.equal(claim.version, 7);
  } finally {
    for (const key of keys) {
      if (previous[key] == null) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test('Review handler separates feed/action credentials and fails mutations closed', async () => {
  const keys = [
    'GOOGLE_CLIENT_ID',
    'POST_CALL_BASE',
    'POST_CALL_ALLOWED_ORIGINS',
    'POST_CALL_MONITOR_API_KEY',
    'POST_CALL_REVIEW_FEED_API_KEY',
    'POST_CALL_REVIEW_ACTION_API_KEY',
    'POST_CALL_REVIEW_ASSERTION_SECRET',
    'POST_CALL_REVIEW_READ_ONLY',
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  const previousTimeout = AbortSignal.timeout;
  const requests = [];
  const timeouts = [];
  try {
    Object.assign(process.env, {
      GOOGLE_CLIENT_ID: '',
      POST_CALL_BASE: 'https://raydar-post-call.vercel.app',
      POST_CALL_ALLOWED_ORIGINS: 'https://raydar-post-call.vercel.app',
      POST_CALL_MONITOR_API_KEY: 'legacy-key',
      POST_CALL_REVIEW_FEED_API_KEY: 'feed-key',
      POST_CALL_REVIEW_ACTION_API_KEY: 'action-key',
      POST_CALL_REVIEW_ASSERTION_SECRET: 'shared-secret',
      POST_CALL_REVIEW_READ_ONLY: 'false',
    });
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ ok: true, item: { id: 'r1' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    AbortSignal.timeout = (timeoutMs) => {
      timeouts.push(timeoutMs);
      return previousTimeout.call(AbortSignal, timeoutMs);
    };

    const getRes = responseCapture();
    await reviewHandler({ method: 'GET', headers: {}, query: { id: 'r1' }, authedEmail: 'david@raydar.xyz' }, getRes);
    assert.equal(getRes.statusCode, 200);
    assert.equal(requests[0].init.headers.authorization, 'Bearer feed-key');
    assert.match(requests[0].init.headers['x-raydar-review-assertion'], /^[^.]+\.[^.]+$/);

    const postRes = responseCapture();
    await reviewHandler({
      method: 'POST',
      headers: {
        origin: 'https://monitor.raydar.xyz',
        host: 'monitor.raydar.xyz',
        'x-forwarded-proto': 'https',
      },
      query: {},
      authedEmail: 'david@raydar.xyz',
      body: { action: 'resume', reviewId: 'r1', version: 2, reason: 'handler test' },
    }, postRes);
    assert.equal(postRes.statusCode, 200);
    assert.equal(requests[1].init.headers.authorization, 'Bearer action-key');
    assert.equal(requests[1].init.headers['if-match'], '"2"');
    assert.match(requests[1].init.headers['x-raydar-review-assertion'], /^[^.]+\.[^.]+$/);
    assert.deepEqual(timeouts, [12_000, 55_000]);

    process.env.POST_CALL_REVIEW_READ_ONLY = 'true';
    const readOnlyRes = responseCapture();
    await reviewHandler({
      method: 'POST',
      headers: {
        origin: 'https://monitor.raydar.xyz',
        host: 'monitor.raydar.xyz',
        'x-forwarded-proto': 'https',
      },
      query: {},
      authedEmail: 'david@raydar.xyz',
      body: { action: 'resume', reviewId: 'r1', version: 2, reason: 'must not run' },
    }, readOnlyRes);
    assert.equal(readOnlyRes.statusCode, 403);
    assert.equal(readOnlyRes.body.error, 'review_read_only');
    assert.equal(requests.length, 2);

    process.env.POST_CALL_REVIEW_READ_ONLY = 'false';
    const crossOriginRes = responseCapture();
    await reviewHandler({
      method: 'POST',
      headers: { origin: 'https://evil.example', host: 'monitor.raydar.xyz', 'x-forwarded-proto': 'https' },
      query: {},
      authedEmail: 'david@raydar.xyz',
      body: { action: 'resume', reviewId: 'r1', version: 2, reason: 'must not run' },
    }, crossOriginRes);
    assert.equal(crossOriginRes.statusCode, 403);
    assert.equal(crossOriginRes.body.error, 'same_origin_required');
    assert.equal(requests.length, 2);
  } finally {
    globalThis.fetch = previousFetch;
    AbortSignal.timeout = previousTimeout;
    for (const key of keys) {
      if (previous[key] == null) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
