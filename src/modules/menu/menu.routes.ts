import { Router } from 'express';
import { MenuController } from './menu.controller';
import { authMiddleware } from '../../middleware/auth.middleware';
import { businessMiddleware } from '../../middleware/business.middleware';
import { authorize } from '../../middleware/role.middleware';
import { validate } from '../../middleware/validate.middleware';
import {
  createCategorySchema,
  createMenuItemSchema,
  updateMenuItemSchema,
  updateCategorySchema,
  createModifierGroupSchema,
  updateModifierGroupSchema,
} from './menu.schema';

const router = Router();
const controller = new MenuController();

// Public/logged-in menu fetch
router.get('/', authMiddleware, businessMiddleware, controller.getPublicMenu);

// Category management
router.get('/categories', authMiddleware, businessMiddleware, controller.getCategories);
router.post('/categories', authMiddleware, businessMiddleware, authorize('BUSINESS_OWNER', 'MANAGER'), validate({ body: createCategorySchema }), controller.createCategory);
router.patch('/categories/:id', authMiddleware, businessMiddleware, authorize('BUSINESS_OWNER', 'MANAGER'), validate({ body: updateCategorySchema }), controller.updateCategory);
router.delete('/categories/:id', authMiddleware, businessMiddleware, authorize('BUSINESS_OWNER', 'MANAGER'), controller.deleteCategory);

// Item management
router.get('/items', authMiddleware, businessMiddleware, controller.getMenuItems);
router.post('/items', authMiddleware, businessMiddleware, authorize('BUSINESS_OWNER', 'MANAGER'), validate({ body: createMenuItemSchema }), controller.createMenuItem);
router.patch('/items/:id', authMiddleware, businessMiddleware, authorize('BUSINESS_OWNER', 'MANAGER'), validate({ body: updateMenuItemSchema }), controller.updateMenuItem);
router.patch('/items/:id/status', authMiddleware, businessMiddleware, authorize('BUSINESS_OWNER', 'MANAGER'), controller.toggleMenuItemStatus);
router.delete('/items/:id', authMiddleware, businessMiddleware, authorize('BUSINESS_OWNER', 'MANAGER'), controller.deleteMenuItem);

// Modifier Groups management
router.get('/modifier-groups', authMiddleware, businessMiddleware, controller.getModifierGroups);
router.get('/modifier-groups/:id', authMiddleware, businessMiddleware, controller.getModifierGroupById);
router.post('/modifier-groups', authMiddleware, businessMiddleware, authorize('BUSINESS_OWNER', 'MANAGER'), validate({ body: createModifierGroupSchema }), controller.createModifierGroup);
router.patch('/modifier-groups/:id', authMiddleware, businessMiddleware, authorize('BUSINESS_OWNER', 'MANAGER'), validate({ body: updateModifierGroupSchema }), controller.updateModifierGroup);
router.delete('/modifier-groups/:id', authMiddleware, businessMiddleware, authorize('BUSINESS_OWNER', 'MANAGER'), controller.deleteModifierGroup);

export default router;

