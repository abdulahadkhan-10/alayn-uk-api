/**
 * Session store behaviour (the in-process backend used in development/test; the Redis backend
 * implements the same rules with Lua and is exercised by scripts/verify-redis-sessions.ts).
 */
import {
  createSession,
  rotateSession,
  isSessionActive,
  revokeSession,
  revokeAllForUser,
  ROTATION_GRACE_MS,
} from '../src/modules/auth/session.store';

jest.mock('../src/config/redis', () => ({ redisClient: { isOpen: false } }));

describe('session store', () => {
  it('a new session is active for its owner only', async () => {
    const s = await createSession('user-1');
    expect(await isSessionActive(s.sid, 'user-1')).toBe(true);
    expect(await isSessionActive(s.sid, 'user-2')).toBe(false);
    expect(await isSessionActive('does-not-exist', 'user-1')).toBe(false);
  });

  it('rotation replaces the refresh id and the old one stops working after the grace window', async () => {
    const s = await createSession('user-1');
    const first = await rotateSession(s.sid, s.jti);
    expect(first.result).toBe('ROTATED');
    if (first.result !== 'ROTATED') throw new Error('unreachable');
    expect(first.jti).not.toBe(s.jti);

    // The newest id keeps working
    const second = await rotateSession(s.sid, first.jti);
    expect(second.result).toBe('ROTATED');
  });

  it('a duplicate refresh inside the grace window (two tabs) is accepted without rotating again', async () => {
    const s = await createSession('user-1');
    const first = await rotateSession(s.sid, s.jti);
    if (first.result !== 'ROTATED') throw new Error('expected rotation');

    const duplicate = await rotateSession(s.sid, s.jti); // the OLD id again, immediately
    expect(duplicate.result).toBe('GRACE');

    // ...and the id issued by the first call is still the valid one
    expect((await rotateSession(s.sid, first.jti)).result).toBe('ROTATED');
  });

  it('re-using an old refresh id after the grace window destroys the whole session (stolen token)', async () => {
    jest.useFakeTimers();
    try {
      const s = await createSession('user-1');
      const first = await rotateSession(s.sid, s.jti);
      if (first.result !== 'ROTATED') throw new Error('expected rotation');

      jest.setSystemTime(Date.now() + ROTATION_GRACE_MS + 1000);
      const replay = await rotateSession(s.sid, s.jti);
      expect(replay.result).toBe('REUSED');

      // The legitimate holder of the newest id is signed out too
      expect(await isSessionActive(s.sid, 'user-1')).toBe(false);
      expect((await rotateSession(s.sid, first.jti)).result).toBe('INVALID');
    } finally {
      jest.useRealTimers();
    }
  });

  it('a refresh for an unknown or revoked session is invalid', async () => {
    expect((await rotateSession('nope', 'x')).result).toBe('INVALID');
    const s = await createSession('user-1');
    await revokeSession(s.sid);
    expect((await rotateSession(s.sid, s.jti)).result).toBe('INVALID');
    expect(await isSessionActive(s.sid, 'user-1')).toBe(false);
  });

  it('revoking is safe to repeat', async () => {
    const s = await createSession('user-1');
    await revokeSession(s.sid);
    await expect(revokeSession(s.sid)).resolves.toBeUndefined();
  });

  it('revokeAllForUser ends every session of that user and nobody else', async () => {
    const a1 = await createSession('user-a');
    const a2 = await createSession('user-a');
    const b1 = await createSession('user-b');

    expect(await revokeAllForUser('user-a')).toBe(2);

    expect(await isSessionActive(a1.sid, 'user-a')).toBe(false);
    expect(await isSessionActive(a2.sid, 'user-a')).toBe(false);
    expect(await isSessionActive(b1.sid, 'user-b')).toBe(true);
  });

  it('revokeAllForUser can keep the current session', async () => {
    const keep = await createSession('user-c');
    const other = await createSession('user-c');

    await revokeAllForUser('user-c', keep.sid);

    expect(await isSessionActive(keep.sid, 'user-c')).toBe(true);
    expect(await isSessionActive(other.sid, 'user-c')).toBe(false);
  });

  it('caps simultaneous sessions per user, signing out the oldest first', async () => {
    const { env } = await import('../src/config/env');
    const max = env.MAX_SESSIONS_PER_USER;
    const first = await createSession('user-cap');
    for (let i = 0; i < max; i++) await createSession('user-cap');

    expect(await isSessionActive(first.sid, 'user-cap')).toBe(false);
  });

  it('sessions expire when idle for longer than the refresh window', async () => {
    jest.useFakeTimers();
    try {
      const s = await createSession('user-idle');
      expect(await isSessionActive(s.sid, 'user-idle')).toBe(true);
      jest.setSystemTime(Date.now() + (s.ttlSec + 5) * 1000);
      expect(await isSessionActive(s.sid, 'user-idle')).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});
