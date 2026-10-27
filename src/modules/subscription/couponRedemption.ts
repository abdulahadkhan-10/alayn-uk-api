import { Coupon, DiscountType, OutletSubscriptionStatus, Prisma } from '@prisma/client';
import { AppError } from '../../utils/AppError';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_FREE_DAYS = 365;

export const couponPlanCode = (code: string) => `COUPON_${code}`;

export function isFreeCoupon(coupon: Pick<Coupon, 'discountType' | 'discountValue'>) {
  return coupon.discountType === DiscountType.PERCENTAGE && Number(coupon.discountValue) >= 100;
}

/** Throws unless the coupon can still be redeemed right now (enabled, not expired, slots left). */
export function assertCouponRedeemable(coupon: Coupon | null): asserts coupon is Coupon {
  if (!coupon || !coupon.isActive) {
    throw new AppError('INVALID_COUPON', 'Invalid or inactive coupon code.', 400);
  }
  if (coupon.expiresAt && coupon.expiresAt <= new Date()) {
    throw new AppError('EXPIRED_COUPON', 'This coupon code has expired.', 400);
  }
  if (coupon.usageLimit && coupon.usageCount >= coupon.usageLimit) {
    throw new AppError('COUPON_LIMIT_REACHED', 'This coupon code has reached its maximum redemption limit.', 400);
  }
}

/**
 * Atomically takes one of the coupon's slots. The usage check and the increment happen in a single
 * UPDATE, so concurrent redemptions can never push usageCount past usageLimit. Returns false when no
 * slot was left.
 */
export async function claimCouponSlot(tx: Prisma.TransactionClient, coupon: Coupon) {
  const claimed = await tx.coupon.updateMany({
    where: {
      id: coupon.id,
      ...(coupon.usageLimit ? { usageCount: { lt: coupon.usageLimit } } : {}),
    },
    data: { usageCount: { increment: 1 } },
  });
  return claimed.count === 1;
}

/**
 * Redeems a 100% coupon for exactly one outlet of a business, inside the caller's transaction.
 * The single place every free-coupon path goes through, so the rules cannot drift apart:
 * - the outlet must belong to the business,
 * - each business redeems a given coupon once (CouponRedemption unique key),
 * - slots are claimed atomically,
 * - only that outlet is activated; the business-level subscription is never touched.
 */
export async function redeemFreeCoupon(
  tx: Prisma.TransactionClient,
  params: { coupon: Coupon; businessId: string; outletId: string }
) {
  const { coupon, businessId, outletId } = params;
  assertCouponRedeemable(coupon);

  const outlet = await tx.outlet.findFirst({
    where: { id: outletId, businessId, deletedAt: null },
    select: { id: true },
  });
  if (!outlet) {
    throw new AppError('OUTLET_NOT_FOUND', 'Outlet not found under your business.', 404);
  }

  const previous = await tx.couponRedemption.findUnique({
    where: { couponId_businessId: { couponId: coupon.id, businessId } },
    include: { outlet: { select: { name: true } } },
  });
  if (previous) {
    const branchName = previous.outlet?.name || 'an existing branch';
    throw new AppError(
      'COUPON_ALREADY_USED',
      `Your business has already redeemed this promotional coupon for "${branchName}". Each business is limited to 1 free promotional branch. Additional branches require a paid subscription.`,
      400
    );
  }

  try {
    await tx.couponRedemption.create({ data: { couponId: coupon.id, businessId, outletId } });
  } catch (error) {
    // A concurrent request from the same business won the unique key between the check above and here
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new AppError('COUPON_ALREADY_USED', 'Your business has already redeemed this promotional coupon.', 400);
    }
    throw error;
  }

  if (!(await claimCouponSlot(tx, coupon))) {
    throw new AppError('COUPON_LIMIT_REACHED', 'This coupon code has reached its maximum redemption limit.', 400);
  }

  // Free access never shortens time the outlet already has
  const now = new Date();
  const existing = await tx.outletSubscription.findUnique({ where: { outletId } });
  const activeUntil =
    existing && existing.status === OutletSubscriptionStatus.ACTIVE && existing.currentPeriodEnd > now
      ? existing.currentPeriodEnd
      : null;

  let freeUntil: Date;
  if (coupon.freeDurationDays) {
    freeUntil = new Date((activeUntil ?? now).getTime() + coupon.freeDurationDays * DAY_MS);
  } else {
    const fixedEnd = coupon.expiresAt || new Date(now.getTime() + DEFAULT_FREE_DAYS * DAY_MS);
    freeUntil = activeUntil && activeUntil > fixedEnd ? activeUntil : fixedEnd;
  }

  const planCode = couponPlanCode(coupon.code);
  const promo = {
    status: OutletSubscriptionStatus.ACTIVE,
    planCode,
    planName: `${coupon.code} VIP Promo Access`,
    monthlyFeePaise: 0,
    taxRatePercent: 0,
    currency: 'INR',
    currentPeriodEnd: freeUntil,
    autoRenew: false,
  };

  const outletSubscription = await tx.outletSubscription.upsert({
    where: { outletId },
    create: { outletId, businessId, currentPeriodStart: now, ...promo },
    update: { currentPeriodStart: existing && activeUntil ? existing.currentPeriodStart : now, ...promo },
  });

  return { outletSubscription, freeUntil };
}
