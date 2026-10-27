import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '../config/env';

const ISSUER = 'alayn-api';
const ACCESS_AUDIENCE = 'alayn-access';
const REFRESH_AUDIENCE = 'alayn-refresh';
const ALGORITHMS: jwt.Algorithm[] = ['HS256'];

/** Access tokens are short-lived; the session behind them is checked on every request. */
export const ACCESS_TOKEN_TTL = '15m';

/** How long an idle login survives: 15 days in production, 30 elsewhere (unchanged behaviour). */
export const REFRESH_TOKEN_TTL_SEC = (env.NODE_ENV === 'production' ? 15 : 30) * 24 * 60 * 60;

/** Absolute lifetime of one login no matter how often it is refreshed. */
export const SESSION_MAX_AGE_SEC = env.SESSION_MAX_DAYS * 24 * 60 * 60;

export const generateToken = (payload: object, expiresIn: SignOptions['expiresIn'] = ACCESS_TOKEN_TTL): string => {
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn,
    algorithm: 'HS256',
    issuer: ISSUER,
    audience: ACCESS_AUDIENCE,
  });
};

export const verifyToken = (token: string): any => {
  try {
    return jwt.verify(token, env.JWT_SECRET, { algorithms: ALGORITHMS, issuer: ISSUER, audience: ACCESS_AUDIENCE });
  } catch {
    return null;
  }
};

export const generateRefreshToken = (payload: object, expiresInSec: number = REFRESH_TOKEN_TTL_SEC): string => {
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, {
    expiresIn: expiresInSec,
    algorithm: 'HS256',
    issuer: ISSUER,
    audience: REFRESH_AUDIENCE,
  });
};

export const verifyRefreshToken = (token: string): any => {
  try {
    return jwt.verify(token, env.JWT_REFRESH_SECRET, { algorithms: ALGORITHMS, issuer: ISSUER, audience: REFRESH_AUDIENCE });
  } catch {
    return null;
  }
};

/**
 * Reads a refresh token's claims even when it has expired, so logout can still end the right session.
 * The signature is always checked.
 */
export const decodeRefreshTokenAllowExpired = (token: string): any => {
  try {
    return jwt.verify(token, env.JWT_REFRESH_SECRET, {
      algorithms: ALGORITHMS,
      issuer: ISSUER,
      audience: REFRESH_AUDIENCE,
      ignoreExpiration: true,
    });
  } catch {
    return null;
  }
};
