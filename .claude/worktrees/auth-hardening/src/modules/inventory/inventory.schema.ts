import { z } from 'zod';

export const createItemSchema = z.object({
  name: z.string().min(1),
  sku: z.string().min(1),
  category: z.string().min(1),
  unit: z.string().min(1),
  reorderThreshold: z.number().nonnegative(),
  unitCostPaise: z.number().int().positive(),
  currentStock: z.number().nonnegative().optional(),
  outletId: z.string().optional(),
});

/** A stock count: what is actually on the shelf for each item counted */
export const stockCountSchema = z.object({
  counts: z
    .array(z.object({ itemId: z.string().uuid(), counted: z.number().nonnegative() }))
    .min(1)
    .max(500),
});

export const adjustStockSchema = z.object({
  change: z.number(), // Positive or negative
  reason: z.enum(['PURCHASE', 'WASTE', 'SALE', 'ADJUSTMENT']).default('ADJUSTMENT'),
  unitCostPaise: z.number().int().nonnegative().optional(), // Optional purchase cost for incoming stock
});
