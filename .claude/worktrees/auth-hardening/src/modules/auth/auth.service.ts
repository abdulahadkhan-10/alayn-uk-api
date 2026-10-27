import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { AuthRepository } from './auth.repository';
import { AppError } from '../../utils/AppError';
import { generateToken, generateRefreshToken, verifyRefreshToken } from '../../utils/jwt';
import { logger } from '../../config/logger';
import { env } from '../../config/env';
import { emailService } from '../../utils/email.service';
import { normalizeEmail } from '../../utils/identity';
import * as sessions from './session.store';
import * as otpStore from './otp.store';

const BCRYPT_COST = 12;
const OTP_TTL_SEC = 10 * 60;
const OTP_MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_SEC = 60;
const RESET_TOKEN_TTL_SEC = 10 * 60;

const GENERIC_FORGOT_MESSAGE = 'If an account exists with this email address, a 6-digit verification code has been sent.';

type TokenUser = {
  id: string;
  email: string;
  role: string;
  name: string;
  businessId?: string | null;
  phoneNo?: string | null;
};

export interface SessionContext {
  ip?: string;
  userAgent?: string;
}

export interface IssuedLogin {
  accessToken: string;
  refreshToken: string;
  sid: string;
  user: ReturnType<AuthService['publicUser']>;
}

// Compared against when the email is unknown, so "no such user" costs the same time as "wrong password".
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= bcrypt.hash('alayn-timing-equaliser', 10));

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

// Reset codes are keyed with a server secret, so a leaked Redis snapshot cannot be brute-forced offline.
const otpKey = crypto.createHmac('sha256', env.JWT_REFRESH_SECRET).update('alayn-otp-v1').digest();
const hashOtp = (email: string, code: string) => crypto.createHmac('sha256', otpKey).update(`${email}:${code}`).digest('hex');

const safeEqualHex = (a: string, b: string): boolean => {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && ab.length > 0 && crypto.timingSafeEqual(ab, bb);
};

export class AuthService {
  private authRepository = new AuthRepository();

