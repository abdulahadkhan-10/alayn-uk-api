/**
 * Sign-up, sign-in, password change and password reset: the security-relevant behaviour.
 */
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { AuthService } from '../src/modules/auth/auth.service';
import { AuthRepository } from '../src/modules/auth/auth.repository';
import { isSessionActive } from '../src/modules/auth/session.store';
import { clearCooldown, consumeOtp } from '../src/modules/auth/otp.store';
import { emailService } from '../src/utils/email.service';
import { verifyToken, verifyRefreshToken } from '../src/utils/jwt';
import { AppError } from '../src/utils/AppError';
import { generateTemporaryPassword } from '../src/utils/password';
import { registerSchema, newPasswordSchema, loginSchema } from '../src/modules/auth/auth.schema';

jest.mock('../src/config/prisma', () => ({ prisma: { user: { findUnique: jest.fn(), update: jest.fn() } } }));
jest.mock('../src/config/redis', () => ({ redisClient: { isOpen: false } }));

const service = new AuthService();
const hash = bcrypt.hashSync('Correct1pass', 4);
const owner: any = {
  id: 'user-owner',
  email: 'owner@cafe.com',
  name: 'Owner',
  role: 'BUSINESS_OWNER',
  businessId: 'biz-1',
  phoneNo: '9999999999',
  isActive: true,
  passwordHash: hash,
  business: { id: 'biz-1' },
  businessOwner: { id: 'bo-1' },
};

let sentOtp: string | undefined;
beforeEach(() => {
  sentOtp = undefined;
  jest.spyOn(emailService, 'sendPasswordResetOtp').mockImplementation(async (args: any) => {
    sentOtp = args.otp;
    return true;
  });
  jest.spyOn(AuthRepository.prototype, 'updatePassword').mockResolvedValue({} as any);
});

