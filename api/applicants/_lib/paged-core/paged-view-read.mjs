import { payloadHash } from './stable-json.mjs';

const VIEWS = new Set(['all','ready','requested','emailed','delivery','stream','preparing','problems','decided','held']);
const SORTS = new Set(['newest','oldest','actioned']);
const fail = code => Object.assign(new Error(code), { code });
const text = (value, maximum = 180) => typeof value === 'string' ? value.trim().slice(0, maximum) || null : null;
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');

function normalize(input = {}) {
  const view = text(input.view, 40) || 'ready';
  const sort = text(input.sort, 40) || (['requested','decided'].includes(view) ? 'actioned' : 'newest');
  const limit = Number(input.limit ?? 50);
  if (!VIEWS.has(view) || !SORTS.has(sort) || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw fail('APPLICANT_VIEW_FILTER_INVALID');
  }
  return { view, sort, limit, roleId: text(input.roleId), sourceJobId: text(input.sourceJobId),
    status: text(input.status, 80), chip: text(input.chip, 40), decisionStatus: text(input.decisionStatus, 40),
    query: text(input.query, 120)?.toLowerCase() || null };
}

async function read(pool, operation, request = {}) {
  if (!pool?.connect) throw fail('APPLICANT_VIEW_READ_CONFIGURATION_INVALID');
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout='12s'");
    const result = await client.query(`SELECT applicant_core.read_applicant_view_${operation}($1::jsonb) AS value`,
      [JSON.stringify(request)]);
    await client.query('COMMIT');
    return result.rows[0]?.value;
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}

export async function readActivePagedViewManifest({ pool, ...request } = {}) {
  return read(pool, 'manifest', request);
}

export async function readActivePagedViewPage({ pool, generationId, generationDigest, cursor, ...input } = {}) {
  const filter = normalize(input);
  const { limit, ...scope } = filter;
  const filterDigest = payloadHash(scope);
  let after;
  if (cursor) {
    try {
      if (typeof cursor !== 'string' || cursor.length > 2_048) throw new Error();
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (parsed.version !== 3 || parsed.generationId !== generationId
        || parsed.generationDigest !== generationDigest || parsed.filterDigest !== filterDigest
        || typeof parsed.after?.primary !== 'string' || typeof parsed.after?.secondary !== 'string'
        || typeof parsed.after?.key !== 'string' || parsed.after.key.length > 1_024) throw new Error();
      after = parsed.after;
    } catch { throw fail('APPLICANT_VIEW_PAGE_CURSOR_STALE'); }
  }
  const result = await read(pool, 'page', { generationId, generationDigest, ...filter, ...(after ? { after } : {}) });
  return Object.freeze({ generation: result.generation, documents: result.documents,
    rows: result.documents.map(document => ({ ...document.row, row_version_id: document.row.id })),
    nextCursor: result.after ? encode({ version: 3, generationId: result.generation.generationId,
      generationDigest: result.generation.generationDigest, filterDigest, after: result.after }) : null });
}

export async function readPagedViewDetail({ pool, ...request } = {}) {
  return read(pool, 'detail', request);
}

export async function readActivePagedViewAuthority({ pool, ...request } = {}) {
  return read(pool, 'authority', request);
}
