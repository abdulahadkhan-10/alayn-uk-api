import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth.middleware';
import { AdminService, CouponProduct } from './admin.service';
import { CouponStatusFilter } from '../subscription/couponAdmin';
import { sendSuccess } from '../../utils/response';

// Which product's coupons a request targets: ?product=lite, otherwise Alayn
const couponProduct = (req: AuthenticatedRequest): CouponProduct =>
  req.query.product === 'lite' ? 'lite' : 'alayn';

export class AdminController {
  private service = new AdminService();

  getDashboard = async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await this.service.getDashboard();
      return sendSuccess(res, data);
    } catch (error) {
      next(error);
    }
  };

  getOutlets = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const page = Math.max(1, parseInt(String(req.query.page), 10) || 1);
      const limit = Math.max(1, Math.min(100, parseInt(String(req.query.limit), 10) || 20));
      const search = req.query.search ? String(req.query.search).trim() : undefined;

      const result = await this.service.getOutlets(page, limit, search);
      return sendSuccess(res, result);
    } catch (error) {
      next(error);
    }
  };

  getOutletDetails = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const data = await this.service.getOutletDetails(id);
      return sendSuccess(res, data);
    } catch (error) {
      next(error);
    }
  };

  getCoupons = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const page = Math.max(1, parseInt(String(req.query.page), 10) || 1);
      const limit = Math.max(1, Math.min(100, parseInt(String(req.query.limit), 10) || 20));
      const status = (req.query.status as CouponStatusFilter) || 'ALL';
      const search = req.query.search ? String(req.query.search).trim() : undefined;

      const result = await this.service.getCoupons(page, limit, status, search, couponProduct(req));
      return sendSuccess(res, result);
    } catch (error) {
      next(error);
    }
  };

  createCoupon = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const adminUserId = req.user?.id;
      const result = await this.service.createCoupon(req.body, adminUserId, couponProduct(req));
      return sendSuccess(res, result, 201);
    } catch (error) {
      next(error);
    }
  };

  updateCoupon = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const result = await this.service.updateCoupon(id, req.body, couponProduct(req));
      return sendSuccess(res, result);
    } catch (error) {
      next(error);
    }
  };

  deleteCoupon = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const result = await this.service.deleteCoupon(id, couponProduct(req));
      return sendSuccess(res, { message: 'Coupon deleted or deactivated successfully', result });
    } catch (error) {
      next(error);
    }
  };

  deleteBusiness = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const result = await this.service.deleteBusiness(id);
      return sendSuccess(res, {
        message: `Outlet enterprise "${result.name}" and all associated data permanently deleted from database`,
        result,
      });
    } catch (error) {
      next(error);
    }
  };

  deleteBranch = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const result = await this.service.deleteBranch(id);
      return sendSuccess(res, {
        message: `Branch "${result.name}" and all associated records permanently deleted from database`,
        result,
      });
    } catch (error) {
      next(error);
    }
  };
}
export default AdminController;