describe('login', () => {
  it('gives the same answer for an unknown email and a wrong password', async () => {
    jest.spyOn(AuthRepository.prototype, 'findUserByEmail').mockResolvedValueOnce(null);
    const unknown = await service.login('nobody@cafe.com', 'Whatever1').catch((e) => e);

    jest.spyOn(AuthRepository.prototype, 'findUserByEmail').mockResolvedValueOnce(owner);
    const wrong = await service.login('owner@cafe.com', 'Wrong1pass').catch((e) => e);

    expect(unknown).toBeInstanceOf(AppError);
    expect(wrong).toBeInstanceOf(AppError);
    expect([unknown.code, unknown.statusCode, unknown.message]).toEqual([wrong.code, wrong.statusCode, wrong.message]);
    expect(unknown.statusCode).toBe(401);
  });

  it('looks the account up by the trimmed, lower-cased email', async () => {
    const find = jest.spyOn(AuthRepository.prototype, 'findUserByEmail').mockResolvedValue(owner);
    await service.login('  Owner@Cafe.COM ', 'Correct1pass');
    expect(find).toHaveBeenCalledWith('owner@cafe.com');
  });

  it('issues an access token and a refresh token that name the same live session', async () => {
    jest.spyOn(AuthRepository.prototype, 'findUserByEmail').mockResolvedValue(owner);
    const result = await service.login('owner@cafe.com', 'Correct1pass');

    const access = verifyToken(result.accessToken);
    const refresh = verifyRefreshToken(result.refreshToken);
    expect(access.sid).toBeTruthy();
    expect(refresh.sid).toBe(access.sid);
    expect(refresh.jti).toBeTruthy();
    expect(await isSessionActive(access.sid, owner.id)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('passwordHash');
  });

  it('does not tell a deactivated account holder anything without the right password', async () => {
    jest.spyOn(AuthRepository.prototype, 'findUserByEmail').mockResolvedValue({ ...owner, isActive: false });
    const wrong = await service.login('owner@cafe.com', 'Wrong1pass').catch((e) => e);
    expect(wrong.code).toBe('INVALID_CREDENTIALS');
    const right = await service.login('owner@cafe.com', 'Correct1pass').catch((e) => e);
    expect(right.code).toBe('ACCOUNT_DISABLED');
  });
});

describe('refresh rotation through the service', () => {
  beforeEach(() => {
    jest.spyOn(AuthRepository.prototype, 'findUserByEmail').mockResolvedValue(owner);
    jest.spyOn(AuthRepository.prototype, 'findUserById').mockResolvedValue(owner);
  });

  it('rotates the refresh token and keeps the session', async () => {
    const login = await service.login('owner@cafe.com', 'Correct1pass');
    const next = await service.refresh(login.refreshToken);
    expect(next.refreshToken).toBeTruthy();
    expect(next.refreshToken).not.toBe(login.refreshToken);
    expect(next.sid).toBe(login.sid);
    expect(await isSessionActive(login.sid, owner.id)).toBe(true);
  });

  it('two refreshes with the same token: one rotates, the duplicate gets only an access token', async () => {
    const login = await service.login('owner@cafe.com', 'Correct1pass');
    const [a, b] = await Promise.all([service.refresh(login.refreshToken), service.refresh(login.refreshToken)]);
    const rotated = [a, b].filter((r) => r.refreshToken);
    const duplicate = [a, b].filter((r) => !r.refreshToken);
    expect(rotated).toHaveLength(1);
    expect(duplicate).toHaveLength(1);
    expect(duplicate[0].accessToken).toBeTruthy();
    expect(await isSessionActive(login.sid, owner.id)).toBe(true);
  });

  it('a replayed old token after rotation ends the session for security', async () => {
    jest.useFakeTimers();
    try {
      const login = await service.login('owner@cafe.com', 'Correct1pass');
      await service.refresh(login.refreshToken);
      jest.setSystemTime(Date.now() + 60_000);
      await expect(service.refresh(login.refreshToken)).rejects.toMatchObject({ code: 'TOKEN_REUSED', statusCode: 401 });
      expect(await isSessionActive(login.sid, owner.id)).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('logout ends the session so neither token works any more', async () => {
    const login = await service.login('owner@cafe.com', 'Correct1pass');
    await service.logout(login.sid);
    expect(await isSessionActive(login.sid, owner.id)).toBe(false);
    await expect(service.refresh(login.refreshToken)).rejects.toMatchObject({ statusCode: 401 });
  });

  it('logoutAll ends every device', async () => {
    const d1 = await service.login('owner@cafe.com', 'Correct1pass');
    const d2 = await service.login('owner@cafe.com', 'Correct1pass');
    await service.logoutAll(owner.id);
    expect(await isSessionActive(d1.sid, owner.id)).toBe(false);
    expect(await isSessionActive(d2.sid, owner.id)).toBe(false);
  });
});

describe('change password', () => {
  beforeEach(() => {
    jest.spyOn(AuthRepository.prototype, 'findUserByEmail').mockResolvedValue(owner);
    jest.spyOn(AuthRepository.prototype, 'findUserById').mockResolvedValue(owner);
  });

  it('signs every other device out and hands this device a fresh session', async () => {
    const thisDevice = await service.login('owner@cafe.com', 'Correct1pass');
    const otherDevice = await service.login('owner@cafe.com', 'Correct1pass');

    const result = await service.changePassword(owner.id, 'Correct1pass', 'Brand9new');

    expect(await isSessionActive(otherDevice.sid, owner.id)).toBe(false);
    expect(await isSessionActive(thisDevice.sid, owner.id)).toBe(false); // old session replaced...
    expect(await isSessionActive(result.sid, owner.id)).toBe(true); // ...by the fresh one
    expect(result.accessToken).toBeTruthy();
  });

  it('rejects a wrong current password and an unchanged password', async () => {
    await expect(service.changePassword(owner.id, 'Wrong1pass', 'Brand9new')).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    await expect(service.changePassword(owner.id, 'Correct1pass', 'Correct1pass')).rejects.toMatchObject({ code: 'INVALID_PASSWORD' });
  });
});

describe('forgot password / reset', () => {
  beforeEach(async () => {
    // The resend cool-down is real behaviour; start every test with a clean slate
    for (const email of ['owner@cafe.com', 'ghost@cafe.com', 'ghost2@cafe.com']) {
      await clearCooldown(email);
      await consumeOtp(email);
    }
    jest.spyOn(AuthRepository.prototype, 'findUserByEmail').mockImplementation(async (email: string) => (email === 'owner@cafe.com' ? owner : null));
    jest.spyOn(AuthRepository.prototype, 'findUserById').mockResolvedValue(owner);
  });

  const flush = () => new Promise((r) => setImmediate(r));

  it('replies identically for real and unknown emails, and cools down both alike', async () => {
    const real = await service.forgotPassword('owner@cafe.com');
    const fake = await service.forgotPassword('ghost@cafe.com');
    expect(real).toEqual(fake);

    // A second request inside the cool-down is refused for both - it cannot reveal which exist
    const realAgain = await service.forgotPassword('owner@cafe.com').catch((e) => e);
    const fakeAgain = await service.forgotPassword('ghost@cafe.com').catch((e) => e);
    expect([realAgain.code, realAgain.statusCode]).toEqual(['COOLDOWN_ACTIVE', 429]);
    expect([fakeAgain.code, fakeAgain.statusCode]).toEqual([realAgain.code, realAgain.statusCode]);
  });

  it('sends the code only to a real account, without making the caller wait for the email', async () => {
    await service.forgotPassword('owner@cafe.com');
    await flush();
    expect(sentOtp).toMatch(/^\d{6}$/);

    sentOtp = undefined;
    await service.forgotPassword('ghost2@cafe.com');
    await flush();
    expect(sentOtp).toBeUndefined();
  });

  it('limits wrong guesses to five even when they arrive in parallel', async () => {
    await service.forgotPassword('owner@cafe.com');
    await flush();
    const wrong = sentOtp === '111111' ? '222222' : '111111';

    const results = await Promise.all(
      Array.from({ length: 40 }, () => service.verifyResetOtp('owner@cafe.com', wrong).catch((e) => e)),
    );
    const checked = results.filter((e) => /attempt/i.test(e.message) && e.code === 'INVALID_OTP');
    expect(checked.length).toBeLessThanOrEqual(5);

    // The real code no longer works either: the code was destroyed by the lock-out
    await expect(service.verifyResetOtp('owner@cafe.com', sentOtp!)).rejects.toBeInstanceOf(AppError);
  });

  it('full reset: code -> single-use token -> new password, signing out every device', async () => {
    const device = await service.login('owner@cafe.com', 'Correct1pass');
    await service.forgotPassword('owner@cafe.com');
    await flush();

    const { resetToken } = await service.verifyResetOtp('owner@cafe.com', sentOtp!);
    await service.resetPassword('owner@cafe.com', resetToken, 'Fresh1password');

    expect(AuthRepository.prototype.updatePassword).toHaveBeenCalledWith('user-owner', expect.any(String));
    expect(await isSessionActive(device.sid, owner.id)).toBe(false);

    // The token cannot be used a second time
    await expect(service.resetPassword('owner@cafe.com', resetToken, 'Another1password')).rejects.toMatchObject({ code: 'INVALID_RESET_TOKEN' });
  });

  it('a code cannot be used twice, and a token only works for the email it was issued to', async () => {
    await service.forgotPassword('owner@cafe.com');
    await flush();
    const code = sentOtp!;
    const { resetToken } = await service.verifyResetOtp('owner@cafe.com', code);

    await expect(service.verifyResetOtp('owner@cafe.com', code)).rejects.toMatchObject({ code: 'INVALID_OTP' });
    await expect(service.resetPassword('someone-else@cafe.com', resetToken, 'Fresh1password')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('stores only a keyed hash of the code, never the code itself', async () => {
    const { attemptOtp } = await import('../src/modules/auth/otp.store');
    await service.forgotPassword('owner@cafe.com');
    await flush();
    const attempt = await attemptOtp('owner@cafe.com', 5);
    if (attempt.state !== 'CHECK') throw new Error('expected a stored code');
    expect(attempt.hash).not.toContain(sentOtp!);
    expect(attempt.hash).not.toBe(crypto.createHash('sha256').update(sentOtp!).digest('hex')); // not a bare, brute-forceable sha256
  });
});

describe('register', () => {
  const data = {
    user: { name: 'New Owner', email: ' New@Cafe.com ', password: 'Strong1pass', phoneNo: '9999999999' },
    business: { name: 'Cafe', locationsCount: '1', businessType: 'Cafe', contactDetail: '9999999999' },
  };

  it('refuses a promo code at signup instead of silently granting access', async () => {
    jest.spyOn(AuthRepository.prototype, 'findUserByEmail').mockResolvedValue(null);
    const register = jest.spyOn(AuthRepository.prototype, 'registerOwner');
    await expect(service.register({ ...data, couponCode: 'ANYTHING' })).rejects.toMatchObject({ code: 'COUPON_NOT_ACCEPTED_AT_SIGNUP' });
    expect(register).not.toHaveBeenCalled();
  });

  it('stores the email lower-cased and never grants a subscription', async () => {
    jest.spyOn(AuthRepository.prototype, 'findUserByEmail').mockResolvedValue(null);
    const register = jest.spyOn(AuthRepository.prototype, 'registerOwner').mockResolvedValue({
      user: { id: 'u', name: 'New Owner', email: 'new@cafe.com', role: 'BUSINESS_OWNER' },
      business: { id: 'b', name: 'Cafe' },
      businessOwner: { id: 'bo', userId: 'u', businessId: 'b' },
    } as any);

    const result: any = await service.register(data);

    expect(register.mock.calls[0][0].user.email).toBe('new@cafe.com');
    expect(register.mock.calls[0][0].user.passwordHash).toMatch(/^\$2[aby]\$12\$/); // bcrypt cost 12
    expect(result.subscription).toBeUndefined();
  });

  it('refuses an email that already exists in any letter case', async () => {
    const find = jest.spyOn(AuthRepository.prototype, 'findUserByEmail').mockResolvedValue({ id: 'x' } as any);
    await expect(service.register(data)).rejects.toMatchObject({ code: 'EMAIL_ALREADY_EXISTS', statusCode: 409 });
    expect(find).toHaveBeenCalledWith('new@cafe.com');
  });
});

describe('input rules', () => {
  it('new passwords need 8+ characters with a letter and a number', () => {
    expect(newPasswordSchema.safeParse('short1').success).toBe(false);
    expect(newPasswordSchema.safeParse('allletters').success).toBe(false);
    expect(newPasswordSchema.safeParse('12345678').success).toBe(false);
    expect(newPasswordSchema.safeParse('goodpass1').success).toBe(true);
  });

  it('login still accepts older, shorter passwords so existing users are not locked out', () => {
    expect(loginSchema.safeParse({ email: 'a@b.co', password: 'abc123' }).success).toBe(true);
  });

  it('signup normalises the email', () => {
    const parsed = registerSchema.parse({
      user: { name: 'Ab', email: '  A@B.Co ', password: 'goodpass1', phoneNo: '1234567890' },
      business: { name: 'Ab', locationsCount: '1', businessType: 'Cafe', contactDetail: '1234567890' },
    });
    expect(parsed.user.email).toBe('a@b.co');
  });

  it('generated temporary passwords are strong and different every time', () => {
    const a = generateTemporaryPassword();
    const b = generateTemporaryPassword();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(14);
    expect(newPasswordSchema.safeParse(a).success).toBe(true);
    expect(a).not.toBe('Supplier@123');
  });
});
