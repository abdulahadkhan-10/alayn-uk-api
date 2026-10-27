import { z } from 'zod';

export const createCategorySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().default(''),
  isActive: z.boolean().optional().default(true),
});

export const createMenuItemSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().default(''),
  price: z.number().min(0).optional(),
  pricePaise: z.number().int().min(0).optional(),
  categoryId: z.string().uuid(),
  imageUrl: z.string().optional().nullable(),
  isVeg: z.boolean().optional().default(true),
  dietaryType: z.enum(['VEG', 'NON_VEG', 'VEGAN']).optional().default('VEG'),
  isActive: z.boolean().optional().default(true),
  isAvailable: z.boolean().optional(),
  outletIds: z.array(z.string()).optional(),
  modifierGroupIds: z.array(z.string().uuid()).optional(),
});

export const updateMenuItemSchema = createMenuItemSchema.partial();
export const updateCategorySchema = createCategorySchema.partial();

export const modifierItemInputSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1),
  price: z.number().min(0).optional(),
  pricePaise: z.number().int().min(0).optional(),
  dietaryType: z.enum(['VEG', 'NON_VEG', 'VEGAN']).optional().default('VEG'),
  isVeg: z.boolean().optional().default(true),
  isActive: z.boolean().optional().default(true),
  sortOrder: z.number().int().optional().default(0),
});

const modifierGroupBaseSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().default(''),
  minSelection: z.number().int().min(0).optional().default(0),
  maxSelection: z.number().int().min(1).optional().nullable(),
  isActive: z.boolean().optional().default(true),
  outletId: z.string().uuid().optional().nullable(),
  modifiers: z.array(modifierItemInputSchema).optional().default([]),
});

const minNotAboveMax = (g: { minSelection?: number; maxSelection?: number | null }) =>
  g.minSelection === undefined || g.maxSelection === undefined || g.maxSelection === null || g.minSelection <= g.maxSelection;
const minSelectionMessage = { message: 'Minimum selection cannot be more than maximum selection', path: ['minSelection'] };

export const createModifierGroupSchema = modifierGroupBaseSchema.refine(minNotAboveMax, minSelectionMessage);
export const updateModifierGroupSchema = modifierGroupBaseSchema.partial().refine(minNotAboveMax, minSelectionMessage);

