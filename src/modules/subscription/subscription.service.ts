import { SubscriptionRepository } from './subscription.repository';
import { CashfreeService } from './cashfree.service';
import { AppError } from '../../utils/AppError';
import { OutletSubscriptionStatus, SubscriptionPaymentStatus, PrismaClient, DiscountType } from '@prisma/client';
import { assertCouponRedeemable, isFreeCoupon } from './couponRedemption';

/**
 * Cashfree collects in Indian rupees, while Alayn UK prices are in pounds. The pound amount is
 * converted with a rate set on the server (CASHFREE_GBP_TO_INR_RATE, rupees per pound). There is
 * no built-in default: charging with a stale or guessed rate is worse than refusing the checkout.
 */
export const CHARGE_CURRENCY = 'INR';

export function gbpToInrRate(): number {
  const rate = Number(process.env.CASHFREE_GBP_TO_INR_RATE);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new AppError(
      'PAYMENT_CONFIG_ERROR',
      'Card payments are not set up yet. Please contact Alayn support.',
      503
    );
  }
  return rate;
}

/** Pounds → rupees, rounded to the paisa Cashfree accepts */
export function poundsToChargeAmount(pounds: number, rate: number): number {
  return Math.round(pounds * rate * 100) / 100;
}

export interface PlanConfig {
  planCode: string;
  name: string;
  description: string;
  monthlyFeePence: number; // Monthly fee in pence, including VAT
  yearlyFeePence: number; // Fee in pence for a 12-month term, including VAT
  vatRatePercent: number; // UK VAT rate (20%)
  features: string[];
}

export const SUBSCRIPTION_PLANS: Record<string, PlanConfig> = {
  MONTHLY_STANDARD: {
    planCode: 'MONTHLY_STANDARD',
    name: 'Alayn Smart Branch Pro',
    description: 'Complete operational suite for 1 physical restaurant branch',
    // *_PAISE is the old variable name; read until the server env is renamed to *_PENCE
    monthlyFeePence: parseInt(process.env.OUTLET_MONTHLY_FEE_PENCE || process.env.OUTLET_MONTHLY_FEE_PAISE || '7900', 10), // £79
    yearlyFeePence: parseInt(process.env.OUTLET_YEARLY_FEE_PENCE || process.env.OUTLET_YEARLY_FEE_PAISE || '60000', 10), // £600
    vatRatePercent: 20.0,
    features: [
      'Unlimited POS Billing Counters & Table QR Tokens',
      'Real-time Kitchen Display System (KDS)',
      'Live Inventory & Multi-batch Expiry Management',
      'Staff Shifts, Geofenced Attendance & Rostering',
      'Real-time Sales Telemetry & Financial Analytics',
      'AI Menu & Sales Assistant',
      '24/7 Priority Support & Automated Data Backups'
    ]
  }
};

export class SubscriptionService {
  private repository = new SubscriptionRepository();
  private cashfree = new CashfreeService();
  private prisma = new PrismaClient();

  getPlans() {
    return Object.values(SUBSCRIPTION_PLANS).map((plan) => {
      const totalPounds = plan.monthlyFeePence / 100;
      const vatPounds = Math.round((totalPounds - totalPounds / (1 + plan.vatRatePercent / 100)) * 100) / 100;
      const basePounds = Math.round((totalPounds - vatPounds) * 100) / 100;

      return {
        ...plan,
        basePricePounds: basePounds,
        vatPounds: vatPounds,
        totalPayablePounds: totalPounds,
        totalPayablePence: Math.round(totalPounds * 100)
      };
    });
  }

