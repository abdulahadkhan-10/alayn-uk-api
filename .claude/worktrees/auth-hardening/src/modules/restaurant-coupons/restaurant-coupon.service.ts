import { prisma } from '../../config/prisma';
import { AppError } from '../../utils/AppError';
import { Prisma } from '@prisma/client';

export interface CreateCouponInput {
  code: string;
  description?: string;
  discountType: 'PERCENTAGE' | 'FIXED_AMOUNT';
  discountValue: number;
  minOrderAmount?: number;
  maxDiscountAmount?: number;
  expiresAt?: string | null;
  usageLimit?: number | null;
  outletId?: string | null;
}

export class RestaurantCouponService {
  /**
   * Format coupon entity for API response
   */
  private transformCoupon(coupon: any) {
    return {
      id: coupon.id,
      businessId: coupon.businessId,
      outletId: coupon.outletId,
      outletName: coupon.outlet?.name || null,
      code: coupon.code,
      description: coupon.description,
      discountType: coupon.discountType,
      discountValue: Number(coupon.discountValue),
      minOrderAmount: coupon.minOrderPaise ? coupon.minOrderPaise / 100 : null,
      maxDiscountAmount: coupon.maxDiscountPaise ? coupon.maxDiscountPaise / 100 : null,
      isActive: coupon.isActive,
      expiresAt: coupon.expiresAt,
      usageLimit: coupon.usageLimit,
      usageCount: coupon.usageCount,
      createdById: coupon.createdById,
      createdByName: coupon.createdBy?.name || null,
      createdAt: coupon.createdAt,
      updatedAt: coupon.updatedAt,
    };
  }

  /**
   * Create a new coupon for a business/outlet
   */
  async createCoupon(businessId: string, createdById: string, data: CreateCouponInput) {
    const formattedCode = data.code.trim().toUpperCase();

    // Check if code already exists for this business
    const existing = await prisma.restaurantCoupon.findUnique({
      where: {
        businessId_code: {
          businessId,
          code: formattedCode,
        },
      },
    });

    if (existing) {
      throw new AppError('COUPON_ALREADY_EXISTS', `A coupon with code "${formattedCode}" already exists`, 409);
    }

    const minOrderPaise = data.minOrderAmount != null ? Math.round(data.minOrderAmount * 100) : null;
    const maxDiscountPaise = data.maxDiscountAmount != null ? Math.round(data.maxDiscountAmount * 100) : null;
    const expiresAt = data.expiresAt ? new Date(data.expiresAt) : null;

    const coupon = await prisma.restaurantCoupon.create({
      data: {
        businessId,
        outletId: data.outletId || null,
        code: formattedCode,
        description: data.description || null,
        discountType: data.discountType,
        discountValue: new Prisma.Decimal(data.discountValue),
        minOrderPaise,
        maxDiscountPaise,
        expiresAt,
        usageLimit: data.usageLimit || null,
        createdById,
      },
      include: {
        outlet: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
      },
    });

    return this.transformCoupon(coupon);
  }

