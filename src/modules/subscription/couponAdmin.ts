import { Coupon, DiscountType, Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { AppError } from '../../utils/AppError';

// Coupon management used by the admin console. The file is identical in alayn-backend and
// alayn-lite-backend: Alayn calls it directly, Alayn Lite through its internal coupon routes.

export type CouponStatus = 'ACTIVE' | 'DISABLED' | 'EXPIRED' | 'USED_UP';
export type CouponStatusFilter = 'ALL' | CouponStatus;

export interface CreateCouponInput {
  code: string;
  discountType: DiscountType;
  discountValue: number;
  isActive?: boolean;
  expiresAt?: string | null;
  usageLimit?: number | null;
  freeDurationDays?: number | null;
}

export type UpdateCouponInput = Partial<Omit<CreateCouponInput, 'code'>>;

type CouponWithCreator = Coupon & { createdBy?: { id: string; name: string; email: string } | null };

const hasSlotsLeft: Prisma.CouponWhereInput = {
  OR: [{ usageLimit: null }, { usageCount: { lt: prisma.coupon.fields.usageLimit } }],
};

/** Where-clause for coupons customers can redeem right now: enabled, not expired, slots left. */
export function redeemableCouponWhere(now: Date): Prisma.CouponWhereInput {
  return {
    AND: [{ isActive: true }, { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }, hasSlotsLeft],
  };
}

// Precedence matches computeCouponStatus: DISABLED, then EXPIRED, then USED_UP
function statusWhere(status: CouponStatusFilter, now: Date): Prisma.CouponWhereInput {
  const notExpired: Prisma.CouponWhereInput = { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
  switch (status) {
    case 'ACTIVE':
      return redeemableCouponWhere(now);
    case 'DISABLED':
      return { isActive: false };
    case 'EXPIRED':
      return { isActive: true, expiresAt: { lte: now } };
    case 'USED_UP':
      return { AND: [{ isActive: true }, notExpired, { usageCount: { gte: prisma.coupon.fields.usageLimit } }] };
    default:
      return {};
  }
}

export function computeCouponStatus(coupon: Coupon, now = new Date()): CouponStatus {
  if (!coupon.isActive) return 'DISABLED';
  if (coupon.expiresAt && coupon.expiresAt <= now) return 'EXPIRED';
  if (coupon.usageLimit && coupon.usageCount >= coupon.usageLimit) return 'USED_UP';
  return 'ACTIVE';
}

export function serializeCoupon(coupon: CouponWithCreator, now = new Date()) {
  return {
    id: coupon.id,
    code: coupon.code,
    discountType: coupon.discountType,
    discountValue: Number(coupon.discountValue),
    status: computeCouponStatus(coupon, now),
    isActive: coupon.isActive,
    expiresAt: coupon.expiresAt,
    usageLimit: coupon.usageLimit,
    usageCount: coupon.usageCount,
    freeDurationDays: coupon.freeDurationDays,
    createdAt: coupon.createdAt,
    updatedAt: coupon.updatedAt,
    createdBy: coupon.createdBy
      ? { id: coupon.createdBy.id, name: coupon.createdBy.name, email: coupon.createdBy.email }
      : null,
  };
}

function assertPercentageCap(discountType: DiscountType, discountValue: number) {
  if (discountType === DiscountType.PERCENTAGE && discountValue > 100) {
    throw new AppError('BAD_REQUEST', 'Percentage discount cannot exceed 100%', 400);
  }
}

export async function listCoupons(params: {
  page: number;
  limit: number;
  status: CouponStatusFilter;
  search?: string;
}) {
  const { page, limit, status, search } = params;
  const now = new Date();
  const where: Prisma.CouponWhereInput = {
    AND: [statusWhere(status, now), search ? { code: { contains: search.toUpperCase() } } : {}],
  };

  const [total, coupons] = await Promise.all([
    prisma.coupon.count({ where }),
    prisma.coupon.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: { createdBy: { select: { id: true, name: true, email: true } } },
    }),
  ]);

  return {
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    items: coupons.map((c) => serializeCoupon(c, now)),
  };
}

export async function createCoupon(data: CreateCouponInput, createdById: string | null) {
  const code = data.code.trim().toUpperCase();

  if (await prisma.coupon.findUnique({ where: { code } })) {
    throw new AppError('CONFLICT', `Coupon code "${code}" already exists. Please choose a unique code.`, 409);
  }

  assertPercentageCap(data.discountType, data.discountValue);

  const expiresAt = data.expiresAt ? new Date(data.expiresAt) : null;
  if (expiresAt && expiresAt <= new Date()) {
    throw new AppError('BAD_REQUEST', 'Coupon expiration date must be in the future', 400);
  }

  const coupon = await prisma.coupon.create({
    data: {
      code,
      discountType: data.discountType,
      discountValue: new Prisma.Decimal(data.discountValue),
      isActive: data.isActive ?? true,
      expiresAt,
      usageLimit: data.usageLimit ?? null,
      freeDurationDays: data.freeDurationDays ?? null,
      createdById,
    },
  });
  return serializeCoupon(coupon);
}

export async function updateCoupon(id: string, data: UpdateCouponInput) {
  const existing = await prisma.coupon.findUnique({ where: { id } });
  if (!existing) {
    throw new AppError('NOT_FOUND', 'Coupon not found', 404);
  }

  // Validate the coupon as it will be after the update, not the fields that happen to be sent
  assertPercentageCap(
    data.discountType ?? existing.discountType,
    data.discountValue ?? Number(existing.discountValue)
  );

  const payload: Prisma.CouponUpdateInput = {};
  if (data.discountType !== undefined) payload.discountType = data.discountType;
  if (data.discountValue !== undefined) payload.discountValue = new Prisma.Decimal(data.discountValue);
  if (data.isActive !== undefined) payload.isActive = data.isActive;
  if (data.expiresAt !== undefined) payload.expiresAt = data.expiresAt ? new Date(data.expiresAt) : null;
  if (data.usageLimit !== undefined) payload.usageLimit = data.usageLimit;
  if (data.freeDurationDays !== undefined) payload.freeDurationDays = data.freeDurationDays;

  return serializeCoupon(await prisma.coupon.update({ where: { id }, data: payload }));
}

export async function deleteCoupon(id: string) {
  const existing = await prisma.coupon.findUnique({ where: { id } });
  if (!existing) {
    throw new AppError('NOT_FOUND', 'Coupon not found', 404);
  }

  // Soft toggle isActive or remove if no payments or redemptions attached
  const [paymentsCount, redemptionsCount] = await Promise.all([
    prisma.subscriptionPayment.count({ where: { couponId: id } }),
    prisma.couponRedemption.count({ where: { couponId: id } }),
  ]);

  if (paymentsCount > 0 || redemptionsCount > 0) {
    return serializeCoupon(await prisma.coupon.update({ where: { id }, data: { isActive: false } }));
  }

  return serializeCoupon(await prisma.coupon.delete({ where: { id } }));
}