  async initiateOutletSubscription(
    businessId: string,
    userId: string,
    outletId: string,
    planCode: string = 'MONTHLY_STANDARD',
    customerInfo?: { name?: string; email?: string; phone?: string },
    months: number = 1,
    couponCode?: string
  ) {
    const plan = SUBSCRIPTION_PLANS[planCode] || SUBSCRIPTION_PLANS.MONTHLY_STANDARD;
    const validatedMonths = Math.max(1, Math.min(36, parseInt(String(months), 10) || 1));
    
    // Base amount before discount
    // Each full 12 months is billed at the yearly rate, any remaining months at the monthly rate
    const rawBasePounds =
      (Math.floor(validatedMonths / 12) * plan.yearlyFeePence + (validatedMonths % 12) * plan.monthlyFeePence) / 100;

    // Apply Coupon if provided (Server-authoritative calculation)
    let appliedCoupon: any = null;
    let discountPounds = 0;

    if (couponCode && couponCode.trim()) {
      const normalized = couponCode.trim().toUpperCase();
      const coupon = await this.prisma.coupon.findUnique({
        where: { code: normalized },
      });
      assertCouponRedeemable(coupon);

      // Free coupons are redeemed through applyCoupon, which enforces one free branch per business
      if (isFreeCoupon(coupon)) {
        throw new AppError('FREE_COUPON_NOT_PAYABLE', 'This coupon gives free access. Apply it to the branch instead of paying.', 400);
      }

      if (coupon.discountType === DiscountType.PERCENTAGE) {
        discountPounds = Math.round(((rawBasePounds * Number(coupon.discountValue)) / 100) * 100) / 100;
      } else {
        discountPounds = Math.min(rawBasePounds, Number(coupon.discountValue));
      }

      appliedCoupon = coupon;
    }

    // Plan fees are VAT-inclusive: the customer pays the listed price and VAT is the portion within it
    const totalPounds = Math.round(Math.max(0, rawBasePounds - discountPounds) * 100) / 100;
    const vatPounds = Math.round((totalPounds - totalPounds / (1 + plan.vatRatePercent / 100)) * 100) / 100;
    const finalBasePounds = Math.round((totalPounds - vatPounds) * 100) / 100;
    const totalPence = Math.round(totalPounds * 100);
    const vatPence = Math.round(vatPounds * 100);
    const discountPence = Math.round(discountPounds * 100);
    // Checked before anything is saved, so a missing rate leaves no half-made payment behind
    const chargeAmount = totalPence > 0 ? poundsToChargeAmount(totalPounds, gbpToInrRate()) : 0;

    // Generate unique Cashfree order ID
    const shortOutletId = outletId.replace(/-/g, '').substring(0, 8);
    const cfOrderId = `ALAYN_SUB_${shortOutletId}_${Date.now()}`;

    const planNameWithDuration = validatedMonths === 1 
      ? plan.name 
      : validatedMonths === 12 
      ? `${plan.name} (Annual Plan)` 
      : `${plan.name} (${validatedMonths} Months)`;

    // Ensure a subscription record exists. Renewing a branch that is still active must not lock it
    // while the payment is pending, or lose its remaining days (markPaymentSuccess extends from the
    // current end only while the subscription is ACTIVE).
    const currentSub = await this.repository.getSubscriptionByOutletId(outletId);
    const isRenewingActive =
      currentSub?.status === OutletSubscriptionStatus.ACTIVE && currentSub.currentPeriodEnd > new Date();
    const subRecord = await this.repository.createOrUpdateSubscription({
      outletId,
      businessId,
      status: isRenewingActive ? OutletSubscriptionStatus.ACTIVE : OutletSubscriptionStatus.PENDING_PAYMENT,
      planCode: plan.planCode,
      planName: planNameWithDuration,
      monthlyFeePence: plan.monthlyFeePence,
    });

    // A coupon that covers the whole amount needs no gateway payment (Cashfree cannot take a £0
    // order), so the subscription is activated directly for the chosen months
    if (totalPence === 0) {
      const freeOrderId = `ALAYN_FREE_${shortOutletId}_${Date.now()}`;
      await this.repository.createPaymentRecord({
        outletId,
        businessId,
        outletSubscriptionId: subRecord.id,
        cfOrderId: freeOrderId,
        amountPence: 0,
        taxAmountPence: 0,
        currency: 'GBP',
        paymentStatus: SubscriptionPaymentStatus.PENDING,
        couponId: appliedCoupon?.id,
        couponCode: appliedCoupon?.code,
        discountAmountPence: discountPence,
        billingMonths: validatedMonths,
      });
      const result = await this.repository.markPaymentSuccess(freeOrderId, {
        paymentMethod: 'COUPON',
        strictCouponLimit: true,
      });

      return {
        orderId: freeOrderId,
        cfOrderId: null,
        paymentSessionId: null,
        paidWithoutGateway: true,
        orderAmountPounds: 0,
        baseAmountPounds: 0,
        discountPounds,
        vatAmountPounds: 0,
        currency: 'GBP',
        months: validatedMonths,
        subscription: result.subscription,
        coupon: appliedCoupon
          ? {
              code: appliedCoupon.code,
              discountType: appliedCoupon.discountType,
              discountValue: Number(appliedCoupon.discountValue),
              discountPounds,
            }
          : null,
        plan: {
          code: plan.planCode,
          name: planNameWithDuration,
          features: plan.features
        }
      };
    }

    // Format customer phone number to guarantee 10 digits (Cashfree requires valid 10-digit phone)
    let sanitizedPhone = customerInfo?.phone ? customerInfo.phone.replace(/\D/g, '') : '';
    if (sanitizedPhone.length > 10) {
      sanitizedPhone = sanitizedPhone.slice(-10);
    }
    if (sanitizedPhone.length < 10) {
      sanitizedPhone = '9876543210';
    }

    // Create Cashfree Order
    const cfOrder = await this.cashfree.createOrder({
      orderId: cfOrderId,
      orderAmount: chargeAmount,
      orderCurrency: CHARGE_CURRENCY,
      customerDetails: {
        customerId: userId,
        customerName: customerInfo?.name || 'Restaurant Business Owner',
        customerEmail: customerInfo?.email || 'owner@alayn.app',
        customerPhone: sanitizedPhone
      },
      orderNotes: {
        outletId,
        businessId,
        planCode: plan.planCode,
        userId,
        months: String(validatedMonths),
        couponCode: appliedCoupon?.code || '',
      },
      orderMeta: {
        notifyUrl: process.env.CASHFREE_NOTIFY_URL || (process.env.API_BASE_URL ? `${process.env.API_BASE_URL}/api/v1/subscriptions/webhook/cashfree` : undefined)
      }
    });

    // Create SubscriptionPayment audit ledger record with locked billingMonths
    await this.repository.createPaymentRecord({
      outletId,
      businessId,
      outletSubscriptionId: subRecord.id,
      cfOrderId,
      amountPence: totalPence,
      taxAmountPence: vatPence,
      currency: 'GBP',
      paymentSessionId: cfOrder.payment_session_id,
      paymentStatus: SubscriptionPaymentStatus.PENDING,
      couponId: appliedCoupon?.id,
      couponCode: appliedCoupon?.code,
      discountAmountPence: discountPence,
      billingMonths: validatedMonths,
      chargedAmount: chargeAmount,
      chargedCurrency: CHARGE_CURRENCY,
    });

    return {
      orderId: cfOrderId,
      cfOrderId: cfOrder.cf_order_id,
      paymentSessionId: cfOrder.payment_session_id,
      orderAmountPounds: totalPounds,
      baseAmountPounds: finalBasePounds,
      discountPounds,
      vatAmountPounds: vatPounds,
      currency: 'GBP',
      // What the Cashfree checkout will show and collect
      chargeAmount,
      chargeCurrency: CHARGE_CURRENCY,
      months: validatedMonths,
      coupon: appliedCoupon
        ? {
            code: appliedCoupon.code,
            discountType: appliedCoupon.discountType,
            discountValue: Number(appliedCoupon.discountValue),
            discountPounds,
          }
        : null,
      plan: {
        code: plan.planCode,
        name: planNameWithDuration,
        features: plan.features
      }
    };
  }

