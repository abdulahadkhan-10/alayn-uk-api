import { Router } from 'express';
import { SupplierController } from './supplier.controller';
import authMiddleware from '../../middleware/auth.middleware';
import authorize from '../../middleware/role.middleware';
import { validate } from '../../middleware/validate.middleware';
import {
  createSupplierItemSchema,
  updateSupplierItemSchema,
  updateSupplierProfileSchema,
  marketplaceQuerySchema,
  marketplaceSupplierParamsSchema,
} from './supplier.schema';

const router = Router();
const controller = new SupplierController();

// Supplier self-service endpoints (Require SUPPLIER role)
router.get('/my-profile', authMiddleware, authorize('SUPPLIER'), controller.getMyProfile);
router.patch(
  '/my-profile',
  authMiddleware,
  authorize('SUPPLIER'),
  validate({ body: updateSupplierProfileSchema }),
  controller.updateMyProfile
);

router.get('/my-catalog', authMiddleware, authorize('SUPPLIER'), controller.getMyCatalog);
router.post(
  '/my-catalog',
  authMiddleware,
  authorize('SUPPLIER'),
  validate({ body: createSupplierItemSchema }),
  controller.createMyItem
);
router.patch(
  '/my-catalog/:id',
  authMiddleware,
  authorize('SUPPLIER'),
  validate({ body: updateSupplierItemSchema }),
  controller.updateMyItem
);
router.delete('/my-catalog/:id', authMiddleware, authorize('SUPPLIER'), controller.deleteMyItem);

// Restaurant procurement & comparison endpoints (Accessible to restaurant managers & owners)
router.get(
  '/market-catalog',
  authMiddleware,
  authorize('SUPER_ADMIN', 'BUSINESS_OWNER', 'MANAGER', 'STAFF'),
  controller.getMarketCatalog
);

// Paged marketplace: one row per supplier, searched and sorted in the database
router.get(
  '/marketplace',
  authMiddleware,
  authorize('SUPER_ADMIN', 'BUSINESS_OWNER', 'MANAGER', 'STAFF'),
  validate({ query: marketplaceQuerySchema }),
  controller.getMarketplaceSuppliers
);

router.get(
  '/marketplace/:supplierId/items',
  authMiddleware,
  authorize('SUPER_ADMIN', 'BUSINESS_OWNER', 'MANAGER', 'STAFF'),
  validate({ params: marketplaceSupplierParamsSchema }),
  controller.getMarketplaceSupplierItems
);

router.get(
  '/compare',
  authMiddleware,
  authorize('SUPER_ADMIN', 'BUSINESS_OWNER', 'MANAGER', 'STAFF'),
  controller.compareSuppliers
);

export default router;
