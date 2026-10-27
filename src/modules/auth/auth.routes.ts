import { Router } from 'express';
import { AuthController } from './auth.controller';
import { validate } from '../../middleware/validate.middleware';
import { rateLimit, clientIp, bodyEmail } from '../../middleware/rateLimit';
import {
  loginSchema,
  registerSchema,
  forgotPasswordSchema,
  verifyResetOtpSchema,
  resetPasswordSchema,
  changePasswordSchema,
  updateProfileSchema,
} from './auth.schema';
import authMiddleware from '../../middleware/auth.middleware';

const router = Router();
const controller = new AuthController();

const MIN = 60;
const QUARTER_HOUR = 15 * MIN;
const HOUR = 60 * MIN;

// Brute-force guards. Counters live in Redis, so they are shared by every server instance and
// survive restarts. Failed logins only: successful sign-ins are not counted.
const loginLimiters = [
  // One attacker hammering one account
  rateLimit({
    name: 'login:ip-email',
    windowSec: QUARTER_HOUR,
    max: 10,
    skipSuccessful: true,
    key: (req) => `${clientIp(req)}:${bodyEmail(req)}`,
    message: 'Too many failed login attempts. Please try again after 15 minutes.',
  }),
  // One attacker spraying many accounts
  rateLimit({
    name: 'login:ip',
    windowSec: QUARTER_HOUR,
    max: 100,
    skipSuccessful: true,
    key: (req) => clientIp(req),
    message: 'Too many failed login attempts from this network. Please try again later.',
  }),
  // Many attackers (distributed) against one account
  rateLimit({
    name: 'login:email',
    windowSec: HOUR,
    max: 60,
    skipSuccessful: true,
    key: (req) => bodyEmail(req) || null,
    message: 'Too many failed login attempts for this account. Please try again later or reset your password.',
  }),
];

const registerLimiter = rateLimit({
  name: 'register:ip',
  windowSec: HOUR,
  max: 10,
  key: (req) => clientIp(req),
  message: 'Too many sign-up attempts. Please try again later.',
});

const refreshLimiter = rateLimit({
  name: 'refresh:ip',
  windowSec: MIN,
  max: 120,
  key: (req) => clientIp(req),
});

const forgotPasswordLimiters = [
  rateLimit({
    name: 'forgot:ip',
    windowSec: QUARTER_HOUR,
    max: 5,
    key: (req) => clientIp(req),
    message: 'Too many password reset requests. Please try again after 15 minutes.',
  }),
  rateLimit({
    name: 'forgot:email',
    windowSec: HOUR,
    max: 5,
    key: (req) => bodyEmail(req) || null,
    message: 'Too many password reset requests for this email. Please try again later.',
  }),
];

const verifyOtpLimiters = [
  rateLimit({
    name: 'otp:ip',
    windowSec: QUARTER_HOUR,
    max: 30,
    key: (req) => clientIp(req),
    message: 'Too many verification attempts. Please try again later.',
  }),
  rateLimit({
    name: 'otp:email',
    windowSec: QUARTER_HOUR,
    max: 15,
    key: (req) => bodyEmail(req) || null,
    message: 'Too many verification attempts for this email. Please request a new code later.',
  }),
];

const resetPasswordLimiter = rateLimit({
  name: 'reset:ip',
  windowSec: QUARTER_HOUR,
  max: 10,
  key: (req) => clientIp(req),
  message: 'Too many password reset attempts. Please try again later.',
});

const changePasswordLimiter = rateLimit({
  name: 'change-password:user',
  windowSec: QUARTER_HOUR,
  max: 10,
  key: (req) => req.user?.id ?? clientIp(req),
  message: 'Too many password change attempts. Please try again later.',
});

router.post('/login', ...loginLimiters, validate({ body: loginSchema }), controller.login);
router.post('/refresh', refreshLimiter, controller.refresh);
router.post('/logout', refreshLimiter, controller.logout);
router.post('/register', registerLimiter, validate({ body: registerSchema }), controller.register);
router.get('/me', authMiddleware, controller.me);
router.patch('/profile', authMiddleware, validate({ body: updateProfileSchema }), controller.updateProfile);
router.post('/change-password', authMiddleware, changePasswordLimiter, validate({ body: changePasswordSchema }), controller.changePassword);
router.post('/logout-all', authMiddleware, controller.logoutAll);

// Public OTP-based password reset routes
router.post('/forgot-password', ...forgotPasswordLimiters, validate({ body: forgotPasswordSchema }), controller.forgotPassword);
router.post('/verify-reset-otp', ...verifyOtpLimiters, validate({ body: verifyResetOtpSchema }), controller.verifyResetOtp);
router.post('/reset-password', resetPasswordLimiter, validate({ body: resetPasswordSchema }), controller.resetPassword);

export default router;