  /**
   * Get all coupons for a business (optionally filtered by outlet)
   */
  async getCoupons(businessId: string, outletId?: string) {
    const whereClause: Prisma.RestaurantCouponWhereInput = {
      businessId,
    };

    if (outletId && outletId !== 'all') {
      whereClause.OR = [
        { outletId: null },
        { outletId },
      ];
    }

    const coupons = await prisma.restaurantCoupon.findMany({
      where: whereClause,
      include: {
        outlet: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return coupons.map((c) => this.transformCoupon(c));
  }

  /**
   * Toggle active status of a coupon
   */
  async toggleCouponStatus(businessId: string, couponId: string, isActive?: boolean) {
    const coupon = await prisma.restaurantCoupon.findFirst({
      where: { id: couponId, businessId },
    });

    if (!coupon) {
      throw new AppError('COUPON_NOT_FOUND', 'Coupon not found', 404);
    }

    const newStatus = typeof isActive === 'boolean' ? isActive : !coupon.isActive;

    const updated = await prisma.restaurantCoupon.update({
      where: { id: couponId },
      data: { isActive: newStatus },
      include: {
        outlet: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
      },
    });

    return this.transformCoupon(updated);
  }

  /**
   * Delete a coupon
   */
  async deleteCoupon(businessId: string, couponId: string) {
    const coupon = await prisma.restaurantCoupon.findFirst({
      where: { id: couponId, businessId },
      include: {
        _count: { select: { orders: true } },
      },
    });

    if (!coupon) {
      throw new AppError('COUPON_NOT_FOUND', 'Coupon not found', 404);
    }

    // If coupon has recorded orders, soft-deactivate instead of hard deleting to preserve order history
    if (coupon._count.orders > 0) {
      const updated = await prisma.restaurantCoupon.update({
        where: { id: couponId },
        data: { isActive: false },
      });
      return { message: 'Coupon has recorded orders so it was deactivated instead of deleted', coupon: this.transformCoupon(updated) };
    }

    await prisma.restaurantCoupon.delete({
      where: { id: couponId },
    });

    return { message: 'Coupon deleted successfully' };
  }

  /**
   * High-performance verification of coupon at bill settlement
   */
  async validateCoupon(businessId: string, outletId: string, code: string, subtotalPaise: number) {
    const formattedCode = code.trim().toUpperCase();

    // 1. Direct index seek
    const coupon = await prisma.restaurantCoupon.findUnique({
      where: {
        businessId_code: {
          businessId,
          code: formattedCode,
        },
      },
    });

    if (!coupon) {
      throw new AppError('COUPON_NOT_FOUND', 'Coupon code does not exist', 404);
    }

    // 2. Branch applicability check
    if (coupon.outletId && coupon.outletId !== outletId) {
      throw new AppError('COUPON_NOT_APPLICABLE', 'This coupon is not valid for this restaurant branch', 400);
    }

    // 3. Active status check
    if (!coupon.isActive) {
      throw new AppError('COUPON_INACTIVE', 'This coupon is currently inactive', 400);
    }

    // 4. Expiration check
    if (coupon.expiresAt && new Date() > coupon.expiresAt) {
      throw new AppError('COUPON_EXPIRED', 'This coupon has expired', 400);
    }

    // 5. Usage limit check
    if (coupon.usageLimit != null && coupon.usageCount >= coupon.usageLimit) {
      throw new AppError('COUPON_LIMIT_REACHED', 'This coupon has reached its maximum usage limit', 400);
    }

    // 6. Minimum order value check
    if (coupon.minOrderPaise != null && subtotalPaise < coupon.minOrderPaise) {
      const minAmountRupees = (coupon.minOrderPaise / 100).toFixed(0);
      throw new AppError(
        'MIN_ORDER_NOT_MET',
        `Minimum order amount of ₹${minAmountRupees} required for coupon ${formattedCode}`,
        400
      );
    }

    // 7. Calculate exact discount in paise
    let discountPaise = 0;
    if (coupon.discountType === 'PERCENTAGE') {
      const rate = Number(coupon.discountValue);
      discountPaise = Math.round((subtotalPaise * rate) / 100);
      if (coupon.maxDiscountPaise != null) {
        discountPaise = Math.min(discountPaise, coupon.maxDiscountPaise);
      }
    } else {
      // FIXED_AMOUNT
      discountPaise = Math.round(Number(coupon.discountValue) * 100);
    }

    // Discount can never exceed subtotal
    discountPaise = Math.min(discountPaise, subtotalPaise);

    return {
      valid: true,
      couponId: coupon.id,
      code: coupon.code,
      discountType: coupon.discountType,
      discountValue: Number(coupon.discountValue),
      discountPaise,
      discountAmount: discountPaise / 100,
      description: coupon.description,
      minOrderAmount: coupon.minOrderPaise ? coupon.minOrderPaise / 100 : null,
      maxDiscountAmount: coupon.maxDiscountPaise ? coupon.maxDiscountPaise / 100 : null,
    };
  }
}
