import { prisma } from './prisma';
import { logger } from './logger';

// The production image runs `node dist/server.js` without `prisma migrate deploy`, so the add-on
// tables from migration 20261017150000_add_menu_modifiers are also ensured here. Every statement is
// idempotent and matches that migration, so running `migrate deploy` later is still safe.
export async function ensureModifierTables() {
  try {
    // 1. Column on OrderItem
    await prisma.$executeRawUnsafe(`ALTER TABLE "OrderItem" ADD COLUMN IF NOT EXISTS "modifiersJson" TEXT;`);

    // 2. ModifierGroup table
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "ModifierGroup" (
        "id" UUID NOT NULL,
        "businessId" UUID NOT NULL,
        "outletId" UUID,
        "name" TEXT NOT NULL,
        "description" TEXT,
        "minSelection" INTEGER NOT NULL DEFAULT 0,
        "maxSelection" INTEGER,
        "isActive" BOOLEAN NOT NULL DEFAULT true,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "deletedAt" TIMESTAMP(3),
        CONSTRAINT "ModifierGroup_pkey" PRIMARY KEY ("id")
      );
    `);

    // 3. ModifierItem table
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "ModifierItem" (
        "id" UUID NOT NULL,
        "groupId" UUID NOT NULL,
        "name" TEXT NOT NULL,
        "pricePaise" INTEGER NOT NULL DEFAULT 0,
        "isVeg" BOOLEAN NOT NULL DEFAULT true,
        "dietaryType" "DietaryType" NOT NULL DEFAULT 'VEG',
        "isActive" BOOLEAN NOT NULL DEFAULT true,
        "sortOrder" INTEGER NOT NULL DEFAULT 0,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "ModifierItem_pkey" PRIMARY KEY ("id")
      );
    `);

    // 4. MenuItemModifierGroup join table
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "MenuItemModifierGroup" (
        "id" UUID NOT NULL,
        "menuItemId" UUID NOT NULL,
        "modifierGroupId" UUID NOT NULL,
        "sortOrder" INTEGER NOT NULL DEFAULT 0,
        CONSTRAINT "MenuItemModifierGroup_pkey" PRIMARY KEY ("id")
      );
    `);

    // 5. Indexes
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "ModifierGroup_businessId_isActive_idx" ON "ModifierGroup"("businessId", "isActive");`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "ModifierGroup_outletId_idx" ON "ModifierGroup"("outletId");`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "ModifierItem_groupId_isActive_idx" ON "ModifierItem"("groupId", "isActive");`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "MenuItemModifierGroup_menuItemId_idx" ON "MenuItemModifierGroup"("menuItemId");`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "MenuItemModifierGroup_modifierGroupId_idx" ON "MenuItemModifierGroup"("modifierGroupId");`);
    await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "MenuItemModifierGroup_menuItemId_modifierGroupId_key" ON "MenuItemModifierGroup"("menuItemId", "modifierGroupId");`);

    // 6. Foreign key constraints
    await prisma.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ModifierGroup_businessId_fkey') THEN
          ALTER TABLE "ModifierGroup" ADD CONSTRAINT "ModifierGroup_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ModifierGroup_outletId_fkey') THEN
          ALTER TABLE "ModifierGroup" ADD CONSTRAINT "ModifierGroup_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ModifierItem_groupId_fkey') THEN
          ALTER TABLE "ModifierItem" ADD CONSTRAINT "ModifierItem_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ModifierGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MenuItemModifierGroup_menuItemId_fkey') THEN
          ALTER TABLE "MenuItemModifierGroup" ADD CONSTRAINT "MenuItemModifierGroup_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MenuItemModifierGroup_modifierGroupId_fkey') THEN
          ALTER TABLE "MenuItemModifierGroup" ADD CONSTRAINT "MenuItemModifierGroup_modifierGroupId_fkey" FOREIGN KEY ("modifierGroupId") REFERENCES "ModifierGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;
      END $$;
    `);

    logger.info('Modifier tables & schema verified successfully');
  } catch (err: any) {
    logger.error(`Add-on (modifier) tables could not be created — menu and order endpoints will fail until migration 20261017150000_add_menu_modifiers is applied: ${err?.message || err}`);
  }
}
