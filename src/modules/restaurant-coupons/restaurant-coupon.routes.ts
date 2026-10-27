import { Router } from 'express';
import { RestaurantCouponController } from './restaurant-coupon.controller';
import { authMiddleware } from '../../middleware/auth.middleware';
import { businessMiddleware } from '../../middleware/business.middleware';
import { authorize } from '../../middleware/role.middleware';
import { validate } from '../../middleware/validate.middleware';
import {
  createRestaurantCouponSchema,
  updateRestaurantCouponSchema,
  validateRestaurantCouponSchema,
} from './restaurant-coupon.schema';

const router = Router();
const controller = new RestaurantCouponController();

router.use(authMiddleware);
router.use(businessMiddleware);

// Validation endpoint at bill settlement (Cashier/Staff, Manager, Owner)
router.post(
  '/validate',
  authorize('BUSINESS_OWNER', 'MANAGER', 'STAFF', 'SUPER_ADMIN'),
  validate({ body: validateRestaurantCouponSchema }),
  controller.validate
);

// Management endpoints (Only Business Owner and Manager)
router.get(
  '/',
  authorize('BUSINESS_OWNER', 'MANAGER', 'SUPER_ADMIN'),
  controller.list
);

router.post(
  '/',
  authorize('BUSINESS_OWNER', 'MANAGER', 'SUPER_ADMIN'),
  validate({ body: createRestaurantCouponSchema }),
  controller.create
);

router.patch(
  '/:id/status',
  authorize('BUSINESS_OWNER', 'MANAGER', 'SUPER_ADMIN'),
  validate({ body: updateRestaurantCouponSchema }),
  controller.toggleStatus
);

router.delete(
  '/:id',
  authorize('BUSINESS_OWNER', 'MANAGER', 'SUPER_ADMIN'),
  controller.delete
);

export default router;
