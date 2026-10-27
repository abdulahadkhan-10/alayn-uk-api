/**
 * Integration check for the Redis-backed auth store. Unit tests run the in-process fallback; this
 * runs the real Lua scripts against a live Redis.
 *
 *   npx ts-node --transpile-only scripts/verify-redis-sessions.ts
 *
 * Uses throwaway keys (prefix "verify-") and removes them. Never flushes or reconfigures Redis.
 */
import { redisClient } from '../src/config/redis';
import {
  createSession,
  rotateSession,
  isSessionActive,
  revokeSession,
  revokeAllForUser,
  ROTATION_GRACE_MS,
} from '../src/modules/auth/session.store';
import {
  startCooldown,
  saveOtp,
  attemptOtp,
  consumeOtp,
  saveResetToken,
  consumeResetToken,
} from '../src/modules/auth/otp.store';
import { rateLimit } from '../src/middleware/rateLimit';
import { env } from '../src/config/env';

const RUN = `verify-${Date.now()}`;
let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  ok ? pass++ : fail++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const created: string[] = [];

async function main() {
  for (let i = 0; i < 50 && !(redisClient as any).isReady; i++) await sleep(100);
  if (!(redisClient as any).isReady) throw new Error('Redis is not reachable');
  const info = await redisClient.info('server');
  console.log(`Redis ${/redis_version:(\S+)/.exec(info)?.[1]}  (namespace ${RUN})\n`);

  console.log('sessions');
  const uid = `${RUN}-user`;
  const s = await createSession(uid, { ip: '203.0.113.9', userAgent: 'verify-script' });
  created.push(s.sid);
  check('create stores a session hash with a TTL', (await redisClient.ttl(`auth:sess:${s.sid}`)) > 0, `ttl ${await redisClient.ttl(`auth:sess:${s.sid}`)}s`);
  check('user index lists the session', (await redisClient.zScore(`auth:usess:${uid}`, s.sid)) !== null);
  check('user index has a TTL (no unbounded growth)', (await redisClient.ttl(`auth:usess:${uid}`)) > 0);
  check('session is active for its owner only', (await isSessionActive(s.sid, uid)) && !(await isSessionActive(s.sid, 'someone-else')));

  const burst = await Promise.all(Array.from({ length: 8 }, () => rotateSession(s.sid, s.jti)));
  const rotated = burst.filter((r) => r.result === 'ROTATED');
  const grace = burst.filter((r) => r.result === 'GRACE');
  check('8 parallel refreshes with one token: exactly ONE rotates', rotated.length === 1, burst.map((b) => b.result).join(','));
  check('the other 7 are harmless duplicates (grace), none create a session', grace.length === 7);
  const currentJti = (rotated[0] as any).jti as string;
  check('only the newest refresh id is stored as current', (await redisClient.hGet(`auth:sess:${s.sid}`, 'jti')) === currentJti);

  console.log(`  ...waiting ${Math.round(ROTATION_GRACE_MS / 1000) + 1}s for the grace window to pass`);
  await sleep(ROTATION_GRACE_MS + 1000);
  const replay = await rotateSession(s.sid, s.jti);
  check('replaying the OLD token after the grace window is detected as reuse', replay.result === 'REUSED');
  check('reuse destroys the whole session (session key gone)', (await redisClient.exists(`auth:sess:${s.sid}`)) === 0);
  check('reuse removes it from the user index', (await redisClient.zScore(`auth:usess:${uid}`, s.sid)) === null);
  check('the thief AND the victim are both signed out', !(await isSessionActive(s.sid, uid)) && (await rotateSession(s.sid, currentJti)).result === 'INVALID');

  const keep = await createSession(uid);
  const drop1 = await createSession(uid);
  const drop2 = await createSession(uid);
  created.push(keep.sid, drop1.sid, drop2.sid);
  const ended = await revokeAllForUser(uid, keep.sid);
  check('revokeAll (keeping one) ends the others atomically', ended === 2 && (await isSessionActive(keep.sid, uid)) && !(await isSessionActive(drop1.sid, uid)) && !(await isSessionActive(drop2.sid, uid)), `ended ${ended}`);
  await revokeSession(keep.sid);
  check('revoke removes session + index entry', (await redisClient.exists(`auth:sess:${keep.sid}`)) === 0 && (await redisClient.zScore(`auth:usess:${uid}`, keep.sid)) === null);
  await revokeSession(keep.sid);
  check('revoking twice is harmless', true);

  const capUser = `${RUN}-cap`;
  const first = await createSession(capUser);
  created.push(first.sid);
  for (let i = 0; i < env.MAX_SESSIONS_PER_USER + 1; i++) created.push((await createSession(capUser)).sid);
  check(`per-user cap (${env.MAX_SESSIONS_PER_USER}) evicts the oldest`, !(await isSessionActive(first.sid, capUser)) && (await redisClient.zCard(`auth:usess:${capUser}`)) <= env.MAX_SESSIONS_PER_USER, `zcard ${await redisClient.zCard(`auth:usess:${capUser}`)}`);

  console.log('\nreset code / token');
  const email = `${RUN}@example.com`;
  const cd = await Promise.all(Array.from({ length: 10 }, () => startCooldown(email, 60)));
  check('cool-down: exactly one of 10 parallel requests starts it', cd.filter(Boolean).length === 1);

  await saveOtp(email, 'abc123hash', 'user-x', 120);
  const tries = await Promise.all(Array.from({ length: 40 }, () => attemptOtp(email, 5)));
  const counted = tries.filter((t) => t.state === 'CHECK').length;
  check('40 parallel guesses: exactly 5 are ever compared', counted === 5, `compared ${counted}, locked ${tries.filter((t) => t.state === 'LOCKED').length}`);
  check('the code is destroyed once the limit is hit', (await attemptOtp(email, 5)).state === 'MISSING');

  await saveOtp(email, 'h2', 'user-x', 120);
  const wins = await Promise.all(Array.from({ length: 10 }, () => consumeOtp(email)));
  check('a correct code can be spent only once (10 parallel)', wins.filter(Boolean).length === 1);

  await saveResetToken(`${RUN}-tok`, { userId: 'user-x', email }, 120);
  const got = await Promise.all(Array.from({ length: 10 }, () => consumeResetToken(`${RUN}-tok`)));
  check('a reset token works exactly once (10 parallel)', got.filter(Boolean).length === 1);

  console.log('\nrate limiter');
  const name = `${RUN}-rl`;
  const limiter = rateLimit({ name, windowSec: 30, max: 5, key: () => 'k' });
  const codes: number[] = [];
  const mkRes = () => {
    const res: any = { headers: {} as any, code: 200 };
    res.setHeader = (k: string, v: string) => { res.headers[k] = v; };
    res.status = (c: number) => { res.code = c; return res; };
    res.json = () => res;
    res.on = () => res;
    return res;
  };
  await Promise.all(Array.from({ length: 12 }, async () => {
    const res = mkRes();
    let passed = false;
    await limiter({} as any, res, () => { passed = true; });
    codes.push(passed ? 200 : res.code);
  }));
  check('12 parallel hits against a limit of 5: exactly 5 pass, 7 get 429', codes.filter((c) => c === 200).length === 5 && codes.filter((c) => c === 429).length === 7, `${codes.filter((c) => c === 200).length} passed`);
  const res = mkRes();
  await limiter({} as any, res, () => {});
  check('rate limit sends Retry-After', typeof res.headers['Retry-After'] === 'string');
}

main()
  .catch((e) => {
    console.error('Script error:', e?.message || e);
    fail++;
  })
  .finally(async () => {
    // Remove every key this run created
    try {
      const keys: string[] = [];
      for await (const k of redisClient.scanIterator({ MATCH: `auth:*${RUN}*`, COUNT: 200 })) keys.push(k as unknown as string);
      for (const sid of created) keys.push(`auth:sess:${sid}`);
      keys.push(`auth:usess:${RUN}-user`, `auth:usess:${RUN}-cap`);
      if (keys.length) await redisClient.del(keys);
    } catch (e) {
      console.error('cleanup warning:', (e as Error).message);
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    await redisClient.quit().catch(() => {});
    process.exit(fail ? 1 : 0);
  });
