import crypto from 'crypto';
import { redisClient } from '../../config/redis';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { AppError } from '../../utils/AppError';
import { REFRESH_TOKEN_TTL_SEC, SESSION_MAX_AGE_SEC } from '../../utils/jwt';

/**
 * Authoritative login-session store.
 *
 * One login = one session ("sid"). Both the access token and the refresh token carry the sid, so
 * ending the session (logout, password change, account disabled, token reuse) ends BOTH at once.
 *
 *   auth:sess:<sid>    hash  uid, jti (current refresh id), pjti/pat (previous id + when it was
 *                            replaced), iat, exp (absolute end), ip, ua      TTL = idle window
 *   auth:usess:<uid>   zset  sid scored by absolute expiry (lets us end every session of a user)
 *
 * Every state change is a single Lua script, so concurrent refreshes cannot both win.
 * In production a missing Redis fails CLOSED (503) rather than silently skipping the session check;
 * in development/test an in-process store takes over so the app still runs without Redis.
 */

const SESS = 'auth:sess:';
const USESS = 'auth:usess:';

/** A refresh token that was replaced less than this long ago is still accepted once (parallel tabs). */
export const ROTATION_GRACE_MS = 10_000;

export type RotateOutcome =
  | { result: 'ROTATED'; jti: string; ttlSec: number }
  | { result: 'GRACE'; ttlSec: number } // old token seen again inside the grace window: new access token only
  | { result: 'INVALID' } // no such session (expired, logged out, revoked)
  | { result: 'REUSED' }; // an already-rotated token came back after the grace window: session destroyed

export interface CreatedSession {
  sid: string;
  jti: string;
  /** Lifetime to give the refresh token (idle window, capped by the absolute session end). */
  ttlSec: number;
}

export class SessionStoreUnavailableError extends AppError {
  constructor() {
    super('AUTH_STORE_UNAVAILABLE', 'Authentication is temporarily unavailable. Please try again shortly.', 503);
  }
}

const redisUsable = (): boolean => (redisClient as any).isReady === true;

/** Decides which backend serves this call. Throws in production when Redis is not ready. */
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
    logger.error(`[session-store] ${op} failed: ${err?.message || err}`);
    throw new SessionStoreUnavailableError();
  }
};

// ─── Lua scripts ────────────────────────────────────────────────────────────────

// KEYS: sessKey, usessKey | ARGV: sid, uid, jti, nowMs, expMs, idleTtlSec, maxSessions, sessPrefix, ip, ua, maxAgeSec
const CREATE = `
local ttl = math.min(tonumber(ARGV[6]), math.floor((tonumber(ARGV[5]) - tonumber(ARGV[4])) / 1000))
if ttl <= 0 then return 0 end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[4])
local all = redis.call('ZRANGE', KEYS[2], 0, -1)
for _, s in ipairs(all) do
  if redis.call('EXISTS', ARGV[8] .. s) == 0 then redis.call('ZREM', KEYS[2], s) end
end
redis.call('HSET', KEYS[1], 'uid', ARGV[2], 'jti', ARGV[3], 'iat', ARGV[4], 'exp', ARGV[5], 'ip', ARGV[9], 'ua', ARGV[10])
redis.call('EXPIRE', KEYS[1], ttl)
redis.call('ZADD', KEYS[2], ARGV[5], ARGV[1])
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[11]))
local n = redis.call('ZCARD', KEYS[2])
local max = tonumber(ARGV[7])
if n > max then
  local old = redis.call('ZRANGE', KEYS[2], 0, n - max - 1)
  for _, s in ipairs(old) do
    redis.call('DEL', ARGV[8] .. s)
    redis.call('ZREM', KEYS[2], s)
  end
end
return ttl
`;

