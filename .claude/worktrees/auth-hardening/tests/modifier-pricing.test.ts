import { priceItemWithModifiers, PricingGroup } from '../src/modules/orders/modifierPricing';
import { createModifierGroupSchema, updateModifierGroupSchema } from '../src/modules/menu/menu.schema';
import { createOrderSchema } from '../src/modules/orders/order.schema';

const paneer = { name: 'Paneer Tikka', pricePaise: 25000 };

const portion: PricingGroup = {
  id: 'g-portion',
  name: 'Portion',
  minSelection: 1,
  maxSelection: 1,
  modifiers: [
    { id: 'm-half', name: 'Half', pricePaise: 18000 },
    { id: 'm-full', name: 'Full', pricePaise: 30000 },
  ],
};

const extras: PricingGroup = {
  id: 'g-extras',
  name: 'Extras',
  minSelection: 0,
  maxSelection: 2,
  modifiers: [
    { id: 'm-cheese', name: 'Extra Cheese', pricePaise: 3000 },
    { id: 'm-butter', name: 'Extra Butter', pricePaise: 2000 },
    { id: 'm-onion', name: 'Onion', pricePaise: 0 },
  ],
};

describe('Add-on and variant pricing comes from the menu, not the order request', () => {
  it('an item with no add-ons costs its menu price', () => {
    expect(priceItemWithModifiers(paneer, [], []).unitPricePaise).toBe(25000);
  });

  it('a chosen variant replaces the base price and extras add on top', () => {
    const { unitPricePaise, modifiers } = priceItemWithModifiers(paneer, [portion, extras], ['m-full', 'm-cheese']);
    expect(unitPricePaise).toBe(30000 + 3000);
    expect(modifiers).toEqual([
      { id: 'm-full', groupId: 'g-portion', groupName: 'Portion', name: 'Full', pricePaise: 30000, isVariant: true },
      { id: 'm-cheese', groupId: 'g-extras', groupName: 'Extras', name: 'Extra Cheese', pricePaise: 3000, isVariant: false },
    ]);
  });

  it('an option id that is not on this item is rejected instead of being priced from the request', () => {
    expect(() => priceItemWithModifiers(paneer, [portion], ['m-half', 'some-other-option'])).toThrow(/no longer available/);
  });

  it('a mandatory group with nothing chosen is rejected', () => {
    expect(() => priceItemWithModifiers(paneer, [portion, extras], ['m-cheese'])).toThrow(/Please choose Portion/);
  });

  it('choosing more than a group allows is rejected', () => {
    expect(() => priceItemWithModifiers(paneer, [portion, extras], ['m-half', 'm-cheese', 'm-butter', 'm-onion'])).toThrow(/at most 2/);
  });

  it('the same option sent twice is counted once', () => {
    expect(priceItemWithModifiers(paneer, [extras], ['m-cheese', 'm-cheese']).unitPricePaise).toBe(28000);
  });

  it('a mandatory single choice with only free options adds nothing and keeps the base price', () => {
    const spice: PricingGroup = {
      id: 'g-spice', name: 'Spice', minSelection: 1, maxSelection: 1,
      modifiers: [{ id: 'm-mild', name: 'Mild', pricePaise: 0 }, { id: 'm-hot', name: 'Hot', pricePaise: 0 }],
    };
    expect(priceItemWithModifiers(paneer, [spice], ['m-hot']).unitPricePaise).toBe(25000);
  });
});

describe('Order and add-on group requests', () => {
  it('drops any price the client sends for an item or an add-on', () => {
    const parsed = createOrderSchema.parse({
      items: [{
        menuItemId: '7d1f4b56-1b8e-4a6c-9a3e-2f1c0d9b8a71',
        quantity: 1,
        unitPricePaise: 1,
        modifiers: [{ id: '0b9a8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d', name: 'Free', pricePaise: -5000 }],
      }],
    });
    expect(parsed.items[0]).not.toHaveProperty('unitPricePaise');
    expect(parsed.items[0].modifiers).toEqual([{ id: '0b9a8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d' }]);
  });

  it('rejects an add-on group whose minimum is above its maximum', () => {
    expect(createModifierGroupSchema.safeParse({ name: 'Toppings', minSelection: 3, maxSelection: 1 }).success).toBe(false);
    expect(updateModifierGroupSchema.safeParse({ minSelection: 3, maxSelection: 1 }).success).toBe(false);
    expect(createModifierGroupSchema.safeParse({ name: 'Toppings', minSelection: 1, maxSelection: 3 }).success).toBe(true);
  });
});
