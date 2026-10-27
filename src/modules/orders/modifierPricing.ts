import { AppError } from '../../utils/AppError';

export interface PricingModifier {
  id: string;
  name: string;
  pricePaise: number;
}

export interface PricingGroup {
  id: string;
  name: string;
  minSelection: number;
  maxSelection: number | null;
  modifiers: PricingModifier[];
}

export interface ModifierSnapshot {
  id: string;
  groupId: string;
  groupName: string;
  name: string;
  pricePaise: number;
  isVariant: boolean;
}

/**
 * A "variant" group (Half / Full, Regular / Large) is a mandatory single choice with priced options:
 * the chosen option's price replaces the item's base price. Every other group adds its price on top.
 * The POS and QR menus apply the same rule when showing the price.
 */
export function isVariantGroup(group: PricingGroup) {
  return group.minSelection === 1 && group.maxSelection === 1 && group.modifiers.some((m) => m.pricePaise > 0);
}

/**
 * Prices one order line from the database's menu: the client only says which options it picked
 * (by id); names and prices always come from `groups`, and each group's min / max is enforced.
 */
export function priceItemWithModifiers(
  item: { name: string; pricePaise: number },
  groups: PricingGroup[],
  selectedIds: string[],
): { unitPricePaise: number; modifiers: ModifierSnapshot[] } {
  const uniqueIds = [...new Set(selectedIds)];
  const optionById = new Map<string, { group: PricingGroup; modifier: PricingModifier }>();
  for (const group of groups) {
    for (const modifier of group.modifiers) {
      optionById.set(modifier.id, { group, modifier });
    }
  }

  const chosenByGroup = new Map<string, PricingModifier[]>();
  for (const id of uniqueIds) {
    const match = optionById.get(id);
    if (!match) {
      throw new AppError(
        'MODIFIER_NOT_AVAILABLE',
        `An add-on chosen for ${item.name} is no longer available. Please remove it and add the item again.`,
        400,
      );
    }
    const list = chosenByGroup.get(match.group.id) || [];
    list.push(match.modifier);
    chosenByGroup.set(match.group.id, list);
  }

  let basePricePaise = item.pricePaise;
  let extrasPaise = 0;
  const snapshot: ModifierSnapshot[] = [];

  for (const group of groups) {
    const chosen = chosenByGroup.get(group.id) || [];
    if (chosen.length < group.minSelection) {
      throw new AppError('MODIFIER_SELECTION_REQUIRED', `Please choose ${group.name} for ${item.name}`, 400);
    }
    if (group.maxSelection !== null && chosen.length > group.maxSelection) {
      throw new AppError(
        'MODIFIER_SELECTION_LIMIT',
        `You can choose at most ${group.maxSelection} from ${group.name} for ${item.name}`,
        400,
      );
    }

    const variant = isVariantGroup(group);
    for (const modifier of chosen) {
      if (variant) {
        if (modifier.pricePaise > 0) basePricePaise = modifier.pricePaise;
      } else {
        extrasPaise += modifier.pricePaise;
      }
      snapshot.push({
        id: modifier.id,
        groupId: group.id,
        groupName: group.name,
        name: modifier.name,
        pricePaise: modifier.pricePaise,
        isVariant: variant,
      });
    }
  }

  return { unitPricePaise: basePricePaise + extrasPaise, modifiers: snapshot };
}
