import { Request, Response, NextFunction, CookieOptions } from 'express';
import { AuthService } from './auth.service';
import { sendSuccess } from '../../utils/response';
import { AuthenticatedRequest } from '../../middleware/auth.middleware';
import { logger } from '../../config/logger';
import { env } from '../../config/env';
import { AppError } from '../../utils/AppError';
import { clientIp } from '../../middleware/rateLimit';
import { resolvePortal, ACCESS_COOKIE, REFRESH_COOKIE, Portal } from '../../utils/identity';
import { decodeRefreshTokenAllowExpired, verifyToken, REFRESH_TOKEN_TTL_SEC } from '../../utils/jwt';

/** The long-lived refresh cookie is only ever sent to the auth endpoints, not to every API call. */
const REFRESH_COOKIE_PATH = '/api/v1/auth';
const ACCESS_COOKIE_MAX_AGE_MS = 15 * 60 * 1000;

const cookieDomain = (): string | undefined => {
  if (env.COOKIE_DOMAIN !== undefined) return env.COOKIE_DOMAIN || undefined;
  return env.isProduction ? '.alaynai.com' : undefined;
};

const baseCookie = (path: string): CookieOptions => ({
  httpOnly: true,
  secure: env.isProduction,
  sameSite: 'lax',
  path,
  domain: cookieDomain(),
});

/** SUPER_ADMIN logins live in their own cookies so an admin console and the customer app never share a session. */
const portalForRole = (role?: string): Portal => (role === 'SUPER_ADMIN' ? 'admin' : 'tenant');

/**
 * Sets the access cookie and, when a new one was issued, the refresh cookie.
 * Also expires the old refresh cookie that used to live at "/" so a browser never holds two.
 */
const setSessionCookies = (res: Response, role: string | undefined, accessToken: string, refreshToken?: string): void => {
  const portal = portalForRole(role);
  res.cookie(ACCESS_COOKIE[portal], accessToken, { ...baseCookie('/'), maxAge: ACCESS_COOKIE_MAX_AGE_MS });
  if (refreshToken) {
    res.cookie(REFRESH_COOKIE[portal], refreshToken, { ...baseCookie(REFRESH_COOKIE_PATH), maxAge: REFRESH_TOKEN_TTL_SEC * 1000 });
    res.clearCookie(REFRESH_COOKIE[portal], baseCookie('/'));
  }
};

const clearSessionCookies = (res: Response, portal: Portal): void => {
  res.clearCookie(ACCESS_COOKIE[portal], baseCookie('/'));
  res.clearCookie(REFRESH_COOKIE[portal], baseCookie(REFRESH_COOKIE_PATH));
  res.clearCookie(REFRESH_COOKIE[portal], baseCookie('/'));
};

/** Browsers get their tokens only in httpOnly cookies. Non-browser clients can ask for them in the body. */
const wantsTokensInBody = (req: Request): boolean =>
  (req.headers['x-token-delivery'] as string | undefined)?.toLowerCase() === 'body';

const sessionContext = (req: Request) => ({
  ip: clientIp(req),
  userAgent: (req.headers['user-agent'] as string | undefined) ?? '',
});

const noStore = (res: Response) => res.setHeader('Cache-Control', 'no-store');

const readRefreshToken = (req: Request, portal: Portal): string | undefined => {
  const fromCookie =
    portal === 'admin'
      ? req.cookies?.[REFRESH_COOKIE.admin] || req.cookies?.[REFRESH_COOKIE.tenant]
      : req.cookies?.[REFRESH_COOKIE.tenant];
  const fromBody = typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : undefined;
  const fromHeader = req.headers['x-refresh-token'] as string | undefined;
  return fromCookie || fromBody || fromHeader || undefined;
};

export class AuthController {
  private authService = new AuthService();

  register = async (req: Request, res: Response, next: NextFunction) => {
    try {
      noStore(res);
      const result = await this.authService.register(req.body);
      return sendSuccess(res, result);
    } catch (error) {
      next(error);
    }
  };

  login = async (req: Request, res: Response, next: NextFunction) => {
    try {
      noStore(res);
      const { email, password } = req.body;
      const result = await this.authService.login(email, password, sessionContext(req));

      setSessionCookies(res, result.user?.role, result.accessToken, result.refreshToken);

      return sendSuccess(res, {
        message: 'Login successful',
        user: result.user,
        ...(wantsTokensInBody(req) ? { accessToken: result.accessToken, refreshToken: result.refreshToken } : {}),
      });
    } catch (error) {
      next(error);
    }
  };

