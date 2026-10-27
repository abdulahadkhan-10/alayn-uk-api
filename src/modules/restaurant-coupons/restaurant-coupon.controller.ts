import { Request, Response, NextFunction } from 'express';
import { RestaurantCouponService } from './restaurant-coupon.service';
import { sendSuccess } from '../../utils/response';
import { AppError } from '../../utils/AppError';

export class RestaurantCouponController {
  private service = new RestaurantCouponService();

  create = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const businessId = req.user?.businessId;
      if (!businessId) {
        throw new AppError('BUSINESS_REQUIRED', 'Business context is required to create coupons', 400);
      }
      const createdById = req.user!.id;
      const result = await this.service.createCoupon(businessId, createdById, req.body);
      return sendSuccess(res, result, 201);
    } catch (error) {
      next(error);
    }
  };

  list = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const businessId = req.user?.businessId;
      if (!businessId) {
        throw new AppError('BUSINESS_REQUIRED', 'Business context is required to view coupons', 400);
      }
      const outletId = (req.query.outletId as string) || req.outletId;
      const result = await this.service.getCoupons(businessId, outletId);
      return sendSuccess(res, result);
    } catch (error) {
      next(error);
    }
  };

  toggleStatus = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const businessId = req.user?.businessId;
      if (!businessId) {
        throw new AppError('BUSINESS_REQUIRED', 'Business context is required', 400);
      }
      const { id } = req.params;
      const { isActive } = req.body;
      const result = await this.service.toggleCouponStatus(businessId, id, isActive);
      return sendSuccess(res, result);
    } catch (error) {
      next(error);
    }
  };

  delete = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const businessId = req.user?.businessId;
      if (!businessId) {
        throw new AppError('BUSINESS_REQUIRED', 'Business context is required', 400);
      }
      const { id } = req.params;
      const result = await this.service.deleteCoupon(businessId, id);
      return sendSuccess(res, result);
    } catch (error) {
      next(error);
    }
  };

  validate = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const businessId = req.user?.businessId;
      if (!businessId) {
        throw new AppError('BUSINESS_REQUIRED', 'Business context is required', 400);
      }
      const outletId = req.body.outletId || req.outletId;
      if (!outletId) {
        throw new AppError('OUTLET_REQUIRED', 'Outlet ID is required for coupon validation', 400);
      }

      const { code } = req.body;
      const subtotalPaise = req.body.subtotalPaise ?? (req.body.subtotalAmount ? Math.round(req.body.subtotalAmount * 100) : 0);

      const result = await this.service.validateCoupon(businessId, outletId, code, subtotalPaise);
      return sendSuccess(res, result);
    } catch (error) {
      next(error);
    }
  };
}
