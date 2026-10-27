import { z } from 'zod';
import { MAX_SPLIT_PAYMENTS } from './splitPayment';

const selectedModifierSchema = z.object({
  id: z.string().uuid(),
});

const paymentMethodSchema = z.enum(['UPI', 'CARD', 'CASH', 'SWIGGY', 'ZOMATO', 'EAZYDINER']);

// One part of a split or settlement payment. Amounts are integer paise so no rupee fractions are lost in transit.
const splitPaymentSchema = z.object({
  method: paymentMethodSchema,
  amountPaise: z.number().int().positive(),
  reference: z.string().trim().max(64).optional(),
  // Cashier confirmed an online (UPI / card / partner) payment was received
  verified: z.boolean().optional(),
});

export const createOrderSchema = z.object({
  tableNumber: z.union([z.number(), z.string()]).optional(),
  tableNo: z.union([z.number(), z.string()]).optional(),
  source: z.enum(['TABLE', 'COUNTER', 'QR', 'DELIVERY']).optional(),
  orderSource: z.enum(['TABLE', 'COUNTER', 'QR', 'DELIVERY']).optional(),
  tableToken: z.string().optional(),
  customerName: z.string().trim().max(100).optional(),
  customerPhone: z.string().trim().max(20).optional(),
  paymentMethod: z.enum(['UPI', 'CARD', 'CASH']).optional(),
  // Payment fields are ignored on table-QR orders: diners say how they'll pay when they ask for the bill
  paymentStatus: z.enum(['PENDING', 'CONFIRMED', 'FAILED']).optional(),
  paymentRef: z.string().trim().max(64).optional(),
  items: z.array(z.object({
    menuItemId: z.string().uuid(),
    quantity: z.number().int().positive().max(999),
    notes: z.string().max(500).optional(),
    // Only the chosen option ids matter — names and prices are always taken from the menu
    modifiers: z.array(selectedModifierSchema).max(50).optional(),
    selectedModifiers: z.array(selectedModifierSchema).max(50).optional(),
  })).min(1).max(100),
  couponCode: z.string().optional(),
  couponId: z.string().uuid().optional(),
  discountAmount: z.number().nonnegative().optional(),
});

export const updateOrderStatusSchema = z.object({
  status: z.enum(['SENT_TO_KITCHEN', 'PREPARING', 'READY', 'SERVED', 'DISPATCHED', 'COMPLETED', 'CANCELLED']),
  comment: z.string().optional(),
  paymentMethod: paymentMethodSchema.optional(),
  // Settle with several payments instead of one paymentMethod; they must add up to the balance due
  payments: z.array(splitPaymentSchema).min(1).max(MAX_SPLIT_PAYMENTS).optional(),
  // Same key on a retried settle request returns the settled bill instead of an error
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
  // The cashier checked a UTR / approval code already used on another bill and settles anyway
  allowDuplicateReference: z.boolean().optional(),
  customerName: z.string().optional(),
  customerPhone: z.string().optional(),
  couponCode: z.string().optional(),
  couponId: z.string().uuid().optional(),
  discountAmount: z.number().nonnegative().optional(),
  discountPaise: z.number().int().nonnegative().optional(),
});

// Remove (waive = true) or restore the voluntary service charge on an open dine-in bill
export const serviceChargeWaiverSchema = z.object({
  waive: z.boolean(),
  reason: z.string().trim().max(300).optional(),
});

export const createPaymentSchema = z.object({
  amountPaise: z.number().int().positive(),
  method: paymentMethodSchema,
  status: z.enum(['PENDING', 'CONFIRMED', 'FAILED']).default('CONFIRMED'),
});

// Diner asks for the bill from the table QR and says how they'll pay
export const tableBillRequestSchema = z.object({
  paymentMethod: z.enum(['UPI', 'CARD', 'CASH']),
  paymentRef: z.string().trim().max(64).optional(),
});

// Staff, Manager or Business Owner cancels or reduces an item from an active order/bill
export const cancelOrderItemSchema = z.object({
  cancelQuantity: z.number().int().positive().optional(),
  reason: z.string().trim().min(2, 'A reason is required to cancel an item').max(300),
});

