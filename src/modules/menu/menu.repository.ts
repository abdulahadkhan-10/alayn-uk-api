import { prisma } from '../../config/prisma';
import { NO_MATCH_UUID, isAllOutlets, menuItemScope, outletScope } from '../../utils/tenantScope';

// Linked add-on groups for a menu item. Soft-deleted groups are hidden here; inactive ones are
// still loaded so the item editor keeps their links, and formatItem drops them from what is sold.
export const modifierGroupsInclude = {
  where: { modifierGroup: { deletedAt: null } },
  orderBy: { sortOrder: 'asc' as const },
  include: {
    modifierGroup: {
      include: {
        modifiers: {
          where: { isActive: true },
          orderBy: { sortOrder: 'asc' as const },
        },
      },
    },
  },
};

export class MenuRepository {
  async createCategory(outletId: string, data: any) {
    return prisma.menuCategory.create({
      data: {
        ...data,
        outletId,
      },
    });
  }

  async createMenuItem(outletId: string, data: any) {
    const { outletIds, modifierGroupIds, ...itemData } = data;
    const targetOutletIds: string[] = Array.isArray(outletIds) && outletIds.length > 0
      ? outletIds
      : (outletId && outletId !== 'all' ? [outletId] : []);

    const primaryOutletId = targetOutletIds[0] || (outletId !== 'all' ? outletId : null);

    const createData: any = {
      ...itemData,
      outletId: primaryOutletId,
    };

    if (targetOutletIds.length > 0) {
      createData.outlets = {
        createMany: {
          data: targetOutletIds.map((outId: string) => ({
            outletId: outId,
          })),
          skipDuplicates: true,
        },
      };
    }

    if (Array.isArray(modifierGroupIds) && modifierGroupIds.length > 0) {
      createData.modifierGroups = {
        createMany: {
          data: modifierGroupIds.map((mGroupId: string, idx: number) => ({
            modifierGroupId: mGroupId,
            sortOrder: idx,
          })),
          skipDuplicates: true,
        },
      };
    }

    return prisma.menuItem.create({
      data: createData,
      include: {
        category: true,
        outlets: { select: { outletId: true, isActive: true } },
        modifierGroups: modifierGroupsInclude,
      },
    });
  }

  async getCategories(outletId: string, businessId?: string) {
    const where: any = { deletedAt: null };
    if (outletId && outletId !== "all") {
      where.outletId = outletId;
    } else if (businessId) {
      where.outlet = { businessId };
    }

    return prisma.menuCategory.findMany({
      where,
      orderBy: { createdAt: "asc" },
      include: {
        menuItems: {
          where: { deletedAt: null },
          include: {
            outlet: { select: { id: true, name: true } },
            outlets: { select: { outletId: true, isActive: true } },
          },
        },
      },
    });
  }

