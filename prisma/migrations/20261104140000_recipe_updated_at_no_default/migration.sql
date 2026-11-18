-- Prisma sets Recipe."updatedAt" itself (@updatedAt); the column needs no database default.
-- Runs after 20261104120000_recipe_inventory, which creates the column. Safe to re-run.
ALTER TABLE "Recipe" ALTER COLUMN "updatedAt" DROP DEFAULT;
