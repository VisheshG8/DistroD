/** Keep login return paths on this app, including percent-encoded and backslash variants. */
export function safeNextPath(value: unknown, fallback = '/dashboard'): string {
  if (typeof value !== 'string' || value.length > 2000 || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u0020\u007f]/.test(value)) return fallback;
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { return fallback; }
  if (!decoded.startsWith('/') || decoded.startsWith('//') || /[\\\u0000-\u0020\u007f]/.test(decoded)) return fallback;
  try {
    const url = new URL(value, 'https://distribution-desk.invalid');
    const decodedUrl = new URL(decoded, 'https://distribution-desk.invalid');
    if (url.origin !== 'https://distribution-desk.invalid' || decodedUrl.origin !== url.origin || /^\/auth(?:\/|$)/.test(decodedUrl.pathname) || decodedUrl.pathname === '/login') return fallback;
    return url.pathname + url.search + url.hash;
  } catch { return fallback; }
}

/** Redirect origins come from configuration, never forwarded host headers or query parameters. */
export function configuredAppOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim() || (process.env.NODE_ENV !== 'production' ? 'http://localhost:3000' : '');
  if (!configured) throw new Error('Set NEXT_PUBLIC_APP_URL to the public application URL before enabling sign-in redirects.');
  let url: URL;
  try { url = new URL(configured); } catch { throw new Error('NEXT_PUBLIC_APP_URL must be a valid absolute application URL.'); }
  if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)) throw new Error('NEXT_PUBLIC_APP_URL must be an absolute HTTPS URL without credentials or query parameters.');
  if (url.protocol !== 'https:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('NEXT_PUBLIC_APP_URL must use HTTPS outside localhost.');
  if (url.pathname !== '/' && url.pathname !== '') throw new Error('NEXT_PUBLIC_APP_URL must contain only the application origin, with no path.');
  return url.origin;
}

export function authCallbackUrl(origin: string, next: string) {
  const target = new URL('/auth/callback', origin);
  target.searchParams.set('next', safeNextPath(next));
  return target.toString();
}
