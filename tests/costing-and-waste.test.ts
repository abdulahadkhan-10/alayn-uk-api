import {
  computeMovingAverageCost,
  computeWasteLossPence,
} from '../src/modules/inventory/costing.utils';
import { adjustStockSchema } from '../src/modules/inventory/inventory.schema';
import { createWasteLogSchema } from '../src/modules/waste/waste.schema';

describe('Inventory Costing & Waste Unit Tests', () => {
  describe('computeMovingAverageCost (WAC)', () => {
    it('computes exact average for user scenario: 4kg @ ₹100 + 4kg @ ₹120 = ₹110', () => {
      // 4 kg chicken at ₹100/kg (10,000 pence)
      // Added 4 kg chicken at ₹120/kg (12,000 pence)
      const avg = computeMovingAverageCost({
        currentStock: 4,
        currentUnitCostPence: 10000,
        incomingQty: 4,
        incomingUnitCostPence: 12000,
      });

      expect(avg).toBe(11000); // ₹110.00/kg
    });

    it('computes weighted average with unequal quantities: 10kg @ ₹100 + 5kg @ ₹130 = ₹110', () => {
      // (10 * 10000 + 5 * 13000) / 15 = (100000 + 65000) / 15 = 165000 / 15 = 11000
      const avg = computeMovingAverageCost({
        currentStock: 10,
        currentUnitCostPence: 10000,
        incomingQty: 5,
        incomingUnitCostPence: 13000,
      });

      expect(avg).toBe(11000);
    });

    it('sets new cost to incoming cost if current stock is 0', () => {
      const avg = computeMovingAverageCost({
        currentStock: 0,
        currentUnitCostPence: 10000,
        incomingQty: 5,
        incomingUnitCostPence: 15000,
      });

      expect(avg).toBe(15000);
    });

    it('sets new cost to incoming cost if current stock has negative drift', () => {
      const avg = computeMovingAverageCost({
        currentStock: -3,
        currentUnitCostPence: 10000,
        incomingQty: 8,
        incomingUnitCostPence: 14500,
      });

      expect(avg).toBe(14500);
    });

    it('preserves existing unit cost if incoming quantity is 0 or negative', () => {
      const avg = computeMovingAverageCost({
        currentStock: 10,
        currentUnitCostPence: 12000,
        incomingQty: 0,
        incomingUnitCostPence: 18000,
      });

      expect(avg).toBe(12000);
    });

    it('rounds pence to the nearest integer to avoid float drift', () => {
      // 1 kg @ 1000 pence + 2 kg @ 2000 pence = 5000 / 3 = 1666.666... -> 1667 pence
      const avg = computeMovingAverageCost({
        currentStock: 1,
        currentUnitCostPence: 1000,
        incomingQty: 2,
        incomingUnitCostPence: 2000,
      });

      expect(avg).toBe(1667);
    });
  });

  describe('computeWasteLossPence', () => {
    it('calculates total loss for 3kg chicken wasted at ₹110/kg (11,000 pence) = ₹330 (33,000 pence)', () => {
      const loss = computeWasteLossPence(3, 11000);
      expect(loss).toBe(33000); // ₹330.00
    });

    it('returns 0 if quantity or unit cost is zero or negative', () => {
      expect(computeWasteLossPence(0, 11000)).toBe(0);
      expect(computeWasteLossPence(-2, 11000)).toBe(0);
      expect(computeWasteLossPence(3, 0)).toBe(0);
    });
  });

  describe('Schema Validation', () => {
    it('validates adjustStockSchema with optional unitCostPence', () => {
      const valid = adjustStockSchema.safeParse({
        change: 5,
        reason: 'PURCHASE',
        unitCostPence: 12500,
      });

      expect(valid.success).toBe(true);
      if (valid.success) {
        expect(valid.data.unitCostPence).toBe(12500);
      }
    });

    it('validates createWasteLogSchema with optional notes', () => {
      const valid = createWasteLogSchema.safeParse({
        itemId: '123e4567-e89b-12d3-a456-426614174000',
        quantity: 2.5,
        reason: 'SPOILAGE',
        notes: 'Walk-in refrigerator temperature failure between 2 AM and 6 AM',
      });

      expect(valid.success).toBe(true);
      if (valid.success) {
        expect(valid.data.notes).toBe(
          'Walk-in refrigerator temperature failure between 2 AM and 6 AM'
        );
      }
    });

    it('rejects createWasteLogSchema when notes exceed 500 characters', () => {
      const invalid = createWasteLogSchema.safeParse({
        itemId: '123e4567-e89b-12d3-a456-426614174000',
        quantity: 1,
        reason: 'ERROR',
        notes: 'A'.repeat(501),
      });

      expect(invalid.success).toBe(false);
    });
  });
});
