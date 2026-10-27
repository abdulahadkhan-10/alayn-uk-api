import { z } from 'zod';

export const createWasteLogSchema = z.object({
  itemId: z.string().uuid(),
  quantity: z.number().positive(),
  reason: z.enum(['SPOILAGE', 'OVER_PREP', 'RETURN', 'ERROR']),
  notes: z.string().max(500).optional(),
});
