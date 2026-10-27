import { Request, Response, NextFunction, RequestHandler } from 'express';
import { redisClient } from '../config/redis';
import { logger } from '../config/logger';

/**
 * Fixed-window rate limiter shared across every server instance through Redis.
 * If Redis is unreachable it falls back to counting inside this process, so limits keep applying
 * (per instance) instead of disappearing.
 */

export interface RateLimitOptions {
  /** Short unique name, becomes part of the Redis key. */
  name: string;
  windowSec: number;
  max: number;
  /** What to count by. Return null to skip limiting this request. */
  key: (req: Request) => string | null;
  /** Do not count requests that finish with a status below 400 (e.g. successful logins). */
  skipSuccessful?: boolean;
  message?: string;
}

const PREFIX = 'auth:rl:';

// Atomic count + expiry. Returns {count, secondsLeft}.
const HIT = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
local t = redis.call('TTL', KEYS[1])
if t < 0 then redis.call('EXPIRE', KEYS[1], ARGV[1]) t = tonumber(ARGV[1]) end
return {c, t}
`;
const RELEASE = `
local v = tonumber(redis.call('GET', KEYS[1]) or '0')
if v > 0 then redis.call('DECR', KEYS[1]) end
return 1
`;

const memory = new Map<string, { count: number; resetAt: number }>();
const prune = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of memory) if (v.resetAt <= now) memory.delete(k);
}, 60_000);
prune.unref?.();

const redisUsable = (): boolean => (redisClient as any).isReady === true;

async function hit(redisKey: string, windowSec: number): Promise<{ count: number; secondsLeft: number }> {
  if (redisUsable()) {
    try {
      const [count, ttl] = (await (redisClient as any).eval(HIT, { keys: [redisKey], arguments: [String(windowSec)] })) as [number, number];
      return { count: Number(count), secondsLeft: Math.max(1, Number(ttl)) };
    } catch (err: any) {
      logger.warn(`[rate-limit] Redis unavailable, using in-process counter: ${err?.message || err}`);
    }
  }
  const now = Date.now();
  let e = memory.get(redisKey);
  if (!e || e.resetAt <= now) {
    e = { count: 0, resetAt: now + windowSec * 1000 };
    memory.set(redisKey, e);
  }
  e.count += 1;
  return { count: e.count, secondsLeft: Math.max(1, Math.ceil((e.resetAt - now) / 1000)) };
}

async function release(redisKey: string): Promise<void> {
  if (redisUsable()) {
    try {
      await (redisClient as any).eval(RELEASE, { keys: [redisKey], arguments: [] });
      return;
    } catch {
      /* fall through to memory */
    }
  }
  const e = memory.get(redisKey);
  if (e && e.count > 0) e.count -= 1;
}

export function rateLimit(opts: RateLimitOptions): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    let id: string | null;
    try {
      id = opts.key(req);
    } catch {
      id = null;
    }
    if (!id) return next();

    const redisKey = `${PREFIX}${opts.name}:${id}`;
    const { count, secondsLeft } = await hit(redisKey, opts.windowSec);

    res.setHeader('RateLimit-Limit', String(opts.max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, opts.max - count)));
    res.setHeader('RateLimit-Reset', String(secondsLeft));

    if (count > opts.max) {
      res.setHeader('Retry-After', String(secondsLeft));
      logger.warn(`[rate-limit] ${opts.name} limit hit (${count}/${opts.max}) for ${id.replace(/:.*/, ':…')}`);
      return res.status(429).json({
        success: false,
        error: {
          code: 'TOO_MANY_REQUESTS',
          message: opts.message ?? 'Too many requests. Please wait a while and try again.',
        },
      });
    }

    if (opts.skipSuccessful) {
      res.on('finish', () => {
        if (res.statusCode < 400) void release(redisKey);
      });
    }
    return next();
  };
}

// ─── key helpers ────────────────────────────────────────────────────────────────

export const clientIp = (req: Request): string => req.ip || req.socket?.remoteAddress || 'unknown';

/** Lower-cased, trimmed, length-capped email from the body, or '' when absent. */
export const bodyEmail = (req: Request): string => {
  const e = req.body?.email;
  return typeof e === 'string' ? e.trim().toLowerCase().slice(0, 254) : '';
};
