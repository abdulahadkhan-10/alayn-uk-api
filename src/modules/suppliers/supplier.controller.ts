import { Request, Response, NextFunction } from 'express';
import { SupplierService } from './supplier.service';
import { sendSuccess } from '../../utils/response';
import { AppError } from '../../utils/AppError';

export class SupplierController {
  private supplierService = new SupplierService();

  getMyProfile = async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new AppError('UNAUTHORIZED', 'Authentication required', 401);
      const result = await this.supplierService.getMyProfile(req.user.id);
      return sendSuccess(res, result);
    } catch (error) {
      next(error);
    }
  };

  updateMyProfile = async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new AppError('UNAUTHORIZED', 'Authentication required', 401);
      const result = await this.supplierService.updateMyProfile(req.user.id, req.body);
      return sendSuccess(res, result);
    } catch (error) {
      next(error);
    }
  };

  getMyCatalog = async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new AppError('UNAUTHORIZED', 'Authentication required', 401);
      const items = await this.supplierService.getMyCatalog(req.user.id);
      return sendSuccess(res, items);
    } catch (error) {
      next(error);
    }
  };

  createMyItem = async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new AppError('UNAUTHORIZED', 'Authentication required', 401);
      const item = await this.supplierService.createMyItem(req.user.id, req.body);
      return sendSuccess(res, item, 201);
    } catch (error) {
      next(error);
    }
  };

  updateMyItem = async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new AppError('UNAUTHORIZED', 'Authentication required', 401);
      const { id } = req.params;
      const item = await this.supplierService.updateMyItem(req.user.id, id, req.body);
      return sendSuccess(res, item);
    } catch (error) {
      next(error);
    }
  };

  deleteMyItem = async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new AppError('UNAUTHORIZED', 'Authentication required', 401);
      const { id } = req.params;
      await this.supplierService.deleteMyItem(req.user.id, id);
      return sendSuccess(res, { message: 'Item removed from catalog successfully' });
    } catch (error) {
      next(error);
    }
  };

  // Query is already parsed and defaulted by marketplaceQuerySchema
  getMarketplaceSuppliers = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await this.supplierService.getMarketplaceSuppliers(req.query as any);
      return sendSuccess(res, result);
    } catch (error) {
      next(error);
    }
  };

  getMarketplaceSupplierItems = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const items = await this.supplierService.getMarketplaceSupplierItems(req.params.supplierId);
      return sendSuccess(res, items);
    } catch (error) {
      next(error);
    }
  };

  getMarketCatalog = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { search, category, inStockOnly, maxPricePence } = req.query;
      const items = await this.supplierService.getMarketCatalog({
        search: typeof search === 'string' ? search : undefined,
        category: typeof category === 'string' ? category : undefined,
        inStockOnly: inStockOnly === 'true',
        maxPricePence: maxPricePence ? Number(maxPricePence) : undefined,
      });
      return sendSuccess(res, items);
    } catch (error) {
      next(error);
    }
  };

  compareSuppliers = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { itemName, category, currentUnitCostPence, unit } = req.query;
      const result = await this.supplierService.compareSuppliers({
        itemName: typeof itemName === 'string' ? itemName : undefined,
        category: typeof category === 'string' ? category : undefined,
        currentUnitCostPence: currentUnitCostPence ? Number(currentUnitCostPence) : undefined,
        unit: typeof unit === 'string' ? unit : undefined,
      });
      return sendSuccess(res, result);
    } catch (error) {
      next(error);
    }
  };
}