  refresh = async (req: Request, res: Response, next: NextFunction) => {
    const portal = resolvePortal(req);
    try {
      noStore(res);
      const refreshToken = readRefreshToken(req, portal);

      if (!refreshToken) {
        return res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'No refresh token provided' },
        });
      }

      const result = await this.authService.refresh(refreshToken);
      setSessionCookies(res, result.user?.role, result.accessToken, result.refreshToken);

      return sendSuccess(res, {
        message: 'Token refreshed successfully',
        user: result.user,
        ...(wantsTokensInBody(req) ? { accessToken: result.accessToken, refreshToken: result.refreshToken } : {}),
      });
    } catch (error: any) {
      // A definitive "no" means the cookies in the browser are dead: remove them so they cannot
      // linger and confuse the next sign-in. (503 = store down; the cookies may still be good.)
      if (error instanceof AppError && (error.statusCode === 401 || error.statusCode === 403)) {
        clearSessionCookies(res, portal);
      }
      logger.warn(`[auth] refresh failed: ${error?.code || ''} ${error?.message || error}`);
      next(error);
    }
  };

  logout = async (req: Request, res: Response, next: NextFunction) => {
    const portal = resolvePortal(req);
    try {
      noStore(res);
      let sid: string | undefined;

      const refreshToken = readRefreshToken(req, portal);
      if (refreshToken) sid = decodeRefreshTokenAllowExpired(refreshToken)?.sid;

      if (!sid) {
        const bearer = (req.headers.authorization || '').startsWith('Bearer ') ? req.headers.authorization!.slice(7) : undefined;
        const accessToken = req.cookies?.[ACCESS_COOKIE[portal]] || bearer;
        if (accessToken) sid = verifyToken(accessToken)?.sid;
      }

      try {
        await this.authService.logout(sid);
      } finally {
        // The browser is signed out locally even if the store was momentarily unreachable
        clearSessionCookies(res, portal);
      }

      return sendSuccess(res, { message: 'Logged out successfully' });
    } catch (error) {
      next(error);
    }
  };

  logoutAll = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const portal = resolvePortal(req);
    try {
      noStore(res);
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Not authenticated' });
      }
      try {
        await this.authService.logoutAll(userId);
      } finally {
        clearSessionCookies(res, portal);
      }
      return sendSuccess(res, { message: 'Signed out of all devices' });
    } catch (error) {
      next(error);
    }
  };

  me = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      noStore(res);
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Not authenticated' });
      }
      const result = await this.authService.getMe(userId);
      return sendSuccess(res, result);
    } catch (error) {
      next(error);
    }
  };

  updateProfile = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Not authenticated' });
      }
      const result = await this.authService.updateProfile(userId, req.body);
      return sendSuccess(res, result);
    } catch (error) {
      next(error);
    }
  };

  changePassword = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      noStore(res);
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Not authenticated' });
      }
      const { oldPassword, newPassword } = req.body;
      const result = await this.authService.changePassword(userId, oldPassword, newPassword, sessionContext(req));

      // Every other device was signed out; this device continues on a fresh session
      setSessionCookies(res, result.user?.role, result.accessToken, result.refreshToken);

      return sendSuccess(res, {
        message: result.message,
        ...(wantsTokensInBody(req) ? { accessToken: result.accessToken, refreshToken: result.refreshToken } : {}),
      });
    } catch (error) {
      next(error);
    }
  };

  forgotPassword = async (req: Request, res: Response, next: NextFunction) => {
    try {
      noStore(res);
      const { email } = req.body;
      const result = await this.authService.forgotPassword(email);
      return sendSuccess(res, result);
    } catch (error) {
      next(error);
    }
  };

  verifyResetOtp = async (req: Request, res: Response, next: NextFunction) => {
    try {
      noStore(res);
      const { email, otp } = req.body;
      const result = await this.authService.verifyResetOtp(email, otp);
      return sendSuccess(res, result);
    } catch (error) {
      next(error);
    }
  };

  resetPassword = async (req: Request, res: Response, next: NextFunction) => {
    try {
      noStore(res);
      const { email, resetToken, newPassword } = req.body;
      const result = await this.authService.resetPassword(email, resetToken, newPassword);
      return sendSuccess(res, result);
    } catch (error) {
      next(error);
    }
  };
}

export default AuthController;