// KEYS: sessKey | ARGV: presentedJti, newJti, nowMs, graceMs, idleTtlSec, usessPrefix, sid
// returns {code, ttl}: 1 rotated, 2 grace, 0 invalid, 3 reused (session destroyed)
const ROTATE = `
local cur = redis.call('HGET', KEYS[1], 'jti')
if not cur then return {0, 0} end
local now = tonumber(ARGV[3])
local uid = redis.call('HGET', KEYS[1], 'uid')
local exp = tonumber(redis.call('HGET', KEYS[1], 'exp'))
local ttl = math.min(tonumber(ARGV[5]), math.floor((exp - now) / 1000))
if ttl <= 0 then
  redis.call('DEL', KEYS[1])
  if uid then redis.call('ZREM', ARGV[6] .. uid, ARGV[7]) end
  return {0, 0}
end
if cur == ARGV[1] then
  redis.call('HSET', KEYS[1], 'pjti', cur, 'pat', ARGV[3], 'jti', ARGV[2])
  redis.call('EXPIRE', KEYS[1], ttl)
  return {1, ttl}
end
local pj = redis.call('HGET', KEYS[1], 'pjti')
local pat = tonumber(redis.call('HGET', KEYS[1], 'pat') or '0')
if pj and pj == ARGV[1] and (now - pat) <= tonumber(ARGV[4]) then return {2, ttl} end
redis.call('DEL', KEYS[1])
if uid then redis.call('ZREM', ARGV[6] .. uid, ARGV[7]) end
return {3, 0}
`;

// KEYS: sessKey | ARGV: sid, usessPrefix
const REVOKE_ONE = `
local uid = redis.call('HGET', KEYS[1], 'uid')
redis.call('DEL', KEYS[1])
if uid then redis.call('ZREM', ARGV[2] .. uid, ARGV[1]) end
return 1
`;

// KEYS: usessKey | ARGV: exceptSid, sessPrefix
const REVOKE_ALL = `
local sids = redis.call('ZRANGE', KEYS[1], 0, -1)
local n = 0
for _, s in ipairs(sids) do
  if s ~= ARGV[1] then
    redis.call('DEL', ARGV[2] .. s)
    redis.call('ZREM', KEYS[1], s)
    n = n + 1
  end
end
return n
`;

const evalScript = (script: string, keys: string[], args: Array<string | number>) =>
  (redisClient as any).eval(script, { keys, arguments: args.map(String) });

// ─── In-process fallback (development / test only) ──────────────────────────────

interface MemSession {
  uid: string;
  jti: string;
  pjti?: string;
  pat?: number;
  exp: number;
  idleExp: number;
}
const memSessions = new Map<string, MemSession>();
const memUserSessions = new Map<string, Set<string>>();

const memAlive = (sid: string, now = Date.now()): MemSession | undefined => {
  const s = memSessions.get(sid);
  if (!s) return undefined;
  if (s.idleExp <= now || s.exp <= now) {
    memDrop(sid);
    return undefined;
  }
  return s;
};
const memDrop = (sid: string) => {
  const s = memSessions.get(sid);
  if (!s) return;
  memSessions.delete(sid);
  memUserSessions.get(s.uid)?.delete(sid);
};

const memPrune = setInterval(() => {
  const now = Date.now();
  for (const sid of [...memSessions.keys()]) memAlive(sid, now);
}, 60_000);
memPrune.unref?.();

// ─── Public API ─────────────────────────────────────────────────────────────────

export interface SessionMeta {
  ip?: string;
  userAgent?: string;
}

