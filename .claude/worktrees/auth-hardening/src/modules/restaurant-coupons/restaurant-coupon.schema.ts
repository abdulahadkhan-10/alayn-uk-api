import { z } from 'zod';

export const createRestaurantCouponSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2, 'Coupon code must be at least 2 characters')
    .max(30, 'Coupon code must be at most 30 characters')
    .regex(/^[A-Za-z0-9_-]+$/, 'Coupon code can only contain letters, numbers, hyphens, and underscores')
    .transform((val) => val.toUpperCase()),
  description: z.string().trim().max(255).optional(),
  discountType: z.enum(['PERCENTAGE', 'FIXED_AMOUNT']).default('PERCENTAGE'),
  discountValue: z.number().positive('Discount value must be greater than 0'),
  minOrderAmount: z.number().nonnegative().optional(),
  maxDiscountAmount: z.number().nonnegative().optional(),
  expiresAt: z.string().datetime({ offset: true }).optional().nullable().or(z.string().optional()),
  usageLimit: z.number().int().positive().optional().nullable(),
  outletId: z.string().uuid().optional().nullable(),
}).refine((data) => {
  if (data.discountType === 'PERCENTAGE' && data.discountValue > 100) {
    return false;
  }
  return true;
}, {
  message: 'Percentage discount cannot exceed 100%',
  path: ['discountValue'],
});

export const updateRestaurantCouponSchema = z.object({
  isActive: z.boolean().optional(),
  description: z.string().trim().max(255).optional(),
  usageLimit: z.number().int().positive().optional().nullable(),
  expiresAt: z.string().datetime({ offset: true }).optional().nullable().or(z.string().optional().nullable()),
});

export const validateRestaurantCouponSchema = z.object({
  code: z.string().trim().min(1, 'Coupon code is required').transform((v) => v.toUpperCase()),
  subtotalAmount: z.number().nonnegative().optional(),
  subtotalPaise: z.number().int().nonnegative().optional(),
  outletId: z.string().uuid().optional(),
});