  async verifyOutletPayment(cfOrderId: string) {
    const payment = await this.repository.getPaymentByOrderId(cfOrderId);
    if (!payment) {
      throw new AppError('NOT_FOUND', 'Payment session order not found.', 404);
    }

    if (payment.paymentStatus === SubscriptionPaymentStatus.SUCCESS) {
      return {
        status: 'PAID',
        message: 'Subscription is already active.',
        subscription: payment.outletSubscription,
        payment
      };
    }

    // Verify status with Cashfree PG
    const cfOrder = await this.cashfree.getOrder(cfOrderId);
    const paymentsList = await this.cashfree.getOrderPayments(cfOrderId);
    const successfulPayment = paymentsList.find((p) => p.payment_status === 'SUCCESS') || paymentsList[0];

    // Anti-fraud: the order Cashfree holds must be in the currency and for the amount we asked for.
    // Older payments (before rupee checkout) recorded no charged amount and were made in pounds.
    const paidAmount = Number(cfOrder.order_amount);
    const expectedCurrency = (payment as any).chargedCurrency || payment.currency || 'GBP';
    const expectedAmount =
      (payment as any).chargedAmount !== null && (payment as any).chargedAmount !== undefined
        ? Number((payment as any).chargedAmount)
        : payment.amountPence / 100;
    if ((cfOrder.order_currency || expectedCurrency) !== expectedCurrency || paidAmount < expectedAmount) {
      console.error(
        `[SubscriptionService] Paid amount mismatch for order ${cfOrderId}: paid ${paidAmount} ${cfOrder.order_currency}, expected ${expectedAmount} ${expectedCurrency}`
      );
      throw new AppError('PAYMENT_AMOUNT_MISMATCH', 'Paid amount is less than the required subscription fee.', 400);
    }

    if (cfOrder.order_status === 'PAID' || successfulPayment?.payment_status === 'SUCCESS') {
      const result = await this.repository.markPaymentSuccess(cfOrderId, {
        cfPaymentId: successfulPayment?.cf_payment_id ? String(successfulPayment.cf_payment_id) : undefined,
        paymentMethod: successfulPayment?.payment_group || successfulPayment?.payment_method || 'CARD',
        rawPayload: cfOrder,
        paidAt: new Date()
      });

      return {
        status: 'PAID',
        message: 'Payment verified successfully. Branch subscription is now ACTIVE!',
        subscription: result.subscription,
        payment: result.payment
      };
    }

    if (cfOrder.order_status === 'EXPIRED' || cfOrder.order_status === 'TERMINATED') {
      await this.repository.markPaymentFailed(cfOrderId, cfOrder);
      throw new AppError('PAYMENT_FAILED', 'Payment order has expired or failed. Please try again.', 400);
    }

    return {
      status: 'PENDING',
      message: 'Payment is currently pending confirmation from Cashfree.',
      payment
    };
  }

