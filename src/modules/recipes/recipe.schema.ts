import { z } from 'zod';

export const recipeLineSchema = z.object({
  itemId: z.string().uuid(),
  /** In the ingredient's own unit, per one portion */
  quantity: z.number().positive().max(1_000_000),
  wastagePercent: z.number().min(0).max(100).optional().default(0),
});

export const saveRecipeSchema = z
  .object({
    lines: z.array(recipeLineSchema).max(60),
    /** Also copy this recipe to these outlets, matching ingredients by SKU */
    applyToOutletIds: z.array(z.string().uuid()).optional().default([]),
  })
  .refine((r) => new Set(r.lines.map((l) => l.itemId)).size === r.lines.length, {
    message: 'Each ingredient can only be listed once',
    path: ['lines'],
  });

export type SaveRecipeInput = z.infer<typeof saveRecipeSchema>;

/** An add-on recipe is per branch only (no copying across branches yet) */
export const saveModifierRecipeSchema = z
  .object({ lines: z.array(recipeLineSchema).max(30) })
  .refine((r) => new Set(r.lines.map((l) => l.itemId)).size === r.lines.length, {
    message: 'Each ingredient can only be listed once',
    path: ['lines'],
  });

export type SaveModifierRecipeInput = z.infer<typeof saveModifierRecipeSchema>;
