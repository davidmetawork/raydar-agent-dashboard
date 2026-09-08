import { authConfig, requireAuth } from '../seq/_lib/core.mjs';

const FILTERS = new Set(['mode', 'view', 'q', 'lane', 'sender', 'delivery', 'from', 'to', 'cursor', 'limit', 'id']);

export function createHandler({ config = authConfig, authenticate = requireAuth, fetchImpl = fetch, env = process.env } = {}) {
  return async function handler(req, res) {
    res.setHeader('cache-control', 'private, no-store, max-age=0');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('vary', 'Cookie, Authorization');
    if (req.method !== 'GET') {
      res.setHeader('allow', 'GET');
      return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    }
    if (!config().authRequired) return res.status(503).json({ ok: false, error: 'auth_not_configured' });
    if (!await authenticate(req, res)) return;
    if (!env.MAILROOM_API_KEY) return res.status(503).json({ ok: false, error: 'mailroom_not_configured' });

    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(req.query || {})) {
      if (!FILTERS.has(key) || Array.isArray(value) || typeof value !== 'string' || value.length > 4096) {
        return res.status(400).json({ ok: false, error: 'invalid_query' });
      }
      params.set(key, value);
    }
    try {
      const base = String(env.MAILROOM_BASE || 'https://raydar-mailroom.vercel.app').replace(/\/$/, '');
      const result = await fetchImpl(`${base}/api/browser?${params}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${env.MAILROOM_API_KEY}`, accept: 'application/json' },
        signal: AbortSignal.timeout(25_000),
        redirect: 'error',
      });
      const body = await result.json();
      if (!result.ok) {
        const status = result.status === 400 ? 400 : result.status === 404 ? 404 : 502;
        return res.status(status).json({ ok: false, error: status === 400 ? 'invalid_filter' : 'mailroom_unavailable' });
      }
      if (body?.ok !== true) return res.status(502).json({ ok: false, error: 'mailroom_unavailable' });
      return res.status(200).json(body);
    } catch {
      return res.status(502).json({ ok: false, error: 'mailroom_unavailable' });
    }
  };
}

export default createHandler();
