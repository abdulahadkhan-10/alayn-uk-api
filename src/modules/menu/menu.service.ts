import { MenuRepository } from './menu.repository';
import { AppError } from '../../utils/AppError';
import { saveBase64Image, deleteImageFile } from '../../utils/file.utils';
import { prisma } from '../../config/prisma';
import { EmployeeActor, assertOutletsAccessible } from '../employees/employee.permissions';

export class MenuService {
  private menuRepository = new MenuRepository();

  private formatItem(item: any, outletId?: string) {
    if (!item) return item;
    const outletIds = Array.isArray(item.outlets) && item.outlets.length > 0
      ? item.outlets.map((o: any) => o.outletId)
      : (item.outletId ? [item.outletId] : []);

    let isAvailable = item.isActive ?? true;
    if (outletId && outletId !== 'all' && Array.isArray(item.outlets)) {
      const mapping = item.outlets.find((o: any) => o.outletId === outletId);
      if (mapping) {
        isAvailable = mapping.isActive;
      }
    }

    // Inactive groups stay linked (so the editor keeps them) but are never offered for sale
    const modifierGroups = (item.modifierGroups || [])
      .map((mg: any) => mg.modifierGroup || mg)
      .filter((g: any) => g && g.isActive !== false)
      .map((g: any) => {
      return {
        id: g.id,
        name: g.name,
        description: g.description,
        minSelection: g.minSelection ?? 0,
        maxSelection: g.maxSelection ?? null,
        modifiers: (g.modifiers || []).map((m: any) => ({
          id: m.id,
          name: m.name,
          price: (m.pricePaise || 0) / 100,
          pricePaise: m.pricePaise || 0,
          isVeg: m.isVeg ?? true,
          dietaryType: m.dietaryType || (m.isVeg === false ? 'NON_VEG' : 'VEG'),
          isActive: m.isActive ?? true,
        })),
      };
    });

    const modifierGroupIds = (item.modifierGroups || []).map((mg: any) => mg.modifierGroupId || mg.modifierGroup?.id || mg.id).filter(Boolean);

    return {
      ...item,
      price: item.pricePaise ? item.pricePaise / 100 : 0,
      isAvailable,
      outletIds,
      modifierGroups,
      modifierGroupIds,
    };
  }

  async createCategory(outletId: string, data: any, businessId?: string) {
    let targetOutletId = outletId;
    if (targetOutletId === 'all') {
      if (businessId) {
        const firstOutlet = await prisma.outlet.findFirst({
          where: { businessId },
          select: { id: true },
        });
        if (firstOutlet) {
          targetOutletId = firstOutlet.id;
        }
      }
      if (targetOutletId === 'all') {
        throw new AppError('BAD_REQUEST', 'Please select a specific branch/outlet to create a category', 400);
      }
    }

    return this.menuRepository.createCategory(targetOutletId, data);
  }

  async getCategories(outletId: string, businessId?: string) {
    const categories = await this.menuRepository.getCategories(outletId, businessId);
    return categories.map((cat: any) => ({
      ...cat,
      items: (cat.menuItems || []).map((item: any) => this.formatItem(item, outletId)),
    }));
  }

  async updateCategory(id: string, data: any, outletId: string, businessId?: string | null) {
    // Only the caller's own categories (selected outlet, or their business in "all outlets" mode)
    const category = await this.menuRepository.findCategoryById(outletId, id, businessId);
    if (!category) {
      throw new AppError('NOT_FOUND', 'Category not found', 404);
    }
    return this.menuRepository.updateCategory(id, data);
  }

  async deleteCategory(id: string, outletId: string, businessId?: string | null) {
    const category = await this.menuRepository.findCategoryById(outletId, id, businessId);
    if (!category) {
      throw new AppError('NOT_FOUND', 'Category not found', 404);
    }
    await this.menuRepository.deleteCategory(id);
    return { success: true, message: 'Category deleted successfully' };
  }

  /** Every add-on group linked to a menu item must be a live group of the caller's business */
  private async assertModifierGroupsOwned(businessId: string | null | undefined, ids: unknown) {
    if (!Array.isArray(ids) || ids.length === 0) return;
    const unique = [...new Set(ids as string[])];
    const owned = businessId ? await this.menuRepository.findOwnedModifierGroupIds(businessId, unique) : [];
    if (owned.length !== unique.length) {
      throw new AppError('MODIFIER_GROUP_NOT_FOUND', 'One or more add-on groups were not found', 404);
    }
  }

