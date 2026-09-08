import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../api/mailroom/browser.mjs';

function response() {
  return { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; }, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } };
}
const setup = (overrides = {}) => createHandler({ config: () => ({ authRequired: true }), authenticate: async () => true, env: { MAILROOM_API_KEY: 'private-test-key' }, ...overrides });

test('Mailroom browser fails closed without configured auth and never contacts upstream', async () => {
  const res = response();
  await setup({ config: () => ({ authRequired: false }), fetchImpl: () => assert.fail('upstream read') })({ method: 'GET', query: {} }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'auth_not_configured');
  assert.match(res.headers['cache-control'], /no-store/);
});

test('Mailroom browser refuses unauthenticated and mutation requests', async () => {
  for (const method of ['POST', 'DELETE', 'PATCH']) {
    const res = response();
    await setup({ fetchImpl: () => assert.fail('upstream mutation') })({ method }, res);
    assert.equal(res.statusCode, 405);
  }
  const res = response();
  await setup({ authenticate: async (_req, output) => { output.status(401).json({ ok: false }); return false; }, fetchImpl: () => assert.fail('private data read') })({ method: 'GET' }, res);
  assert.equal(res.statusCode, 401);
});

test('Mailroom browser encodes filters and keeps the API key server-side', async () => {
  const res = response();
  let called;
  await setup({ fetchImpl: async (url, options) => {
    called = { url, options };
    return { ok: true, json: async () => ({ ok: true, rows: [], nextCursor: 'next' }) };
  } })({ method: 'GET', query: { q: 'a+b@example.com & role', lane: 'interview-invites', cursor: 'opaque==' } }, res);
  assert.equal(new URL(called.url).searchParams.get('q'), 'a+b@example.com & role');
  assert.equal(new URL(called.url).pathname, '/api/browser');
  assert.equal(called.options.headers.authorization, 'Bearer private-test-key');
  assert.equal(called.options.method, 'GET');
  assert.equal(called.options.redirect, 'error');
  assert.doesNotMatch(JSON.stringify(res.body), /private-test-key/);
  assert.equal(res.body.nextCursor, 'next');
});

test('Mailroom browser rejects duplicate and unsupported filters', async () => {
  for (const query of [{ mode: ['message', 'list'] }, { url: 'https://example.com' }, { q: 'x'.repeat(4097) }]) {
    const res = response();
    await setup({ fetchImpl: () => assert.fail('invalid query upstream') })({ method: 'GET', query }, res);
    assert.equal(res.statusCode, 400);
  }
});

test('Mailroom browser reports upstream failure without exposing private error details', async () => {
  for (const fetchImpl of [async () => { throw new Error('secret DB details'); }, async () => ({ ok: false, status: 500, json: async () => ({ error: 'private provider detail' }) })]) {
    const res = response();
    await setup({ fetchImpl })({ method: 'GET', query: {} }, res);
    assert.equal(res.statusCode, 502);
    assert.deepEqual(res.body, { ok: false, error: 'mailroom_unavailable' });
  }
});