  publicUser(user: any) {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      business: user.business,
      businessOwner: user.businessOwner,
    };
  }

  private accessTokenFor(user: TokenUser, sid: string): string {
    return generateToken({
      id: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
      businessId: user.businessId,
      phoneNo: user.phoneNo,
      sid,
    });
  }

  private refreshTokenFor(userId: string, sid: string, jti: string, ttlSec: number): string {
    return generateRefreshToken({ id: userId, sid, jti }, ttlSec);
  }

  /** Starts a brand-new session for a user and returns the matching token pair. */
  private async openSession(user: any, ctx: SessionContext = {}): Promise<IssuedLogin> {
    const session = await sessions.createSession(user.id, ctx);
    return {
      accessToken: this.accessTokenFor(user, session.sid),
      refreshToken: this.refreshTokenFor(user.id, session.sid, session.jti, session.ttlSec),
      sid: session.sid,
      user: this.publicUser(user),
    };
  }

  async register(data: {
    user: {
      name: string;
      email: string;
      password: string;
      phoneNo: string;
    };
    business: {
      name: string;
      locationsCount: string;
      businessType: string;
      contactDetail: string;
    };
    couponCode?: string;
  }) {
    if (data.couponCode && data.couponCode.trim()) {
      throw new AppError(
        'COUPON_NOT_ACCEPTED_AT_SIGNUP',
        'Promo codes cannot be used at signup. Apply your code when you create your first branch or choose a plan.',
        400
      );
    }

    const email = normalizeEmail(data.user.email);

    const existingUser = await this.authRepository.findUserByEmail(email);
    if (existingUser) {
      throw new AppError('EMAIL_ALREADY_EXISTS', 'Email already exists.', 409);
    }

    const passwordHash = await bcrypt.hash(data.user.password, BCRYPT_COST);

    let created;
    try {
      created = await this.authRepository.registerOwner({
        user: {
          name: data.user.name,
          email,
          passwordHash,
          phoneNo: data.user.phoneNo,
        },
        business: {
          name: data.business.name,
          locationsCount: data.business.locationsCount,
          businessType: data.business.businessType,
          contactDetail: data.business.contactDetail,
        },
      });
    } catch (err) {
      // Two signups with the same email racing past the check above
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new AppError('EMAIL_ALREADY_EXISTS', 'Email already exists.', 409);
      }
      throw err;
    }

    const { user, business, businessOwner } = created;
    return {
      message: 'Registration successful. Please login to continue.',

      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },

      business: {
        id: business.id,
        name: business.name,
      },

      businessOwner: {
        id: businessOwner.id,
        userId: businessOwner.userId,
        businessId: businessOwner.businessId,
      },
    };
  }

  async login(email: string, password: string, ctx: SessionContext = {}): Promise<IssuedLogin> {
    const user = await this.authRepository.findUserByEmail(normalizeEmail(email));

    // Always run one bcrypt comparison and give one answer, so the response never reveals
    // whether the email exists.
    const hash = user?.passwordHash ?? (await getDummyHash());
    const passwordOk = await bcrypt.compare(password, hash);
    if (!user || !passwordOk) {
      throw new AppError('INVALID_CREDENTIALS', 'Incorrect email or password.', 401);
    }

    // Only someone who proved they own the account is told it is disabled.
    if (user.isActive === false) {
      throw new AppError('ACCOUNT_DISABLED', 'Your account has been deactivated. Please contact your manager.', 403);
    }

    // Quietly upgrade older, cheaper password hashes the first time their owner signs in
    try {
      if (bcrypt.getRounds(user.passwordHash) < BCRYPT_COST) {
        const upgraded = await bcrypt.hash(password, BCRYPT_COST);
        await this.authRepository.updatePassword(user.id, upgraded);
      }
    } catch (err: any) {
      logger.warn(`[auth] password hash upgrade skipped: ${err?.message || err}`);
    }

    return this.openSession(user, ctx);
  }

  /**
   * Trades a refresh token for a fresh access token, rotating the refresh token.
   * `refreshToken` is undefined when this call was a harmless duplicate of one that just rotated
   * (two tabs refreshing together): the caller already holds the new refresh token in its cookie.
   */
  async refresh(refreshToken: string) {
    const decoded = verifyRefreshToken(refreshToken);
    if (!decoded || !decoded.sid || !decoded.jti || !decoded.id) {
      logger.warn('[auth] refresh rejected: token invalid, expired or from an older login system');
      throw new AppError('INVALID_TOKEN', 'Your session is no longer valid. Please sign in again.', 401);
    }

    const outcome = await sessions.rotateSession(decoded.sid, decoded.jti);

    if (outcome.result === 'INVALID') {
      throw new AppError('INVALID_TOKEN', 'Your session has ended. Please sign in again.', 401);
    }
    if (outcome.result === 'REUSED') {
      logger.warn(`[auth][security] refresh token reuse detected; session ended for user ${decoded.id}`);
      throw new AppError('TOKEN_REUSED', 'Your session was ended for security reasons. Please sign in again.', 401);
    }

    const user = await this.authRepository.findUserById(decoded.id);
    if (!user) {
      await sessions.revokeSession(decoded.sid);
      throw new AppError('INVALID_TOKEN', 'Your session has ended. Please sign in again.', 401);
    }
    if (user.isActive === false) {
      await this.authRepository.deleteUserRefreshTokens(user.id);
      throw new AppError('ACCOUNT_DISABLED', 'Your account has been deactivated. Please contact your manager.', 403);
    }

    return {
      accessToken: this.accessTokenFor(user, decoded.sid),
      refreshToken:
        outcome.result === 'ROTATED'
          ? this.refreshTokenFor(user.id, decoded.sid, outcome.jti, outcome.ttlSec)
          : undefined,
      sid: decoded.sid as string,
      user: this.publicUser(user),
    };
  }

  /** Ends one login. Safe to call twice. */
  async logout(sid?: string) {
    if (sid) await sessions.revokeSession(sid);
  }

  /** Ends every login of this user, on every device. */
  async logoutAll(userId: string) {
    return sessions.revokeAllForUser(userId);
  }

  async getMe(userId: string) {
    const user = await this.authRepository.findUserById(userId);
    if (!user) {
      throw new AppError('USER_NOT_FOUND', 'User not found', 404);
    }
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      phoneNo: user.phoneNo,
      createdAt: user.createdAt,
      business: user.business,
      businessOwner: user.businessOwner,
    };
  }

  async updateProfile(userId: string, data: { name?: string; phoneNo?: string }) {
    const user = await this.authRepository.findUserById(userId);
    if (!user) {
      throw new AppError('USER_NOT_FOUND', 'User not found', 404);
    }

    const updatedUser = await this.authRepository.updateUser(userId, {
      ...(data.name ? { name: data.name } : {}),
      ...(data.phoneNo ? { phoneNo: data.phoneNo } : {}),
    });

    return {
      id: updatedUser.id,
      email: updatedUser.email,
      name: updatedUser.name,
      role: updatedUser.role,
      phoneNo: updatedUser.phoneNo,
      createdAt: updatedUser.createdAt,
      business: updatedUser.business,
      businessOwner: updatedUser.businessOwner,
    };
  }

  /**
   * Changes the password, signs the account out everywhere, and starts one fresh session for the
   * device that made the change so the user is not kicked out of the tab they are using.
   */
  async changePassword(userId: string, oldPassword: string, newPassword: string, ctx: SessionContext = {}) {
    const user = await this.authRepository.findUserById(userId);
    if (!user) {
      throw new AppError('USER_NOT_FOUND', 'User not found', 404);
    }

    const isMatch = await bcrypt.compare(oldPassword, user.passwordHash);
    if (!isMatch) {
      throw new AppError('INVALID_CREDENTIALS', 'Current password is incorrect', 400);
    }
    if (oldPassword === newPassword) {
      throw new AppError('INVALID_PASSWORD', 'New password must be different from your current password.', 400);
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
    await this.authRepository.updatePassword(userId, passwordHash);
    await sessions.revokeAllForUser(userId);

    const login = await this.openSession(user, ctx);
    return { message: 'Password updated successfully', ...login };
  }

  async forgotPassword(email: string) {
    const normalizedEmail = normalizeEmail(email);

    // The resend cool-down applies to every address, real or not, so it cannot be used to find out
    // which emails have accounts.
    const allowed = await otpStore.startCooldown(normalizedEmail, RESEND_COOLDOWN_SEC);
    if (!allowed) {
      throw new AppError(
        'COOLDOWN_ACTIVE',
        'A verification code was recently requested. Please wait 60 seconds before requesting another.',
        429
      );
    }

    const user = await this.authRepository.findUserByEmail(normalizedEmail);

    // Same work and same reply whether or not the account exists; the email goes out in the
    // background so response time does not give it away either.
    const rawOtp = crypto.randomInt(100000, 1000000).toString();
    const otpHash = hashOtp(normalizedEmail, rawOtp);

    if (user) {
      await otpStore.saveOtp(normalizedEmail, otpHash, user.id, OTP_TTL_SEC);
      Promise.resolve()
        .then(() =>
          emailService.sendPasswordResetOtp({
            to: user.email,
            otp: rawOtp,
            recipientName: user.name,
          })
        )
        .catch((err: any) => logger.error(`[auth] password reset email failed for user ${user.id}: ${err?.message || err}`));
    }

    return { message: GENERIC_FORGOT_MESSAGE };
  }

  async verifyResetOtp(email: string, otp: string) {
    const normalizedEmail = normalizeEmail(email);

    // The attempt is counted atomically BEFORE the code is compared, so parallel guesses cannot
    // get more tries than the limit.
    const attempt = await otpStore.attemptOtp(normalizedEmail, OTP_MAX_ATTEMPTS);

    if (attempt.state === 'MISSING') {
      throw new AppError('INVALID_OTP', 'Verification code has expired or is invalid. Please request a new code.', 400);
    }
    if (attempt.state === 'LOCKED') {
      throw new AppError('MAX_ATTEMPTS_EXCEEDED', 'Maximum verification attempts exceeded. Please request a new verification code.', 429);
    }

    if (!safeEqualHex(hashOtp(normalizedEmail, otp.trim()), attempt.hash)) {
      const remaining = OTP_MAX_ATTEMPTS - attempt.attempts;
      if (remaining <= 0) {
        await otpStore.consumeOtp(normalizedEmail);
        throw new AppError('MAX_ATTEMPTS_EXCEEDED', 'Incorrect code. Verification limit reached. Please request a new code.', 400);
      }
      throw new AppError(
        'INVALID_OTP',
        `Incorrect verification code. ${remaining} ${remaining === 1 ? 'attempt' : 'attempts'} remaining.`,
        400
      );
    }

    // Correct code: it can be spent only once, even if two correct submissions arrive together
    if (!(await otpStore.consumeOtp(normalizedEmail))) {
      throw new AppError('INVALID_OTP', 'Verification code has expired or is invalid. Please request a new code.', 400);
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    await otpStore.saveResetToken(sha256(resetToken), { userId: attempt.userId, email: normalizedEmail }, RESET_TOKEN_TTL_SEC);

    return {
      message: 'Code verified successfully.',
      resetToken,
    };
  }

  async resetPassword(email: string, resetToken: string, newPassword: string) {
    const normalizedEmail = normalizeEmail(email);

    // Read-and-destroy in one step: the token works exactly once
    const tokenData = await otpStore.consumeResetToken(sha256(resetToken.trim()));
    if (!tokenData) {
      throw new AppError(
        'INVALID_RESET_TOKEN',
        'Password reset session has expired or is invalid. Please request a new code.',
        400
      );
    }
    if (tokenData.email !== normalizedEmail) {
      throw new AppError('UNAUTHORIZED', 'Invalid reset session for this email address.', 403);
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
    await this.authRepository.updatePassword(tokenData.userId, passwordHash);

    // Sign the account out of every device and drop any code still pending
    await this.authRepository.deleteUserRefreshTokens(tokenData.userId);
    await otpStore.consumeOtp(normalizedEmail);

    logger.info(`[auth] password reset completed for user ${tokenData.userId}`);

    return {
      message: 'Password has been reset successfully. You can now log in with your new password.',
    };
  }
}
