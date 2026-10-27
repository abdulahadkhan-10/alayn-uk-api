import { prisma } from '../../config/prisma';
import { Prisma, OutletSubscriptionStatus } from '@prisma/client';
import { AppError } from '../../utils/AppError';
import { assertCouponRedeemable, isFreeCoupon, redeemFreeCoupon } from '../subscription/couponRedemption';

export class OutletRepository {
  async createOutlet(businessId: string, userId: string, data: {
    name: string;
    address: string;
    city: string;
    state: string;
    country: string;
    couponCode?: string;
    kitchenMode?: string;
  }) {
    const { couponCode, ...outletFields } = data;

    return prisma.$transaction(async (tx) => {
      const outlet = await tx.outlet.create({
        data: {
          businessId,
          ...outletFields,
        },
      });

      await tx.userOutlet.create({
        data: {
          userId,
          outletId: outlet.id,
        },
      });

      // 1. Process promotional coupon if entered
      const normalizedCoupon = (couponCode || '').trim().toUpperCase();
      let outletSub = null;

      if (normalizedCoupon) {
        const dbCoupon = await tx.coupon.findUnique({
          where: { code: normalizedCoupon },
        });
        assertCouponRedeemable(dbCoupon);

        // 100% free coupons go through the shared redemption rules (one free branch per business)
        if (isFreeCoupon(dbCoupon)) {
          ({ outletSubscription: outletSub } = await redeemFreeCoupon(tx, {
            coupon: dbCoupon,
            businessId,
            outletId: outlet.id,
          }));
        }
      }

      if (!outletSub) {
        // Standard Outlet Creation (no coupon or partial discount branch):
        // Each outlet requires its own subscription. New outlets start in PENDING_PAYMENT.
        outletSub = await tx.outletSubscription.create({
          data: {
            outletId: outlet.id,
            businessId,
            status: OutletSubscriptionStatus.PENDING_PAYMENT,
            planCode: 'MONTHLY_STANDARD',
            planName: 'Standard Monthly Pro',
            monthlyFeePaise: 199900,
            taxRatePercent: 18.0,
            currency: 'INR',
            currentPeriodStart: new Date(),
            currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            autoRenew: true,
          },
        });
      }

      return {
        ...outlet,
        subscription: outletSub,
      };
    });
  }

