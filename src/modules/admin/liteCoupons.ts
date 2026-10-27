import { AppError } from '../../utils/AppError';

// Alayn Lite keeps its coupons in its own database. The admin console only signs in to this
// backend, so coupon calls for Lite are relayed server-to-server to Lite's internal coupon routes,
// authenticated with a shared key (LITE_INTERNAL_API_KEY on both backends).

const LITE_TIMEOUT_MS = 10_000;

export async function callLiteCoupons<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  options: { query?: Record<string, string | number | undefined>; body?: unknown } = {}
): Promise<T> {
  const baseUrl = (process.env.LITE_API_URL || '').replace(/\/$/, '').replace(/\/api\/v\d+$/, '');
  const key = process.env.LITE_INTERNAL_API_KEY;
  if (!baseUrl || !key) {
    throw new AppError(
      'LITE_NOT_CONFIGURED',
      'Alayn Lite coupons are not configured. Set LITE_API_URL and LITE_INTERNAL_API_KEY on the Alayn backend.',
      503
    );
  }

  const url = new URL(`${baseUrl}/api/v1/internal/coupons${path}`);
  for (const [name, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== '') url.searchParams.set(name, String(value));
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', 'x-internal-key': key },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(LITE_TIMEOUT_MS),
    });
  } catch (error) {
    throw new AppError('LITE_UNREACHABLE', 'Could not reach the Alayn Lite backend.', 502);
  }

  const payload: any = await response.json().catch(() => null);
  if (!response.ok) {
    // A rejected internal key is a server misconfiguration, not the admin's session expiring;
    // passing 401/403 through would make the console try to refresh and sign the admin out
    if (response.status === 401 || response.status === 403) {
      throw new AppError('LITE_AUTH_FAILED', 'Alayn Lite rejected the internal API key. Check LITE_INTERNAL_API_KEY on both backends.', 502);
    }
    const err = payload?.error;
    throw new AppError(
      err?.code || 'LITE_ERROR',
      err?.message || payload?.message || `Alayn Lite responded with ${response.status}`,
      response.status
    );
  }
  return (payload?.data ?? payload) as T;
}
