import { z } from 'zod';

const email = z
  .string({ required_error: 'Email is required' })
  .trim()
  .toLowerCase()
  .email('Please enter a valid email address')
  .max(254);

/**
 * Policy for any NEW password (signup, change, reset). Existing accounts keep working with whatever
 * they had: login only checks that something was sent, never the policy.
 */
export const newPasswordSchema = z
  .string({ required_error: 'Password is required' })
  .min(8, 'Password must be at least 8 characters long')
  .max(128, 'Password must be at most 128 characters long')
  .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), 'Password must contain at least one letter and one number');

export const loginSchema = z.object({
  email,
  password: z.string({ required_error: 'Password is required' }).min(1, 'Password is required').max(128),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

export const registerSchema = z.object({
  user: z.object({
    name: z.string().trim().min(2).max(100),
    email,
    password: newPasswordSchema,
    phoneNo: z.string().trim().min(10).max(20),
  }),

  business: z.object({
    name: z.string().trim().min(2).max(150),
    locationsCount: z.string().trim().min(1).max(20),
    businessType: z.string().trim().min(2).max(100),
    contactDetail: z.string().trim().min(10).max(100),
  }),

  // Promotional codes are managed in the database and applied when a branch is created or a plan is
  // bought. They are not accepted at signup; the field is only kept so old clients get a clear message.
  couponCode: z.string().optional(),
});

export const forgotPasswordSchema = z.object({
  email,
});

export const verifyResetOtpSchema = z.object({
  email,
  otp: z.string().trim().regex(/^\d{6}$/, 'Verification code must be exactly 6 digits'),
});

export const resetPasswordSchema = z.object({
  email,
  resetToken: z.string().trim().min(1, 'Reset token is required').max(200),
  newPassword: newPasswordSchema,
});

export const changePasswordSchema = z.object({
  oldPassword: z.string({ required_error: 'Current password is required' }).min(1, 'Current password is required').max(128),
  newPassword: newPasswordSchema,
});

export const updateProfileSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  phoneNo: z.string().trim().min(10).max(20).optional(),
});
