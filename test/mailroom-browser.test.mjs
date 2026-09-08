import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const playwrightModule = process.env.PLAYWRIGHT_MODULE;

test('Mailroom browser: search races, HTML isolation, deep links, filters, failures and mobile', { skip: !playwrightModule, timeout: 60000 }, async () => {
  const { chromium } = await import(pathToFileURL(playwrightModule).href);
  const row = { id: 'fixture-1', lane_id: 'interview', lane_name: 'Interview invitations', sender_id: 'sender', mailbox: 'team@example.test', to_email: 'alex@example.test', to_name: 'Alex Example', subject: 'Interview at Example', snippet: 'Thanks for your interest. Let’s find a time.', state: 'sent', delivery_status: 'delivered', sent_at: '2026-09-08T16:00:00.000Z', created_at: '2026-09-08T15:59:00.000Z', has_attachments: false };
  const hostileHTML = '<html><head><meta http-equiv="refresh" content="0;url=https://tracker.example/refresh"><link rel="stylesheet" href="https://tracker.example/style.css"><style>body{background-image:url(https://tracker.example/background)}</style></head><body><h1>Stored HTML</h1><p>Thanks, Alex.</p><script>parent.document.body.dataset.compromised="yes"</script><img src="https://tracker.example/pixel"><iframe src="https://tracker.example/frame"></iframe><a href="https://tracker.example/click" onclick="alert(1)">Open</a><form action="https://tracker.example/form"><input name="secret"></form></body></html>';
  let failList = false; const apiCalls = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/api/mailroom/browser') {
      apiCalls.push({ method: request.method, query: Object.fromEntries(url.searchParams) });
      response.setHeader('Content-Type', 'application/json');
      const mode = url.searchParams.get('mode');
      if (mode === 'lanes') return response.end(JSON.stringify({ ok: true, lanes: [{ id: 'interview', name: 'Interview invitations', description: 'Invite applicants to schedule.', sender_id: 'sender', mailbox: 'team@example.test', enabled: true, sender_status: 'active', sent_24h: 12, queued: 0, attention: 0, last_sent: row.sent_at }], senders: [{ id: 'sender', mailbox: 'team@example.test' }], coverage: { notes: ['Sender details reflect the current registry.'] } }));
      if (mode === 'message') return response.end(JSON.stringify({ ok: true, found: true, row: { ...row, id: url.searchParams.get('id'), body_text: 'Exact stored text <not markup>.', body_html: hostileHTML, attachments: [], run_after: row.created_at }, deliveryEvents: [{ event_type: 'delivered', occurred_at: row.sent_at, status: '250', reason: 'Accepted by recipient server' }], related: [], coverage: { notes: ['Attachment metadata is unavailable.'] } }));
      if (failList) { response.statusCode = 503; return response.end(JSON.stringify({ ok: false })); }
      const q = url.searchParams.get('q') || '';
      if (q === 'slow') await new Promise(resolve => setTimeout(resolve, 750));
      if (response.destroyed) return;
      const item = { ...row, id: q || row.id, subject: q ? 'Search: ' + q : row.subject };
      return response.end(JSON.stringify({ ok: true, rows: q === 'missing' ? [] : [item], nextCursor: null, counts: { sent: q === 'missing' ? 0 : 1, queued: 0, attention: 0, all: 1 }, coverage: { earliest_at: row.created_at, total: 1, notes: ['Fixture history for browser tests only.'] } }));
    }
    const path = url.pathname === '/mailroom' ? '/mailroom.html' : url.pathname;
    if (!['/mailroom.html', '/mailroom.css', '/mailroom.mjs', '/mailroom-model.mjs', '/nav-history.js', '/fonts/pp-grafier.css'].includes(path) && !path.startsWith('/fonts/')) { response.statusCode = 404; return response.end(); }
    try { const bytes = await readFile(resolve(root, '.' + path)); response.setHeader('Content-Type', path.endsWith('.mjs') || path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.html') ? 'text/html' : 'application/octet-stream'); response.end(bytes); } catch { response.statusCode = 404; response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1050 }, timezoneId: 'America/Los_Angeles' });
    const external = []; const errors = [];
    page.on('request', request => { if (!request.url().startsWith(origin) && !request.url().startsWith('data:')) external.push(request.url()); });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/mailroom');
    await page.locator('.email-row').waitFor();
    assert.equal(await page.locator('.recipient').textContent(), 'Alex Example');
    await page.locator('.email-row').click();
    await page.locator('.email-text').waitFor();
    assert.equal(await page.locator('.email-text').textContent(), 'Exact stored text <not markup>.');
    await page.getByRole('button', { name: 'HTML', exact: true }).click();
    await page.frameLocator('.email-html').getByText('Stored HTML').waitFor();
    await page.waitForTimeout(100);
    assert.equal(await page.locator('.email-html').getAttribute('sandbox'), '');
    assert.equal(await page.locator('body').getAttribute('data-compromised'), null);
    assert.equal(await page.frameLocator('.email-html').locator('a[href],script,form,iframe,meta[http-equiv="refresh"]').count(), 0);
    assert.deepEqual(external, [], 'Stored HTML must not fetch tracking or external content, even during parsing');
    const deepLink = page.url();
    assert.match(deepLink, /browse\?id=fixture-1/);
    await page.getByRole('button', { name: '← Back', exact: true }).click();
    await page.locator('.reader-empty').waitFor();
    await page.waitForURL(url => !url.hash);
    await page.goto(origin + '/mailroom?fresh=1' + new URL(deepLink).hash);
    await page.locator('.email-text').waitFor();
    await page.getByRole('button', { name: '← Back', exact: true }).click();
    await page.locator('#filterToggle').click();
    await page.locator('#from').fill('2026-09-08');
    await page.locator('#from').dispatchEvent('change');
    await page.waitForFunction(() => document.querySelector('#listSummary').textContent.includes('of'));
    await page.locator('#to').fill('2026-09-08');
    await page.locator('#to').dispatchEvent('change');
    await page.waitForFunction(() => document.querySelector('#listSummary').textContent.includes('of'));
    assert.ok(apiCalls.some(call => call.query.from === '2026-09-08T07:00:00.000Z' && call.query.to === '2026-09-09T07:00:00.000Z'));
    await page.locator('#search').fill('slow');
    await page.locator('#search').press('Enter');
    await page.waitForTimeout(40);
    await page.locator('#search').fill('fast');
    await page.locator('#search').press('Enter');
    await page.getByText('Search: fast', { exact: true }).waitFor();
    await page.waitForTimeout(800);
    assert.equal(await page.locator('.subject').textContent(), 'Search: fast');
    failList = true;
    await page.locator('#refresh').click();
    await page.getByText('The refresh failed. These are the previously loaded emails; newer activity may be missing.', { exact: true }).waitFor();
    assert.equal(await page.locator('.subject').textContent(), 'Search: fast');
    failList = false;
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#notice').classList.contains('hidden'));
    await page.locator('[data-view="lanes"]').click();
    await page.locator('.lane-card').waitFor();
    assert.equal(await page.locator('.lane-card h3').textContent(), 'Interview invitations');
    await page.getByRole('link', { name: 'View emails →', exact: true }).click();
    await page.locator('.email-row').waitFor();
    assert.equal(await page.locator('#lane').inputValue(), 'interview');
    assert.equal(await page.locator('#viewTitle').textContent(), 'All emails');
    await page.screenshot({ path: '/tmp/mailroom-ui-fixture-desktop.png', fullPage: true });
    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
    await mobile.goto(origin + '/mailroom?embed=1&tab=mailroom');
    await mobile.locator('.email-row').waitFor();
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await mobile.locator('.email-row').click();
    await mobile.locator('.email-text').waitFor();
    assert.equal(await mobile.locator('.reader').isVisible(), true);
    assert.equal(await mobile.locator('.message-list').isVisible(), false);
    await mobile.screenshot({ path: '/tmp/mailroom-ui-fixture-mobile.png', fullPage: true });
    assert.deepEqual(errors, []);
    assert.ok(apiCalls.every(call => call.method === 'GET'));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});