  async createMenuItem(outletId: string, data: any, actor: EmployeeActor) {
    const businessId = actor.businessId || undefined;
    if (Array.isArray(data.outletIds) && data.outletIds.length > 0) {
      await assertOutletsAccessible(actor, data.outletIds);
    }
    let targetOutletId = outletId;
    if (targetOutletId === 'all') {
      if (data.categoryId) {
        const cat = await this.menuRepository.findCategoryById('all', data.categoryId, businessId);
        if (cat) {
          targetOutletId = cat.outletId;
        }
      }
      if (targetOutletId === 'all' && businessId) {
        const firstOutlet = await prisma.outlet.findFirst({
          where: { businessId },
          select: { id: true },
        });
        if (firstOutlet) targetOutletId = firstOutlet.id;
      }
      if (targetOutletId === 'all') {
        throw new AppError('BAD_REQUEST', 'Please select a specific branch/outlet to create a menu item', 400);
      }
    }

    // The category must be one of the caller's business
    const category = await this.menuRepository.findCategoryById('all', data.categoryId, businessId);
    if (!category) {
      throw new AppError('CATEGORY_NOT_FOUND', 'Menu category not found', 404);
    }
    await this.assertModifierGroupsOwned(businessId, data.modifierGroupIds);
    
    if (data.price !== undefined && !data.pricePaise) {
      data.pricePaise = Math.round(Number(data.price) * 100);
      delete data.price;
    }
    if (data.isAvailable !== undefined) {
      data.isActive = data.isAvailable;
      delete data.isAvailable;
    }

    if (data.dietaryType) {
      data.isVeg = data.dietaryType !== 'NON_VEG';
    } else if (data.isVeg !== undefined) {
      data.dietaryType = data.isVeg ? 'VEG' : 'NON_VEG';
    }

    if (data.imageUrl && typeof data.imageUrl === 'string' && data.imageUrl.startsWith('data:image/')) {
      const savedPath = await saveBase64Image(data.imageUrl, 'menu-items');
      if (savedPath) {
        data.imageUrl = savedPath;
      }
    } else if (!data.imageUrl) {
      data.imageUrl = null;
    }

    const created = await this.menuRepository.createMenuItem(targetOutletId, data);
    const itemWithCat = await this.menuRepository.findMenuItemById(targetOutletId, created.id);
    return this.formatItem(itemWithCat || created, targetOutletId);
  }

  async getMenuItems(outletId: string, categoryId?: string, search?: string, businessId?: string, isAvailable?: string, isVeg?: string, dietaryType?: string) {
    const items = await this.menuRepository.getMenuItems(outletId, categoryId, search, businessId, isAvailable, isVeg, dietaryType);
    return items.map((item: any) => this.formatItem(item, outletId));
  }

  async updateMenuItem(outletId: string, id: string, data: any, actor: EmployeeActor) {
    const businessId = actor.businessId;
    // The item must be sold at the caller's outlet (or one of their business's outlets in "all outlets" mode)
    const existing = await this.menuRepository.findMenuItemById(outletId, id, businessId);
    if (!existing) {
      throw new AppError('MENU_ITEM_NOT_FOUND', 'Menu item not found', 404);
    }
    if (Array.isArray(data.outletIds) && data.outletIds.length > 0) {
      await assertOutletsAccessible(actor, data.outletIds);
    }
    if (data.categoryId) {
      const category = await this.menuRepository.findCategoryById('all', data.categoryId, businessId);
      if (!category) {
        throw new AppError('CATEGORY_NOT_FOUND', 'Menu category not found', 404);
      }
    }
    await this.assertModifierGroupsOwned(businessId, data.modifierGroupIds);

    if (data.price !== undefined) {
      data.pricePaise = Math.round(Number(data.price) * 100);
      delete data.price;
    }
    if (data.isAvailable !== undefined) {
      data.isActive = data.isAvailable;
      delete data.isAvailable;
    }

    if (data.dietaryType) {
      data.isVeg = data.dietaryType !== 'NON_VEG';
    } else if (data.isVeg !== undefined) {
      data.dietaryType = data.isVeg ? 'VEG' : 'NON_VEG';
    }

    if (data.imageUrl && typeof data.imageUrl === 'string' && data.imageUrl.startsWith('data:image/')) {
      const savedPath = await saveBase64Image(data.imageUrl, 'menu-items');
      if (savedPath) {
        data.imageUrl = savedPath;
      }
    }

    await this.menuRepository.updateMenuItem(outletId, id, data);
    const updated = await this.menuRepository.findMenuItemById('all', id, businessId);
    return this.formatItem(updated || existing, outletId);
  }

