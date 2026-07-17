declare const process: { env: Record<string, string | undefined> };

const SESSION_COOKIE = '__Secure-raydar_session';
const SESSION_TTL_SECONDS = 365 * 24 * 60 * 60;

export const config = {
  matcher: [
    '/((?!api(?:/|$)|login(?:/|\\.html)?$|auth-session\\.js$|c(?:/|$)|call\\.html$|fonts(?:/|$)|robots\\.txt$).*)',
  ],
};

function allowedDomains(): string[] {
  return (process.env.ALLOWED_DOMAINS || 'raydar.xyz,raydargroup.com,davidphillips.world')
    .split(',')
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
}

function cookieValue(request: Request, name: string): string {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key !== name) continue;
    try { return decodeURIComponent(rest.join('=')); }
    catch { return ''; }
  }
  return '';
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  return new TextDecoder().decode(Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)));
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function signature(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))));
}

function equal(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return result === 0;
}

async function validSession(request: Request, secret: string): Promise<boolean> {
  const token = cookieValue(request, SESSION_COOKIE);
  const [payload, suppliedSignature, extra] = token.split('.');
  if (!payload || !suppliedSignature || extra) return false;
  if (!equal(suppliedSignature, await signature(payload, secret))) return false;
  try {
    const value = JSON.parse(decodeBase64Url(payload));
    const now = Math.floor(Date.now() / 1000);
    const email = String(value.email || '').trim().toLowerCase();
    const domain = String(value.domain || email.split('@')[1] || '').trim().toLowerCase();
    return value.v === 1 && /^[^@\s]+@[^@\s]+$/.test(email) && allowedDomains().includes(domain) &&
      Number.isInteger(value.iat) && Number.isInteger(value.exp) && value.iat <= now + 300 && value.exp > now &&
      value.exp - value.iat === SESSION_TTL_SECONDS;
  } catch {
    return false;
  }
}

export default async function middleware(request: Request) {
  const secret = process.env.AUTH_SESSION_SECRET || '';
  if (secret.length < 32) {
    return new Response('Raydar authentication is not configured.', { status: 503 });
  }
  if (await validSession(request, secret)) return;

  const current = new URL(request.url);
  const login = new URL('/login', current.origin);
  login.searchParams.set('return_to', current.toString());
  return new Response(null, {
    status: 307,
    headers: { Location: login.toString(), 'Cache-Control': 'no-store' },
  });
}
