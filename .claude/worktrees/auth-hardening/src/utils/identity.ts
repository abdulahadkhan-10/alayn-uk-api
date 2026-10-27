import type { Request } from 'express';

/** Every email is stored and compared trimmed and lower-cased. */
export const normalizeEmail = (email: unknown): string => (typeof email === 'string' ? email.trim().toLowerCase() : '');

export type Portal = 'admin' | 'tenant';

/** Host of the request's Origin/Referer, or '' when absent or malformed. */
function originHost(req: Request): string {
  const raw = (req.headers.origin || req.headers.referer || '') as string;
  if (!raw) return '';
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Which app is calling: the admin console or the customer app. Decided by an explicit header, the
 * admin API path, or an `admin.` host label - never by a substring of the origin.
 */
export function resolvePortal(req: Request): Portal {
  const header = (req.headers['x-portal'] as string | undefined)?.toLowerCase();
  if (header === 'admin') return 'admin';
  if (header === 'tenant') return 'tenant';
  if (req.baseUrl?.startsWith('/api/v1/admin') || req.originalUrl?.startsWith('/api/v1/admin')) return 'admin';
  const host = originHost(req);
  if (host === 'admin' || host.startsWith('admin.')) return 'admin';
  return 'tenant';
}

export const ACCESS_COOKIE: Record<Portal, string> = { tenant: 'token', admin: 'alayn_admin_token' };
export const REFRESH_COOKIE: Record<Portal, string> = { tenant: 'refreshToken', admin: 'alayn_admin_refreshToken' };
