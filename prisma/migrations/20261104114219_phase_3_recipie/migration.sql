-- Originally dropped the default on Recipe."updatedAt", but that column is only created by the
-- later migration 20261104120000_recipe_inventory, so this failed on any database without it.
-- The drop now happens in 20261104140000_recipe_updated_at_no_default; this is a guarded no-op
-- kept so databases that already applied it stay consistent.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Recipe' AND column_name = 'updatedAt') THEN
    ALTER TABLE "Recipe" ALTER COLUMN "updatedAt" DROP DEFAULT;
  END IF;
END $$;
