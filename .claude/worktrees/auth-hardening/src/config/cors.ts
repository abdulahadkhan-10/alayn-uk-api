/**
 * The one list of browser origins that may call the API with credentials.
 * Shared by the HTTP API (CORS) and Socket.IO so they can never drift apart.
 */
const ALLOWED_ORIGINS = [
  'https://lite.alaynai.com',
  'https://ayn.alaynai.com',
  'https://ayn-api.alaynai.com',
  'https://alaynai.com',
  'https://www.alaynai.com',
  'https://admin.alaynai.com',
  'https://api.alaynai.com',
];

export function isAllowedOrigin(origin: string | undefined | null): boolean {
  // No Origin header: server-to-server, mobile apps and tools (browsers always send one on CORS calls)
  if (!origin) return true;
  const isLocalhost = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  const isAlaynDomain = /^https:\/\/([a-zA-Z0-9-]+\.)*alaynai\.com(:\d+)?$/.test(origin);
  return isLocalhost || isAlaynDomain || ALLOWED_ORIGINS.includes(origin);
}
