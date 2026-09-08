import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeFilters, stateAddress, addressState, listQuery, localDayBound, statusKey, statusExplanation, displayNumber, createRequestGate, mergeMessageRows, wrapSafeEmailHTML, EMAIL_CSP } from '../mailroom-model.mjs';

test('deep links round-trip filters and message identity without query injection', () => {
  const filters = { view: 'all', q: 'Maya & Ben? # résumé', lane: 'interview-v1', sender: 'david', delivery: 'accepted', from: '2026-09-01', to: '2026-09-08', id: '73?&id=other' };
  assert.deepEqual(addressState(stateAddress(filters)), filters);
  assert.equal(addressState('browse').view, 'sent');
  assert.equal(normalizeFilters({ view: 'delete', from: '2026-02-30', delivery: '__proto__' }).from, '');
  assert.equal(normalizeFilters({ view: 'delete', from: '2026-02-30', delivery: '__proto__' }).delivery, '');
});

test('date pickers query inclusive local days using an exclusive next-day bound', () => {
  const previousTZ = process.env.TZ; process.env.TZ = 'America/Los_Angeles';
  try {
    assert.equal(localDayBound('2026-09-08'), '2026-09-08T07:00:00.000Z');
    assert.equal(localDayBound('2026-09-08', true), '2026-09-09T07:00:00.000Z');
    // Daylight-saving change: one calendar day must not be a fixed 24 hours.
    assert.equal(localDayBound('2026-11-01'), '2026-11-01T07:00:00.000Z');
    assert.equal(localDayBound('2026-11-01', true), '2026-11-02T08:00:00.000Z');
    const query = listQuery({ view: 'sent', q: 'a&delivery=delivered', from: '2026-09-08', to: '2026-09-08' }, 'opaque+/=');
    assert.equal(query.get('q'), 'a&delivery=delivered');
    assert.equal(query.get('delivery'), null);
    assert.equal(query.get('to'), '2026-09-09T07:00:00.000Z');
    assert.equal(query.get('cursor'), 'opaque+/=');
  } finally { if (previousTZ === undefined) delete process.env.TZ; else process.env.TZ = previousTZ; }
});

test('out-of-order and cancelled requests cannot replace current results', async () => {
  const gate = createRequestGate(); const updates = [];
  const first = gate.begin(); const second = gate.begin();
  assert.equal(first.signal.aborted, true);
  if (second.isCurrent()) updates.push('new search');
  await Promise.resolve();
  if (first.isCurrent()) updates.push('old search');
  assert.deepEqual(updates, ['new search']);
  gate.cancel(); assert.equal(second.isCurrent(), false); assert.equal(second.signal.aborted, true);
});

test('accepted, delivered, unknown and absent counters remain distinct', () => {
  assert.equal(statusKey({ state: 'sent' }), 'unknown');
  assert.match(statusExplanation({ delivery_status: 'accepted' }), /confirmed delivery event has not/);
  assert.match(statusExplanation({ delivery_status: 'delivered' }), /does not confirm that the person read/);
  assert.equal(displayNumber(null), '—');
  assert.equal(displayNumber(0), '0');
});

test('pagination does not repeat a message when incoming pages overlap', () => {
  assert.deepEqual(mergeMessageRows([{ id: 'a' }], [{ id: 'a' }, { id: 'b' }, { id: 'b' }]).map(row => row.id), ['a', 'b']);
});

test('HTML preview installs a restrictive CSP before message markup', () => {
  const hostile = '<meta http-equiv="Content-Security-Policy" content="default-src *"><script>alert(1)</script><img src="https://tracker.example/pixel">';
  const wrapped = wrapSafeEmailHTML(hostile);
  assert.ok(wrapped.indexOf("default-src &#39;none&#39;") < wrapped.indexOf(hostile));
  for (const directive of ["script-src 'none'", 'img-src data:', "connect-src 'none'", "form-action 'none'", "base-uri 'none'"]) assert.ok(EMAIL_CSP.includes(directive));
});

test('browser uses read-only same-origin API and an empty preview sandbox', async () => {
  const source = await readFile(new URL('../mailroom.mjs', import.meta.url), 'utf8');
  assert.match(source, /fetch\('\/api\/mailroom\/browser\?'/);
  assert.match(source, /method: 'GET'/);
  assert.match(source, /frame\.setAttribute\('sandbox', ''\)/);
  assert.match(source, /frame\.referrerPolicy = 'no-referrer'/);
  assert.doesNotMatch(source, /method: '(POST|PUT|PATCH|DELETE)'/);
  assert.doesNotMatch(source, /DEMO_ROWS|FAKE_ROWS/);
});
