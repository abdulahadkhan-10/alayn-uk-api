import { z } from 'zod';

export const createSupplierItemSchema = z.object({
  name: z.string().trim().min(1, 'Item name is required').max(150),
  sku: z.string().trim().max(50).optional(),
  category: z.string().trim().min(1, 'Category is required').max(100),
  unit: z.string().trim().min(1, 'Unit is required').max(50),
  pricePence: z.number().int().positive('Price must be greater than 0'),
  minOrderQty: z.number().positive('Minimum order quantity must be greater than 0').default(1),
  inStock: z.boolean().default(true),
  leadTimeHours: z.number().int().positive().default(24),
  description: z.string().trim().max(500).optional(),
});

export const updateSupplierItemSchema = z.object({
  name: z.string().trim().min(1).max(150).optional(),
  sku: z.string().trim().max(50).optional(),
  category: z.string().trim().min(1).max(100).optional(),
  unit: z.string().trim().min(1).max(50).optional(),
  pricePence: z.number().int().positive().optional(),
  minOrderQty: z.number().positive().optional(),
  inStock: z.boolean().optional(),
  leadTimeHours: z.number().int().positive().optional(),
  description: z.string().trim().max(500).optional(),
});

export const marketplaceQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  category: z.string().trim().max(100).optional(),
  sort: z.enum(['BEST', 'PRICE', 'DELIVERY', 'NAME']).default('BEST'),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const marketplaceSupplierParamsSchema = z.object({
  supplierId: z.string().uuid('Invalid supplier id'),
});

export const updateSupplierProfileSchema = z.object({
  name: z.string().trim().min(2).max(150).optional(),
  contactPerson: z.string().trim().min(2).max(100).optional(),
  phone: z.string().trim().min(10).max(20).optional(),
  email: z.string().trim().email().optional(),
  address: z.string().trim().min(3).max(300).optional(),
  category: z.string().trim().min(2).max(100).optional(),
  vatNumber: z.string().trim().max(30).optional(),
  deliveryTerms: z.string().trim().max(200).optional(),
});