  async toggleMenuItemStatus(outletId: string, id: string, isAvailable: boolean, actor: EmployeeActor) {
    return this.updateMenuItem(outletId, id, { isAvailable }, actor);
  }

  async deleteMenuItem(outletId: string, id: string, businessId?: string | null) {
    const item = await this.menuRepository.findMenuItemById(outletId, id, businessId);
    if (!item) {
      throw new AppError('MENU_ITEM_NOT_FOUND', 'Menu item not found', 404);
    }
    if (item.imageUrl) {
      await deleteImageFile(item.imageUrl);
    }
    return this.menuRepository.deleteMenuItem(outletId, id);
  }

  async getPublicMenu(outletId: string, businessId?: string | null) {
    const categories = await this.menuRepository.findPublicMenu(outletId, businessId);
    return categories.map((cat: any) => ({
      ...cat,
      items: (cat.menuItems || []).map((item: any) => this.formatItem(item, outletId)),
    }));
  }

  // ── Modifier Groups ────────────────────────────────────────────────────────

  async getModifierGroups(businessId: string, outletId?: string | null) {
    const groups = await this.menuRepository.getModifierGroups(businessId, outletId);
    return groups.map((g: any) => ({
      ...g,
      modifiers: (g.modifiers || []).map((m: any) => ({
        ...m,
        price: (m.pricePaise || 0) / 100,
      })),
      itemCount: g._count?.menuItems || 0,
    }));
  }

  async getModifierGroupById(id: string, businessId: string) {
    const group = await this.menuRepository.findModifierGroupById(id, businessId);
    if (!group) {
      throw new AppError('NOT_FOUND', 'Modifier group not found', 404);
    }
    return {
      ...group,
      modifiers: (group.modifiers || []).map((m: any) => ({
        ...m,
        price: (m.pricePaise || 0) / 100,
      })),
    };
  }

  /** A group must be satisfiable: min ≤ max, and enough active options to meet the minimum */
  private assertSelectableGroup(minSelection: number, maxSelection: number | null, modifiers: any[]) {
    if (maxSelection !== null && minSelection > maxSelection) {
      throw new AppError('INVALID_SELECTION_RANGE', 'Minimum selection cannot be more than maximum selection', 400);
    }
    const activeOptions = modifiers.filter((m: any) => m.isActive !== false).length;
    if (minSelection > activeOptions) {
      throw new AppError('INVALID_SELECTION_RANGE', `This group needs at least ${minSelection} active option(s)`, 400);
    }
  }

  async createModifierGroup(businessId: string, data: any) {
    this.assertSelectableGroup(data.minSelection ?? 0, data.maxSelection ?? null, data.modifiers || []);
    const group = await this.menuRepository.createModifierGroup(businessId, data);
    return {
      ...group,
      modifiers: (group.modifiers || []).map((m: any) => ({
        ...m,
        price: (m.pricePaise || 0) / 100,
      })),
    };
  }

  async updateModifierGroup(id: string, businessId: string, data: any) {
    const existing = await this.menuRepository.findModifierGroupById(id, businessId);
    if (!existing) {
      throw new AppError('NOT_FOUND', 'Modifier group not found', 404);
    }
    this.assertSelectableGroup(
      data.minSelection ?? existing.minSelection,
      data.maxSelection !== undefined ? data.maxSelection : existing.maxSelection,
      Array.isArray(data.modifiers) ? data.modifiers : existing.modifiers,
    );
    const updated = await this.menuRepository.updateModifierGroup(id, businessId, data);
    return {
      ...updated,
      modifiers: (updated?.modifiers || []).map((m: any) => ({
        ...m,
        price: (m.pricePaise || 0) / 100,
      })),
    };
  }

  async deleteModifierGroup(id: string, businessId: string) {
    const existing = await this.menuRepository.findModifierGroupById(id, businessId);
    if (!existing) {
      throw new AppError('NOT_FOUND', 'Modifier group not found', 404);
    }
    await this.menuRepository.deleteModifierGroup(id, businessId);
    return { success: true, message: 'Modifier group deleted successfully' };
  }
}
export default MenuService;


