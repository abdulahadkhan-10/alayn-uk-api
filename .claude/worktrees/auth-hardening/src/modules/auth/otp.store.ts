import { redisClient } from '../../config/redis';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { SessionStoreUnavailableError } from './session.store';
import { AppError } from '../../utils/AppError';

/**
 * Password-reset state: resend cool-down, one-time code (with an atomic attempt counter) and the
 * single-use reset token. Redis in production (a missing Redis fails closed); in-process in
 * development/test only.
 */

const COOLDOWN = 'auth:otp:cd:';
const OTP = 'auth:otp:';
const RESET = 'auth:rst:';

const redisUsable = (): boolean => (redisClient as any).isReady === true;
function backend(): 'redis' | 'memory' {
  if (redisUsable()) return 'redis';
  if (env.isProduction) throw new SessionStoreUnavailableError();
  return 'memory';
}
const run = async <T>(op: string, fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (err: any) {
    if (err instanceof AppError) throw err;
    logger.error(`[otp-store] ${op} failed: ${err?.message || err}`);
    throw new SessionStoreUnavailableError();
  }
};
const evalScript = (script: string, keys: string[], args: Array<string | number>) =>
  (redisClient as any).eval(script, { keys, arguments: args.map(String) });

// Counts the attempt BEFORE comparing, in one step, so parallel guesses cannot dodge the limit.
// returns {0} no code | {-1} locked (code destroyed) | {attempts, hash, uid}
const ATTEMPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {0} end
local a = redis.call('HINCRBY', KEYS[1], 'att', 1)
if a > tonumber(ARGV[1]) then
  redis.call('DEL', KEYS[1])
  return {-1}
end
return {a, redis.call('HGET', KEYS[1], 'h'), redis.call('HGET', KEYS[1], 'uid')}
`;

const GET_AND_DEL = `
local v = redis.call('GET', KEYS[1])
if v then redis.call('DEL', KEYS[1]) end
return v
`;

// ─── in-process fallback ────────────────────────────────────────────────────────
const mem = new Map<string, { value: any; exp: number }>();
const memGet = (k: string) => {
  const e = mem.get(k);
  if (!e) return undefined;
  if (e.exp <= Date.now()) {
    mem.delete(k);
    return undefined;
  }
  return e;
};
const memSet = (k: string, value: any, ttlSec: number) => mem.set(k, { value, exp: Date.now() + ttlSec * 1000 });
const prune = setInterval(() => {
  for (const k of [...mem.keys()]) memGet(k);
}, 60_000);
prune.unref?.();

export type OtpAttempt =
  | { state: 'MISSING' }
  | { state: 'LOCKED' }
  | { state: 'CHECK'; attempts: number; hash: string; userId: string };

/** true = cool-down started (go ahead), false = still cooling down. Applies to every email alike. */
export async function startCooldown(emailKey: string, ttlSec: number): Promise<boolean> {
  if (backend() === 'memory') {
    if (memGet(COOLDOWN + emailKey)) return false;
    memSet(COOLDOWN + emailKey, 1, ttlSec);
    return true;
  }
  const res = await run('cooldown', () => redisClient.set(COOLDOWN + emailKey, '1', { NX: true, EX: ttlSec }));
  return res === 'OK';
}

export async function clearCooldown(emailKey: string): Promise<void> {
  if (backend() === 'memory') {
    mem.delete(COOLDOWN + emailKey);
    return;
  }
  await run('cooldown-clear', () => redisClient.del(COOLDOWN + emailKey));
}

export async function saveOtp(emailKey: string, hash: string, userId: string, ttlSec: number): Promise<void> {
  if (backend() === 'memory') {
    memSet(OTP + emailKey, { h: hash, uid: userId, att: 0 }, ttlSec);
    return;
  }
  await run('otp-save', async () => {
    await redisClient.multi().hSet(OTP + emailKey, { h: hash, uid: userId, att: '0' }).expire(OTP + emailKey, ttlSec).exec();
  });
}

export async function attemptOtp(emailKey: string, maxAttempts: number): Promise<OtpAttempt> {
  if (backend() === 'memory') {
    const e = memGet(OTP + emailKey);
    if (!e) return { state: 'MISSING' };
    e.value.att += 1;
    if (e.value.att > maxAttempts) {
      mem.delete(OTP + emailKey);
      return { state: 'LOCKED' };
    }
    return { state: 'CHECK', attempts: e.value.att, hash: e.value.h, userId: e.value.uid };
  }
  const r = (await run('otp-attempt', () => evalScript(ATTEMPT, [OTP + emailKey], [maxAttempts]))) as any[];
  if (!r || r[0] === 0) return { state: 'MISSING' };
  if (r[0] === -1) return { state: 'LOCKED' };
  return { state: 'CHECK', attempts: Number(r[0]), hash: String(r[1]), userId: String(r[2]) };
}

/** Destroys the code; true only for the single caller that actually removed it. */
export async function consumeOtp(emailKey: string): Promise<boolean> {
  if (backend() === 'memory') return mem.delete(OTP + emailKey);
  return (await run('otp-consume', () => redisClient.del(OTP + emailKey))) === 1;
}

export async function saveResetToken(tokenHash: string, data: { userId: string; email: string }, ttlSec: number): Promise<void> {
  if (backend() === 'memory') {
    memSet(RESET + tokenHash, data, ttlSec);
    return;
  }
  await run('reset-save', () => redisClient.set(RESET + tokenHash, JSON.stringify(data), { EX: ttlSec }));
}

/** Reads and destroys the reset token in one step: it can be used exactly once. */
export async function consumeResetToken(tokenHash: string): Promise<{ userId: string; email: string } | null> {
  if (backend() === 'memory') {
    const e = memGet(RESET + tokenHash);
    mem.delete(RESET + tokenHash);
    return e ? e.value : null;
  }
  const raw = (await run('reset-consume', () => evalScript(GET_AND_DEL, [RESET + tokenHash], []))) as string | null;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
