import { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/AppError';
import { prisma } from '../config/prisma';
import { verifyToken } from '../utils/jwt';
import { isSessionActive } from '../modules/auth/session.store';
import { resolvePortal, ACCESS_COOKIE } from '../utils/identity';

export interface UserPayload {
  id: string;
  email: string;
  role: 'SUPER_ADMIN' | 'BUSINESS_OWNER' | 'MANAGER' | 'STAFF' | 'KITCHEN' | 'SUPPLIER';
  name: string;
  businessId?: string | null;
  supplierId?: string | null;
  phoneNo?: string | null;
  /** The login session this request belongs to. */
  sid?: string;
}

export interface AuthenticatedRequest extends Request {
  user?: UserPayload;
  outletId?: string;
  businessId?: string;
}

// Extend Express Request interface globally
declare global {
  namespace Express {
    interface Request {
      user?: UserPayload;
      outletId?: string;
      businessId?: string;
    }
  }
}

/**
 * Pulls the access token from the right cookie for the calling app (customer or admin console),
 * falling back to an Authorization header for non-browser clients.
 */
export function readAccessToken(req: Request): string | undefined {
  const portal = resolvePortal(req);
  let token: string | undefined =
    portal === 'admin'
      ? req.cookies?.[ACCESS_COOKIE.admin] || req.cookies?.[ACCESS_COOKIE.tenant]
      : req.cookies?.[ACCESS_COOKIE.tenant];

  if (!token) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    }
  }
  return token;
}

/**
 * Authenticates a request. A valid signature alone is NOT enough:
 *   1. the login session named in the token must still exist in Redis (so logout, password change,
 *      "sign out everywhere" and token-reuse detection take effect immediately), and
 *   2. the account must still be active, and its role/business are read fresh from the database
 *      (so a demotion applies at once, not when the 15-minute token expires).
 */
export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const token = readAccessToken(req);
  if (!token) {
    return next(new AppError('UNAUTHORIZED', 'No authentication token provided', 401));
  }

  const decoded = verifyToken(token);
  if (!decoded || !decoded.id || !decoded.sid) {
    return next(new AppError('UNAUTHORIZED', 'Invalid or expired token', 401));
  }

  try {
    if (!(await isSessionActive(decoded.sid, decoded.id))) {
      return next(new AppError('SESSION_ENDED', 'Your session has ended. Please sign in again.', 401));
    }

    const account = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: { id: true, email: true, name: true, role: true, businessId: true, phoneNo: true, isActive: true, deletedAt: true },
    });
    if (!account || !account.isActive || account.deletedAt) {
      return next(new AppError('ACCOUNT_DISABLED', 'Your account has been deactivated. Please contact your manager.', 401));
    }

    req.user = {
      id: account.id,
      email: account.email,
      name: account.name,
      role: account.role as UserPayload['role'],
      businessId: account.businessId,
      phoneNo: account.phoneNo,
      sid: decoded.sid,
    };
    if (account.businessId) {
      req.businessId = account.businessId;
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

export default authMiddleware;
