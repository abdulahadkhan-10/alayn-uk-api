import { prisma } from '../../config/prisma';
import { Coupon, OutletSubscriptionStatus, SubscriptionPaymentStatus } from '@prisma/client';
import { AppError } from '../../utils/AppError';
import { claimCouponSlot, redeemFreeCoupon } from './couponRedemption';

export class SubscriptionRepository {
  async getSubscriptionByOutletId(outletId: string) {
    return prisma.outletSubscription.findUnique({
      where: { outletId },
      include: {
        outlet: {
          select: {
            id: true,
            name: true,
            city: true,
            address: true,
          }
        },
        payments: {
          orderBy: { createdAt: 'desc' },
          take: 5
        }
      }
    });
  }

  async getSubscriptionsByBusinessId(businessId: string) {
    return prisma.outletSubscription.findMany({
      where: { businessId },
      include: {
        outlet: {
          select: {
            id: true,
            name: true,
            city: true,
            address: true,
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  async createOrUpdateSubscription(data: {
    outletId: string;
    businessId: string;
    status: OutletSubscriptionStatus;
    planCode?: string;
    planName?: string;
    monthlyFeePaise?: number;
    currentPeriodStart?: Date;
    currentPeriodEnd?: Date;
  }) {
    const periodStart = data.currentPeriodStart || new Date();
    const periodEnd = data.currentPeriodEnd || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    return prisma.outletSubscription.upsert({
      where: { outletId: data.outletId },
      create: {
        outletId: data.outletId,
        businessId: data.businessId,
        status: data.status,
        planCode: data.planCode || 'MONTHLY_STANDARD',
        planName: data.planName || 'Monthly Pro Plan',
        monthlyFeePaise: data.monthlyFeePaise || 199900,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
      },
      update: {
        status: data.status,
        ...(data.planCode && { planCode: data.planCode }),
        ...(data.planName && { planName: data.planName }),
        ...(data.monthlyFeePaise && { monthlyFeePaise: data.monthlyFeePaise }),
        ...(data.currentPeriodStart && { currentPeriodStart: data.currentPeriodStart }),
        ...(data.currentPeriodEnd && { currentPeriodEnd: data.currentPeriodEnd }),
      }
    });
  }

  async createPaymentRecord(data: {
    outletId: string;
    businessId: string;
    outletSubscriptionId?: string;
    cfOrderId: string;
    amountPaise: number;
    taxAmountPaise?: number;
    currency?: string;
    paymentSessionId?: string;
    paymentStatus?: SubscriptionPaymentStatus;
    couponId?: string;
    couponCode?: string;
    discountAmountPaise?: number;
    billingMonths?: number;
  }) {
    return prisma.subscriptionPayment.create({
      data: {
        outletId: data.outletId,
        businessId: data.businessId,
        outletSubscriptionId: data.outletSubscriptionId,
        cfOrderId: data.cfOrderId,
        amountPaise: data.amountPaise,
        taxAmountPaise: data.taxAmountPaise || 0,
        currency: data.currency || 'INR',
        paymentSessionId: data.paymentSessionId,
        paymentStatus: data.paymentStatus || SubscriptionPaymentStatus.PENDING,
        couponId: data.couponId,
        couponCode: data.couponCode,
        discountAmountPaise: data.discountAmountPaise || 0,
        billingMonths: data.billingMonths || 1,
      } as any
    });
  }

  async getPaymentByOrderId(cfOrderId: string) {
    return prisma.subscriptionPayment.findUnique({
      where: { cfOrderId },
      include: {
        outletSubscription: true,
        outlet: true,
      }
    });
  }

  async markPaymentSuccess(cfOrderId: string, paymentDetails: {
    cfPaymentId?: string;
    paymentMethod?: string;
    cfSignature?: string;
    rawPayload?: any;
    paidAt?: Date;
    months?: number;
    /** Refuse (and roll back) instead of only logging when the coupon has no slot left. */
    strictCouponLimit?: boolean;
  }) {
    return prisma.$transaction(async (tx) => {
      const payment = await tx.subscriptionPayment.findUnique({
        where: { cfOrderId }
      });

      if (!payment) {
        throw new Error(`Payment record with orderId ${cfOrderId} not found.`);
      }

      // Idempotency guard: If already processed and marked SUCCESS (e.g. concurrent webhook + client verify),
      // do not extend duration a second time!
      if (payment.paymentStatus === SubscriptionPaymentStatus.SUCCESS) {
        const existingSub = await tx.outletSubscription.findUnique({
          where: { outletId: payment.outletId }
        });
        return { payment, subscription: existingSub };
      }

      // Update payment record
      const updatedPayment = await tx.subscriptionPayment.update({
        where: { cfOrderId },
        data: {
          paymentStatus: SubscriptionPaymentStatus.SUCCESS,
          cfPaymentId: paymentDetails.cfPaymentId,
          paymentMethod: paymentDetails.paymentMethod || 'UPI',
          cfSignature: paymentDetails.cfSignature,
          rawWebhookPayload: paymentDetails.rawPayload,
          paidAt: paymentDetails.paidAt || new Date(),
        }
      });

      // Calculate period duration based on paid amount or order notes
      const now = new Date();
      const existingSub = await tx.outletSubscription.findUnique({
        where: { outletId: payment.outletId }
      });

      // Standard monthly fee is ₹1,999 + 18% GST = ₹2,358.82 = 235882 paise
      const singleMonthPaise = 235882;
      // Security: Read billing duration strictly from our internal payment record, NEVER from untrusted raw webhook payloads
      const dbBillingMonths = (payment as any).billingMonths;
      const calculatedMonths = (typeof dbBillingMonths === 'number' && dbBillingMonths > 0)
        ? Math.min(36, dbBillingMonths)
        : Math.max(1, Math.min(36, Math.round(payment.amountPaise / singleMonthPaise)));

      // Helper for true calendar month addition (preserves exact day of month, handles month-ends)
      const addCalendarMonths = (startDate: Date, monthsToAdd: number): Date => {
        const result = new Date(startDate.getTime());
        const originalDate = result.getDate();
        result.setMonth(result.getMonth() + monthsToAdd);
        if (result.getDate() !== originalDate) {
          result.setDate(0);
        }
        return result;
      };

      let periodStart = now;
      let periodEnd = addCalendarMonths(now, calculatedMonths);

      // If existing subscription is active and in future, extend from existing currentPeriodEnd
      if (existingSub && existingSub.status === OutletSubscriptionStatus.ACTIVE && existingSub.currentPeriodEnd > now) {
        periodStart = existingSub.currentPeriodStart;
        periodEnd = addCalendarMonths(existingSub.currentPeriodEnd, calculatedMonths);
      }

      const updatedSub = await tx.outletSubscription.upsert({
        where: { outletId: payment.outletId },
        create: {
          outletId: payment.outletId,
          businessId: payment.businessId,
          status: OutletSubscriptionStatus.ACTIVE,
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
        },
        update: {
          status: OutletSubscriptionStatus.ACTIVE,
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
        }
      });

      // Link payment to subscription if not already linked
      if (!payment.outletSubscriptionId) {
        await tx.subscriptionPayment.update({
          where: { id: payment.id },
          data: { outletSubscriptionId: updatedSub.id }
        });
      }

      // Take the coupon's slot on confirmed payment success. The customer has already paid the
      // discounted price, so a slot lost to a concurrent checkout is logged rather than refused.
      if (payment.couponId) {
        const coupon = await tx.coupon.findUnique({ where: { id: payment.couponId } });
        if (coupon && !(await claimCouponSlot(tx, coupon))) {
          if (paymentDetails.strictCouponLimit) {
            throw new AppError('COUPON_LIMIT_REACHED', 'This coupon code has reached its maximum redemption limit.', 400);
          }
          console.warn(`[SubscriptionRepository] Coupon ${coupon.code} exceeded its usage limit on paid order ${cfOrderId}`);
        }
      }

      return { payment: updatedPayment, subscription: updatedSub };
    });
  }

  async markPaymentFailed(cfOrderId: string, rawPayload?: any) {
    return prisma.subscriptionPayment.update({
      where: { cfOrderId },
      data: {
        paymentStatus: SubscriptionPaymentStatus.FAILED,
        rawWebhookPayload: rawPayload,
      }
    });
  }

  async getBillingHistory(businessId: string) {
    return prisma.subscriptionPayment.findMany({
      where: { businessId },
      include: {
        outlet: {
          select: {
            id: true,
            name: true,
            city: true,
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  async applyPromotionalCoupon(businessId: string, coupon: Coupon, outletId?: string) {
    return prisma.$transaction(async (tx) => {
      // Resolve target outlet (validate UUID format to prevent Prisma P2023 crashes)
      const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
      let targetOutletId = outletId && isUuid.test(outletId) ? outletId : null;

      if (!targetOutletId) {
        const firstOutlet = await tx.outlet.findFirst({
          where: { businessId, deletedAt: null },
          orderBy: { createdAt: 'asc' },
        });
        if (!firstOutlet) {
          throw new AppError('OUTLET_NOT_FOUND', 'No outlet found to apply promotional coupon.', 404);
        }
        targetOutletId = firstOutlet.id;
      }

      return redeemFreeCoupon(tx, { coupon, businessId, outletId: targetOutletId });
    });
  }
}
export default SubscriptionRepository;