  async getMenuItems(outletId: string, categoryId?: string, search?: string, businessId?: string, isAvailable?: string, isVeg?: string, dietaryType?: string) {
    const where: any = { deletedAt: null };
    if (outletId && outletId !== "all") {
      where.OR = [
        { outletId },
        { outlets: { some: { outletId } } },
      ];
    } else if (businessId) {
      where.OR = [
        { outlet: { businessId } },
        { outlets: { some: { outlet: { businessId } } } },
      ];
    }

    if (categoryId && categoryId !== "ALL") {
      where.categoryId = categoryId;
    }
    if (search) {
      const searchCond = [
        { name: { contains: search, mode: "insensitive" } },
        { description: { contains: search, mode: "insensitive" } },
      ];
      if (where.OR) {
        where.AND = [{ OR: searchCond }];
      } else {
        where.OR = searchCond;
      }
    }
    if (isAvailable !== undefined && isAvailable !== null && isAvailable !== "") {
      const isAvailBool = isAvailable === "true" || isAvailable === "1";
      if (outletId && outletId !== "all") {
        where.outlets = {
          some: {
            outletId,
            isActive: isAvailBool,
          }
        };
      } else {
        where.isActive = isAvailBool;
      }
    }
    if (dietaryType && ["VEG", "NON_VEG", "VEGAN"].includes(dietaryType.toUpperCase())) {
      where.dietaryType = dietaryType.toUpperCase();
    } else if (isVeg !== undefined && isVeg !== null && isVeg !== "") {
      const vegBool = isVeg === "true" || isVeg === "1";
      if (vegBool) {
        where.dietaryType = { in: ["VEG", "VEGAN"] };
      } else {
        where.dietaryType = "NON_VEG";
      }
    }

    return prisma.menuItem.findMany({
      where,
      include: {
        category: true,
        outlets: { select: { outletId: true, isActive: true } },
        modifierGroups: modifierGroupsInclude,
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async updateMenuItem(outletId: string, id: string, data: any) {
    const { outletIds, modifierGroupIds, ...updateData } = data;

    return (prisma as any).$transaction(async (tx: any) => {
      // Handle status toggle (isActive / availability)
      if (updateData.isActive !== undefined) {
        const itemIsActive = updateData.isActive;
        delete updateData.isActive;

        if (outletId && outletId !== "all") {
          await tx.menuItemOutlet.updateMany({
            where: { menuItemId: id, outletId },
            data: { isActive: itemIsActive },
          });
        } else {
          await tx.menuItem.updateMany({
            where: { id, deletedAt: null },
            data: { isActive: itemIsActive },
          });
          await tx.menuItemOutlet.updateMany({
            where: { menuItemId: id },
            data: { isActive: itemIsActive },
          });
        }
      }

      if (Object.keys(updateData).length > 0) {
        await tx.menuItem.updateMany({
          where: { id, deletedAt: null },
          data: updateData,
        });
      }

      if (Array.isArray(modifierGroupIds)) {
        await tx.menuItemModifierGroup.deleteMany({
          where: { menuItemId: id },
        });
        if (modifierGroupIds.length > 0) {
          await tx.menuItemModifierGroup.createMany({
            data: modifierGroupIds.map((mGroupId: string, idx: number) => ({
              menuItemId: id,
              modifierGroupId: mGroupId,
              sortOrder: idx,
            })),
            skipDuplicates: true,
          });
        }
      }

      if (Array.isArray(outletIds)) {
        if (outletIds.length === 0) {
          // Soft delete the item if it's no longer assigned to any outlets
          await tx.menuItem.updateMany({
            where: { id, deletedAt: null },
            data: { deletedAt: new Date() },
          });
        } else {
          // Sync MenuItemOutlet records
          await tx.menuItemOutlet.deleteMany({
            where: {
              menuItemId: id,
              outletId: { notIn: outletIds },
            },
          });

          await tx.menuItemOutlet.createMany({
            data: outletIds.map((outId: string) => ({
              menuItemId: id,
              outletId: outId,
            })),
            skipDuplicates: true,
          });

          await tx.menuItem.update({
            where: { id },
            data: { outletId: outletIds[0] },
          });
        }
      }
    }, { maxWait: 10000, timeout: 20000 });
  }

  async findCategoryById(outletId: string, id: string, businessId?: string | null) {
    // Selected outlet's category, or in "all outlets" mode one of the caller's business
    return prisma.menuCategory.findFirst({
      where: { id, deletedAt: null, ...outletScope(outletId, businessId) },
    });
  }

  async findMenuItemById(outletId: string, id: string, businessId?: string | null) {
    // Only items sold at the selected outlet, or in "all outlets" mode at any of the caller's outlets
    return prisma.menuItem.findFirst({
      where: { id, deletedAt: null, ...menuItemScope(outletId, businessId) },
      include: {
        category: true,
        outlets: { select: { outletId: true, isActive: true } },
        modifierGroups: modifierGroupsInclude,
      },
    });
  }

  async deleteMenuItem(outletId: string, id: string) {
    // Perform soft delete
    return prisma.menuItem.updateMany({
      where: { id, deletedAt: null },
      data: { deletedAt: new Date() },
    });
  }

  async updateCategory(id: string, data: any) {
    return prisma.menuCategory.update({
      where: { id },
      data,
    });
  }

  async deleteCategory(id: string) {
    return prisma.$transaction([
      prisma.menuCategory.update({
        where: { id },
        data: { deletedAt: new Date() },
      }),
      prisma.menuItem.updateMany({
        where: { categoryId: id, deletedAt: null },
        data: { deletedAt: new Date() },
      }),
    ]);
  }

  async findPublicMenu(outletId: string, businessId?: string | null) {
    // Items available at this outlet (or, in "all outlets" mode, at any of the caller's outlets)
    const availableHere = isAllOutlets(outletId)
      ? { outlet: { businessId: businessId || NO_MATCH_UUID }, isActive: true }
      : { outletId, isActive: true };
    const itemWhere = {
      isActive: true,
      deletedAt: null,
      outlets: { some: availableHere },
    };

    return prisma.menuCategory.findMany({
      // Only categories that actually contain such items — never other businesses' categories
      where: { isActive: true, deletedAt: null, menuItems: { some: itemWhere } },
      include: {
        menuItems: {
          where: itemWhere,
          include: {
            outlets: { select: { outletId: true, isActive: true } },
            modifierGroups: modifierGroupsInclude,
          },
        },
      },
    });
  }

  // ── Modifier Groups & Items ──────────────────────────────────────────────

  async getModifierGroups(businessId: string, outletId?: string | null) {
    const where: any = { businessId, deletedAt: null };
    if (outletId && outletId !== 'all') {
      where.OR = [
        { outletId },
        { outletId: null },
      ];
    }
    return prisma.modifierGroup.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        modifiers: {
          orderBy: { sortOrder: 'asc' },
        },
        _count: {
          select: { menuItems: true },
        },
      },
    });
  }

  async findModifierGroupById(id: string, businessId?: string | null) {
    const where: any = { id, deletedAt: null };
    if (businessId) where.businessId = businessId;
    return prisma.modifierGroup.findFirst({
      where,
      include: {
        modifiers: {
          orderBy: { sortOrder: 'asc' },
        },
      },
    });
  }

  /** Of the given group ids, the ones that are live groups of this business */
  async findOwnedModifierGroupIds(businessId: string, ids: string[]) {
    if (ids.length === 0) return [];
    const groups = await prisma.modifierGroup.findMany({
      where: { id: { in: ids }, businessId, deletedAt: null },
      select: { id: true },
    });
    return groups.map((g) => g.id);
  }

  async createModifierGroup(businessId: string, data: any) {
    const { modifiers, outletId, ...groupData } = data;
    return prisma.modifierGroup.create({
      data: {
        ...groupData,
        businessId,
        outletId: outletId && outletId !== 'all' ? outletId : null,
        modifiers: Array.isArray(modifiers) && modifiers.length > 0 ? {
          createMany: {
            data: modifiers.map((m: any, idx: number) => toModifierItemData(m, idx)),
          },
        } : undefined,
      },
      include: {
        modifiers: {
          orderBy: { sortOrder: 'asc' },
        },
      },
    });
  }

  async updateModifierGroup(id: string, businessId: string, data: any) {
    const { modifiers, outletId, ...groupData } = data;

    return prisma.$transaction(async (tx) => {
      const updatePayload: any = { ...groupData };
      if (outletId !== undefined) {
        updatePayload.outletId = outletId && outletId !== 'all' ? outletId : null;
      }

      await tx.modifierGroup.update({
        where: { id, businessId },
        data: updatePayload,
      });

      if (Array.isArray(modifiers)) {
        // Only ids that already belong to this group are updated; anything else is created fresh,
        // so a request can never touch another group's (or another business's) options.
        const existing = await tx.modifierItem.findMany({
          where: { groupId: id },
          select: { id: true },
        });
        const existingIds = new Set(existing.map((m) => m.id));
        const keptIds = modifiers.map((m: any) => m.id).filter((mId: any) => mId && existingIds.has(mId));

        await tx.modifierItem.deleteMany({
          where: {
            groupId: id,
            id: { notIn: keptIds },
          },
        });

        for (let idx = 0; idx < modifiers.length; idx++) {
          const m = modifiers[idx];
          const itemData = toModifierItemData(m, idx);
          if (m.id && existingIds.has(m.id)) {
            await tx.modifierItem.update({
              where: { id: m.id },
              data: itemData,
            });
          } else {
            await tx.modifierItem.create({
              data: { ...itemData, groupId: id },
            });
          }
        }
      }

      return tx.modifierGroup.findUnique({
        where: { id },
        include: {
          modifiers: {
            orderBy: { sortOrder: 'asc' },
          },
        },
      });
    }, { maxWait: 10000, timeout: 20000 });
  }

  async deleteModifierGroup(id: string, businessId: string) {
    return prisma.modifierGroup.update({
      where: { id, businessId },
      data: { deletedAt: new Date(), isActive: false },
    });
  }
}

function toModifierItemData(m: any, idx: number) {
  return {
    name: m.name,
    pricePaise: m.pricePaise ?? (m.price ? Math.round(m.price * 100) : 0),
    isVeg: m.isVeg ?? true,
    dietaryType: m.dietaryType || (m.isVeg === false ? 'NON_VEG' : 'VEG'),
    isActive: m.isActive ?? true,
    sortOrder: m.sortOrder ?? idx,
  };
}

export default MenuRepository;
