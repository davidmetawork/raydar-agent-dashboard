// A tiny static-file + mock-API server for the scripted employee tests.
// Serves the rebuilt dashboard page from dash2/ with clean (extensionless)
// URLs the way Vercel does (ported from qa/clean-url-server.py), and answers
// /api/master-inbox/*, /api/auth/session and /api/seq/config with synthetic
// fixture data. Never touches any live Raydar service or credential.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildMailboxes,
  buildCoverage,
  buildConversations,
  buildThread,
} from '../fixtures/master-inbox-employee-fixture.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

function resolveStaticPath(urlPath) {
  const clean = urlPath.split('?')[0];
  const decoded = decodeURIComponent(clean === '/' ? '/index.html' : clean);
  let candidate = path.join(ROOT, decoded);
  if (!candidate.startsWith(ROOT)) return null; // no path escape
  if (!fs.existsSync(candidate) && fs.existsSync(candidate + '.html')) candidate += '.html';
  if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) candidate = path.join(candidate, 'index.html');
  return fs.existsSync(candidate) ? candidate : null;
}

// A minimal stand-in for lib/search.mjs's field parsing, enough to drive
// E05: known operators (from, to, before, after, label:unread,
// has:attachment) are honoured; anything else (subject:, filename:, is:,
// cc:) is reported back as unsupported so the page's search notice has
// something real to say, and a malformed date produces a date_invalid
// warning instead of silently vanishing.
const KNOWN_FIELDS = new Set(['from', 'to', 'before', 'after', 'in', 'mailbox', 'label']);
const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

function parseServerQuery(q) {
  const tokens = String(q || '').match(/(?:[^\s"]+:"[^"]*"|"[^"]*"|\S+)/g) || [];
  const parsed = { from: '', to: '', before: '', after: '', unread: false, hasAttachment: false, text: [] };
  const unsupported = [];
  const warnings = [];
  for (const raw of tokens) {
    const lower = raw.toLowerCase();
    if (lower === 'has:attachment') { parsed.hasAttachment = true; continue; }
    if (lower === 'label:unread' || lower === 'label:"unread"') { parsed.unread = true; continue; }
    const sep = raw.indexOf(':');
    if (sep > 0) {
      const field = raw.slice(0, sep).toLowerCase();
      const value = raw.slice(sep + 1).replace(/^"|"$/g, '');
      if (KNOWN_FIELDS.has(field)) {
        if ((field === 'before' || field === 'after') && !CALENDAR_DAY.test(value)) {
          warnings.push(`date_invalid:${field}`);
          continue;
        }
        parsed[field] = value;
        continue;
      }
      // subject:, filename:, cc:, is: (and anything else) fall through as
      // full text AND are reported as unsupported, matching lib/search.mjs.
      unsupported.push({ field: field + ':', searchedAs: 'text' });
      parsed.text.push(raw);
      continue;
    }
    parsed.text.push(raw);
  }
  return { parsed, unsupported, warnings };
}

function matchesFilters(row, parsed) {
  if (parsed.unread && !row.unread) return false;
  if (parsed.hasAttachment && !row.has_attachment) return false;
  if (parsed.from && !JSON.stringify(row.latest_from).toLowerCase().includes(parsed.from.toLowerCase())) return false;
  if (parsed.to && !JSON.stringify(row.latest_to).toLowerCase().includes(parsed.to.toLowerCase())) return false;
  if (parsed.after && new Date(row.newest_at) < new Date(parsed.after)) return false;
  if (parsed.before && new Date(row.newest_at) > new Date(parsed.before + 'T23:59:59.999Z')) return false;
  if (parsed.text.length) {
    const haystack = (row.subject + ' ' + row.snippet).toLowerCase();
    if (!parsed.text.every(term => haystack.includes(term.toLowerCase()))) return false;
  }
  return true;
}

function folderMatches(row, folder) {
  if (!folder || folder === 'all') return row.folder !== 'trash' && row.folder !== 'spam';
  if (folder === 'inbox') return row.folder === 'inbox';
  if (folder === 'sent') return row.folder === 'sent';
  if (folder === 'drafts') return row.folder === 'drafts';
  if (folder === 'all-mail') return true;
  if (folder === 'starred') return row.starred;
  return row.folder === folder;
}

export function createMockServer({ port = 0 } = {}) {
  const mailboxes = buildMailboxes();
  const allRows = buildConversations();
  let feedCallCount = 0;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (status, body, headers = {}) => {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
      res.end(payload);
    };

    if (url.pathname === '/api/auth/session') {
      return send(200, { ok: true, authenticated: true, email: 'employee@example.test' });
    }
    if (url.pathname === '/api/seq/config') {
      return send(200, { authRequired: true, googleClientId: 'fixture-client-id' });
    }
    if (url.pathname === '/api/master-inbox/health') {
      return send(200, { ok: true, coverage: buildCoverage() });
    }
    if (url.pathname === '/api/master-inbox/mailboxes') {
      return send(200, { ok: true, mailboxes });
    }
    if (url.pathname === '/api/master-inbox/feed') {
      feedCallCount++;
      const folder = url.searchParams.get('folder') || 'all';
      const mailbox = url.searchParams.get('mailbox') || '';
      const q = url.searchParams.get('q') || '';
      const cursor = url.searchParams.get('cursor') || '';
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 50)));
      const { parsed, unsupported, warnings } = parseServerQuery(q);
      let rows = allRows.filter(row => folderMatches(row, folder));
      if (mailbox) rows = rows.filter(row => row.mailbox_ids.includes(mailbox));
      rows = rows.filter(row => matchesFilters(row, parsed));
      rows = [...rows].sort((a, b) => new Date(b.newest_at) - new Date(a.newest_at));
      let startIndex = 0;
      if (cursor) {
        try {
          const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
          startIndex = rows.findIndex(row => row.id === decoded.id) + 1;
          if (startIndex <= 0) startIndex = 0;
        } catch { startIndex = 0; }
      }
      const page = rows.slice(startIndex, startIndex + limit);
      const hasMore = startIndex + limit < rows.length;
      const nextCursor = hasMore && page.length
        ? Buffer.from(JSON.stringify({ at: page[page.length - 1].newest_at, id: page[page.length - 1].id })).toString('base64url')
        : null;
      return send(200, {
        ok: true,
        rows: page,
        cursor: nextCursor,
        hasMore,
        mailboxes,
        mailboxStatus: 'ok',
        coverage: buildCoverage(),
        query: { unsupported, warnings },
      });
    }
    if (url.pathname === '/api/master-inbox/thread') {
      const id = url.searchParams.get('id');
      const conversation = buildThread(id);
      if (!conversation) return send(404, { ok: false, error: 'conversation_not_found' });
      return send(200, { ok: true, conversation });
    }
    if (url.pathname.startsWith('/api/master-inbox/')) {
      // Everything else (action, send, draft, attachment, report...) is
      // out of scope for the read-only employee tests; refuse cleanly
      // rather than silently succeeding so a stray click is visible.
      return send(501, { ok: false, error: 'not_mocked_in_employee_fixture' });
    }

    const filePath = resolveStaticPath(url.pathname);
    if (!filePath) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });

  return new Promise(resolve => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        port: address.port,
        baseUrl: `http://127.0.0.1:${address.port}`,
        getFeedCallCount: () => feedCallCount,
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}
