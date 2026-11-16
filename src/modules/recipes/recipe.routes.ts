import { Router } from 'express';
import { RecipeController } from './recipe.controller';
import { authMiddleware } from '../../middleware/auth.middleware';
import { businessMiddleware } from '../../middleware/business.middleware';
import { authorize } from '../../middleware/role.middleware';
import { validate } from '../../middleware/validate.middleware';
import { saveModifierRecipeSchema, saveRecipeSchema } from './recipe.schema';

const controller = new RecipeController();

/** Mounted at /menu/items: one dish's recipe at the selected branch */
export const menuItemRecipeRouter = Router();
menuItemRecipeRouter.get('/:id/recipe', authMiddleware, businessMiddleware, authorize('BUSINESS_OWNER', 'MANAGER', 'STAFF', 'KITCHEN'), controller.get);
menuItemRecipeRouter.put('/:id/recipe', authMiddleware, businessMiddleware, authorize('BUSINESS_OWNER', 'MANAGER'), validate({ body: saveRecipeSchema }), controller.save);
menuItemRecipeRouter.delete('/:id/recipe', authMiddleware, businessMiddleware, authorize('BUSINESS_OWNER', 'MANAGER'), controller.remove);

/** Mounted at /inventory/recipes: which dishes have recipes, with cost and margin */
export const inventoryRecipeRouter = Router();
inventoryRecipeRouter.get('/', authMiddleware, businessMiddleware, authorize('BUSINESS_OWNER', 'MANAGER'), controller.coverage);

/** Mounted at /inventory/variance: theoretical vs actual ingredient usage between stock counts */
export const inventoryVarianceRouter = Router();
inventoryVarianceRouter.get('/', authMiddleware, businessMiddleware, authorize('BUSINESS_OWNER', 'MANAGER'), controller.usageVariance);

/** Mounted at /menu/modifier-items: the recipe of one add-on / option choice at the selected branch */
export const modifierRecipeRouter = Router();
modifierRecipeRouter.get('/:id/recipe', authMiddleware, businessMiddleware, authorize('BUSINESS_OWNER', 'MANAGER', 'STAFF', 'KITCHEN'), controller.getModifier);
modifierRecipeRouter.put('/:id/recipe', authMiddleware, businessMiddleware, authorize('BUSINESS_OWNER', 'MANAGER'), validate({ body: saveModifierRecipeSchema }), controller.saveModifier);
modifierRecipeRouter.delete('/:id/recipe', authMiddleware, businessMiddleware, authorize('BUSINESS_OWNER', 'MANAGER'), controller.removeModifier);
