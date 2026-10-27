import 'dotenv/config';
import { z } from 'zod';

// Development/test-only fallbacks. They are public (they live in this repo), so they are never
// accepted when NODE_ENV=production.
const DEV_JWT_SECRET = 'test_secret_key_12345';
const DEV_JWT_REFRESH_SECRET = 'test_refresh_secret_key_54321';
const DEV_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/alayn_db?schema=public';

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().url().optional(),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_TLS: z.enum(['true', 'false']).optional(),
  JWT_SECRET: z.string().optional(),
  JWT_REFRESH_SECRET: z.string().optional(),
  // Domain attribute for auth cookies. Unset = ".alaynai.com" in production, host-only elsewhere.
  // Set it to an empty string for host-only cookies in production.
  COOKIE_DOMAIN: z.string().optional(),
  // Hard cap on how long one login can be kept alive by refreshing.
  SESSION_MAX_DAYS: z.coerce.number().int().min(1).max(365).default(90),
  // Most simultaneous logins one account may hold; the oldest is signed out beyond this.
  MAX_SESSIONS_PER_USER: z.coerce.number().int().min(1).max(500).default(25),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.format());
  process.exit(1);
}

const raw = parsed.data;
const isProduction = raw.NODE_ENV === 'production';
const problems: string[] = [];

if (isProduction) {
  if (!raw.DATABASE_URL) problems.push('DATABASE_URL is required in production');
  if (!raw.JWT_SECRET) problems.push('JWT_SECRET is required in production');
  if (!raw.JWT_REFRESH_SECRET) problems.push('JWT_REFRESH_SECRET is required in production');
  if (raw.JWT_SECRET && raw.JWT_SECRET.length < 32) problems.push('JWT_SECRET must be at least 32 characters');
  if (raw.JWT_REFRESH_SECRET && raw.JWT_REFRESH_SECRET.length < 32) problems.push('JWT_REFRESH_SECRET must be at least 32 characters');
  if (raw.JWT_SECRET && raw.JWT_SECRET === raw.JWT_REFRESH_SECRET) problems.push('JWT_SECRET and JWT_REFRESH_SECRET must be different');
  if (raw.JWT_SECRET === DEV_JWT_SECRET || raw.JWT_REFRESH_SECRET === DEV_JWT_REFRESH_SECRET) {
    problems.push('JWT secrets must not use the built-in development values');
  }
} else {
  if (raw.JWT_SECRET && raw.JWT_SECRET.length < 8) problems.push('JWT_SECRET must be at least 8 characters');
  if (raw.JWT_REFRESH_SECRET && raw.JWT_REFRESH_SECRET.length < 8) problems.push('JWT_REFRESH_SECRET must be at least 8 characters');
}

if (problems.length > 0) {
  console.error(`Invalid environment configuration:\n - ${problems.join('\n - ')}`);
  process.exit(1);
}

export const env = {
  ...raw,
  DATABASE_URL: raw.DATABASE_URL ?? DEV_DATABASE_URL,
  JWT_SECRET: raw.JWT_SECRET ?? DEV_JWT_SECRET,
  JWT_REFRESH_SECRET: raw.JWT_REFRESH_SECRET ?? DEV_JWT_REFRESH_SECRET,
  isProduction,
};

export type Env = typeof env;