  async getOutletsByBusiness(businessId: string) {
    return prisma.outlet.findMany({
      where: { businessId, deletedAt: null },
      include: {
        subscription: true,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async getOutletsByUser(userId: string, businessId?: string) {
    return prisma.outlet.findMany({
      where: {
        ...(businessId ? { businessId } : {}),
        deletedAt: null,
        users: {
          some: { userId },
        },
      },
      include: {
        subscription: true,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async getHolidays(outletId: string) {
    return prisma.outletHoliday.findMany({
      where: { outletId },
      orderBy: { date: 'asc' },
    });
  }

  async createHoliday(outletId: string, name: string, date: Date, applyToAllOutlets?: boolean) {
    if (applyToAllOutlets) {
      const currentOutlet = await prisma.outlet.findUnique({ where: { id: outletId } });
      if (currentOutlet) {
        const allOutlets = await prisma.outlet.findMany({
          where: { businessId: currentOutlet.businessId, deletedAt: null },
        });
        const promises = allOutlets.map((o) =>
          prisma.outletHoliday.upsert({
            where: { outletId_date: { outletId: o.id, date } },
            update: { name },
            create: { outletId: o.id, name, date },
          })
        );
        return Promise.all(promises);
      }
    }
    return prisma.outletHoliday.upsert({
      where: { outletId_date: { outletId, date } },
      update: { name },
      create: {
        outletId,
        name,
        date,
      },
    });
  }

  async deleteHoliday(outletId: string, id: string) {
    return prisma.outletHoliday.delete({
      where: { id },
    });
  }

  async updateOperatingDays(outletId: string, operatingDays: string[]) {
    return prisma.outlet.update({
      where: { id: outletId },
      data: {
        operatingDays: JSON.stringify(operatingDays),
      },
    });
  }

  async updateTaxRates(
    outletId: string,
    cgstRateDecimal: number,
    sgstRateDecimal: number,
    serviceTaxRateDecimal: number = 0,
    businessId?: string,
    gstRegistrationType?: 'REGULAR' | 'COMPOSITION' | 'UNREGISTERED'
  ) {
    const updateData: Record<string, any> = {
      cgstRateDecimal,
      sgstRateDecimal,
      serviceTaxRateDecimal,
      ...(gstRegistrationType ? { gstRegistrationType } : {}),
    };
    if (outletId === "all" && businessId) {
      return prisma.outlet.updateMany({
        where: { businessId, deletedAt: null },
        data: updateData,
      });
    }
    return prisma.outlet.update({
      where: { id: outletId },
      data: updateData,
    });
  }

  async updateReceiptDetails(
    outletId: string,
    data: { phone?: string; gstin?: string; receiptTagline?: string; receiptFooter?: string; upiId?: string },
    businessId?: string
  ) {
    const updateData: Record<string, any> = {};
    if (data.phone !== undefined) updateData.phone = data.phone;
    if (data.gstin !== undefined) updateData.gstin = data.gstin;
    if (data.receiptTagline !== undefined) updateData.receiptTagline = data.receiptTagline;
    if (data.receiptFooter !== undefined) updateData.receiptFooter = data.receiptFooter;
    if (data.upiId !== undefined) updateData.upiId = data.upiId;

    if (outletId === "all" && businessId) {
      return prisma.outlet.updateMany({
        where: { businessId, deletedAt: null },
        data: updateData,
      });
    }
    return prisma.outlet.update({
      where: { id: outletId },
      data: updateData,
    });
  }

  async updateLocation(
    outletId: string,
    latitude: number,
    longitude: number,
    geofenceRadius: number,
    businessId?: string
  ) {
    const updateData: any = { latitude, longitude, geofenceRadius };
    
    if (outletId === "all" && businessId) {
      return prisma.outlet.updateMany({
        where: { businessId, deletedAt: null },
        data: updateData,
      });
    }
    return prisma.outlet.update({
      where: { id: outletId },
      data: updateData,
    });
  }

  async updateAttendanceRules(
    outletId: string,
    data: { earlyBufferMinutes: number; lateGraceMinutes: number },
    businessId?: string
  ) {
    const updateData = {
      earlyBufferMinutes: data.earlyBufferMinutes,
      lateGraceMinutes: data.lateGraceMinutes,
    };

    if (outletId === "all" && businessId) {
      return prisma.outlet.updateMany({
        where: { businessId, deletedAt: null },
        data: updateData,
      });
    }
    return prisma.outlet.update({
      where: { id: outletId },
      data: updateData,
    });
  }

  async updateKitchenMode(
    outletId: string,
    kitchenMode: string,
    businessId?: string
  ) {
    const updateData: Record<string, any> = { kitchenMode };

    if (outletId === "all" && businessId) {
      return prisma.outlet.updateMany({
        where: { businessId, deletedAt: null },
        data: updateData,
      });
    }
    return prisma.outlet.update({
      where: { id: outletId },
      data: updateData,
    });
  }

  async updateTableOrderMode(
    outletId: string,
    tableOrderMode: 'WAITER_SERVICE' | 'ORDER_AND_PAY',
    allowPayAtCounter: boolean = true,
    businessId?: string
  ) {
    const updateData: Record<string, any> = { tableOrderMode, allowPayAtCounter };

    if (outletId === "all" && businessId) {
      return prisma.outlet.updateMany({
        where: { businessId, deletedAt: null },
        data: updateData,
      });
    }
    return prisma.outlet.update({
      where: { id: outletId },
      data: updateData,
    });
  }

  async deleteUnpaidOutlet(businessId: string, outletId: string) {
    const outlet = await prisma.outlet.findFirst({
      where: { id: outletId, businessId, deletedAt: null },
      include: { subscription: true }
    });

    if (!outlet) {
      throw new Error('Outlet not found');
    }

    if (outlet.subscription && outlet.subscription.status === 'ACTIVE') {
      throw new Error('Cannot delete an outlet with an active subscription');
    }

    // Clean up relation tables and delete outlet
    return prisma.$transaction(async (tx) => {
      await tx.userOutlet.deleteMany({ where: { outletId } });
      await tx.subscriptionPayment.deleteMany({ where: { outletId } });
      await tx.outletSubscription.deleteMany({ where: { outletId } });
      return tx.outlet.delete({ where: { id: outletId } });
    });
  }
}