export async function createSession(userId: string, meta: SessionMeta = {}): Promise<CreatedSession> {
  const sid = crypto.randomBytes(18).toString('base64url');
  const jti = crypto.randomUUID();
  const now = Date.now();
  const expMs = now + SESSION_MAX_AGE_SEC * 1000;

  if (backend() === 'memory') {
    const ttl = Math.min(REFRESH_TOKEN_TTL_SEC, Math.floor((expMs - now) / 1000));
    const set = memUserSessions.get(userId) ?? new Set<string>();
    memUserSessions.set(userId, set);
    for (const s of [...set]) if (!memAlive(s)) set.delete(s);
    memSessions.set(sid, { uid: userId, jti, exp: expMs, idleExp: now + ttl * 1000 });
    set.add(sid);
    while (set.size > env.MAX_SESSIONS_PER_USER) {
      const oldest = set.values().next().value as string;
      memDrop(oldest);
    }
    return { sid, jti, ttlSec: ttl };
  }

  const ttl = await run('create', async () =>
    Number(
      await evalScript(
        CREATE,
        [SESS + sid, USESS + userId],
        [sid, userId, jti, now, expMs, REFRESH_TOKEN_TTL_SEC, env.MAX_SESSIONS_PER_USER, SESS, meta.ip ?? '', (meta.userAgent ?? '').slice(0, 200), SESSION_MAX_AGE_SEC],
      ),
    ),
  );
  if (!ttl || ttl <= 0) throw new SessionStoreUnavailableError();
  return { sid, jti, ttlSec: ttl };
}

/** Exchanges the presented refresh id for a new one, atomically. */
export async function rotateSession(sid: string, presentedJti: string): Promise<RotateOutcome> {
  const newJti = crypto.randomUUID();
  const now = Date.now();

  if (backend() === 'memory') {
    const s = memAlive(sid, now);
    if (!s) return { result: 'INVALID' };
    const ttl = Math.min(REFRESH_TOKEN_TTL_SEC, Math.floor((s.exp - now) / 1000));
    if (s.jti === presentedJti) {
      s.pjti = s.jti;
      s.pat = now;
      s.jti = newJti;
      s.idleExp = now + ttl * 1000;
      return { result: 'ROTATED', jti: newJti, ttlSec: ttl };
    }
    if (s.pjti === presentedJti && s.pat !== undefined && now - s.pat <= ROTATION_GRACE_MS) {
      return { result: 'GRACE', ttlSec: ttl };
    }
    memDrop(sid);
    return { result: 'REUSED' };
  }

  const [code, ttl] = (await run('rotate', () =>
    evalScript(ROTATE, [SESS + sid], [presentedJti, newJti, now, ROTATION_GRACE_MS, REFRESH_TOKEN_TTL_SEC, USESS, sid]),
  )) as [number, number];

  if (code === 1) return { result: 'ROTATED', jti: newJti, ttlSec: Number(ttl) };
  if (code === 2) return { result: 'GRACE', ttlSec: Number(ttl) };
  if (code === 3) return { result: 'REUSED' };
  return { result: 'INVALID' };
}

/** True while the session exists and belongs to this user. Used on every authenticated request. */
export async function isSessionActive(sid: string, userId: string): Promise<boolean> {
  if (backend() === 'memory') {
    return memAlive(sid)?.uid === userId;
  }
  const uid = await run('lookup', () => redisClient.hGet(SESS + sid, 'uid'));
  return !!uid && uid === userId;
}

export async function revokeSession(sid: string): Promise<void> {
  if (backend() === 'memory') {
    memDrop(sid);
    return;
  }
  await run('revoke', () => evalScript(REVOKE_ONE, [SESS + sid], [sid, USESS]));
}

/** Ends every session of a user (optionally keeping one). Returns how many were ended. */
export async function revokeAllForUser(userId: string, exceptSid?: string): Promise<number> {
  if (backend() === 'memory') {
    const set = memUserSessions.get(userId);
    if (!set) return 0;
    let n = 0;
    for (const sid of [...set]) {
      if (sid === exceptSid) continue;
      memDrop(sid);
      n++;
    }
    return n;
  }
  return Number(await run('revoke-all', () => evalScript(REVOKE_ALL, [USESS + userId], [exceptSid ?? '', SESS])));
}

/** Whether the shared store is reachable right now (for health checks). */
export const sessionStoreReady = (): boolean => redisUsable() || !env.isProduction;