  async handleCashfreeWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>, payload: any) {
    const signature = (headers['x-webhook-signature'] || headers['x-cashfree-signature']) as string;
    const timestamp = (headers['x-webhook-timestamp'] || headers['x-cashfree-timestamp']) as string;

    // Security Guardrail 1: Mandatory cryptographic signature check on every webhook
    if (!signature || !timestamp) {
      console.warn('[Webhook] Rejected Cashfree webhook: Missing signature/timestamp headers.');
      throw new AppError('FORBIDDEN', 'Missing webhook signature headers', 403);
    }

    const isValid = this.cashfree.verifyWebhookSignature(rawBody, timestamp, signature);
    if (!isValid) {
      console.warn('[Webhook] Invalid Cashfree signature rejected.');
      throw new AppError('FORBIDDEN', 'Invalid Webhook Signature', 403);
    }

    const eventType = payload?.type || payload?.event;
    const orderData = payload?.data?.order || payload?.data;
    const paymentData = payload?.data?.payment;

    const cfOrderId = orderData?.order_id || paymentData?.order_id;
    if (!cfOrderId) {
      return { received: true, ignored: true, reason: 'No order_id in webhook payload' };
    }

    // Security Guardrail 2: Server-to-Server Direct Verification
    // Do not trust incoming webhook payload alone. Query Cashfree API directly to verify payment!
    if (eventType === 'PAYMENT_SUCCESS_WEBHOOK' || eventType === 'ORDER_PAID_SUCCESS' || paymentData?.payment_status === 'SUCCESS') {
      const verification = await this.verifyOutletPayment(cfOrderId);
      return { success: true, processed: true, status: verification.status };
    }

    if (eventType === 'PAYMENT_FAILED_WEBHOOK' || paymentData?.payment_status === 'FAILED') {
      // Re-verify with Cashfree to ensure genuine failure before marking failed
      try {
        const cfOrder = await this.cashfree.getOrder(cfOrderId);
        if (cfOrder.order_status === 'PAID') {
          const verified = await this.verifyOutletPayment(cfOrderId);
          return { success: true, processed: true, status: verified.status };
        }
      } catch (err) {
        // Continue to mark payment failed if not found
      }

      await this.repository.markPaymentFailed(cfOrderId, payload);
      return { success: true, processed: true, status: 'FAILED' };
    }

    return { received: true };
  }

  async getOutletSubscriptionStatus(outletId: string) {
    const subscription = await this.repository.getSubscriptionByOutletId(outletId);
    if (!subscription) {
      return {
        hasSubscription: false,
        status: OutletSubscriptionStatus.PENDING_PAYMENT,
        isActive: false,
        daysRemaining: 0,
        currentPeriodEnd: null,
      };
    }

    const now = new Date();
    const periodEnd = new Date(subscription.currentPeriodEnd);
    const msRemaining = periodEnd.getTime() - now.getTime();
    const daysRemaining = Math.max(0, Math.ceil(msRemaining / (1000 * 60 * 60 * 24)));
    const isExpired = subscription.status === OutletSubscriptionStatus.EXPIRED || now > periodEnd;

    return {
      hasSubscription: true,
      subscriptionId: subscription.id,
      status: isExpired ? OutletSubscriptionStatus.EXPIRED : subscription.status,
      isActive: subscription.status === OutletSubscriptionStatus.ACTIVE && !isExpired,
      daysRemaining,
      planCode: subscription.planCode,
      planName: subscription.planName,
      monthlyFeePounds: subscription.monthlyFeePence / 100,
      currentPeriodStart: subscription.currentPeriodStart,
      currentPeriodEnd: subscription.currentPeriodEnd,
      recentPayments: subscription.payments
    };
  }

  async getBillingHistory(businessId: string) {
    const records = await this.repository.getBillingHistory(businessId);
    return records.map((rec) => ({
      id: rec.id,
      orderId: rec.cfOrderId,
      cfPaymentId: rec.cfPaymentId,
      outletId: rec.outletId,
      outletName: rec.outlet?.name || 'Branch Outlet',
      outletCity: rec.outlet?.city || '',
      amountPounds: rec.amountPence / 100,
      taxPounds: rec.taxAmountPence / 100,
      status: rec.paymentStatus,
      paymentMethod: rec.paymentMethod || 'CARD',
      paidAt: rec.paidAt || rec.createdAt,
      createdAt: rec.createdAt
    }));
  }

  async validateCoupon(code: string, businessId?: string) {
    const normalized = (code || '').trim().toUpperCase();

    // Check database for active coupon
    const coupon = await this.prisma.coupon.findUnique({
      where: { code: normalized },
    });

    if (coupon) {
      if (!coupon.isActive) {
        return {
          valid: false,
          code: normalized,
          message: 'This coupon code is currently disabled.',
        };
      }

      if (coupon.expiresAt && coupon.expiresAt <= new Date()) {
        return {
          valid: false,
          code: normalized,
          message: 'This coupon code has expired.',
        };
      }

      if (coupon.usageLimit && coupon.usageCount >= coupon.usageLimit) {
        return {
          valid: false,
          code: normalized,
          message: 'This coupon code has reached its redemption limit.',
        };
      }

      if (businessId && isFreeCoupon(coupon)) {
        const redeemed = await this.prisma.couponRedemption.findUnique({
          where: { couponId_businessId: { couponId: coupon.id, businessId } },
        });
        if (redeemed) {
          return {
            valid: false,
            code: normalized,
            message: 'Your business has already redeemed this coupon.',
          };
        }
      }

      const discountLabel =
        coupon.discountType === DiscountType.PERCENTAGE
          ? `${coupon.discountValue}% OFF`
          : `£${coupon.discountValue} OFF`;

      return {
        valid: true,
        code: coupon.code,
        discountType: coupon.discountType,
        discountValue: Number(coupon.discountValue),
        description: `${discountLabel} on Alayn branch subscription`,
        validUntil: coupon.expiresAt?.toISOString() || null,
        message: `Coupon code "${coupon.code}" applied! You get ${discountLabel}.`,
      };
    }

    return {
      valid: false,
      code: normalized,
      message: 'Invalid coupon code. Please check and try again.',
    };
  }

  async applyCoupon(businessId: string, couponCode: string, outletId?: string) {
    const normalized = (couponCode || '').trim().toUpperCase();
    if (!normalized) {
      throw new AppError('VALIDATION_ERROR', 'Coupon code is required.', 400);
    }

    // Coupons live in the database (created by an admin); nothing is hard-coded here.
    const coupon = await this.prisma.coupon.findUnique({
      where: { code: normalized },
    });
    assertCouponRedeemable(coupon);

    const discountVal = Number(coupon.discountValue);

    // If it is a 100% FREE VIP coupon
    if (isFreeCoupon(coupon)) {
      const { outletSubscription, freeUntil } = await this.repository.applyPromotionalCoupon(businessId, coupon, outletId);

      return {
        success: true,
        message: `Coupon "${coupon.code}" applied! You now have 100% free VIP access.`,
        couponCode: coupon.code,
        validUntil: freeUntil.toISOString(),
        discountType: coupon.discountType,
        discountValue: discountVal,
        outletSubscription,
      };
    }

    // For partial discount coupons (e.g., 20% OFF, £500 OFF)
    const discountLabel =
      coupon.discountType === DiscountType.PERCENTAGE
        ? `${discountVal}% OFF`
        : `£${discountVal} OFF`;

    return {
      success: true,
      applied: true,
      message: `Coupon "${coupon.code}" applied! You get ${discountLabel} discount. Please proceed to payment with the discount applied.`,
      couponCode: coupon.code,
      discountType: coupon.discountType,
      discountValue: discountVal,
    };
  }
}
export default SubscriptionService;
