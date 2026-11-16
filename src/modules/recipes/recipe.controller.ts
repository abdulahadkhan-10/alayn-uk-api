import { Request, Response, NextFunction } from 'express';
import { RecipeService } from './recipe.service';
import { VarianceService } from './variance.service';
import { ModifierRecipeService } from './modifierRecipe.service';
import { sendSuccess } from '../../utils/response';

export class RecipeController {
  private service = new RecipeService();
  private variance = new VarianceService();
  private modifiers = new ModifierRecipeService();

  private actor(req: Request) {
    return { userId: req.user!.id, role: req.user!.role, businessId: req.user!.businessId };
  }

  get = async (req: Request, res: Response, next: NextFunction) => {
    try {
      return sendSuccess(res, await this.service.getRecipe(req.outletId, req.params.id, req.user?.businessId));
    } catch (error) {
      next(error);
    }
  };

  save = async (req: Request, res: Response, next: NextFunction) => {
    try {
      return sendSuccess(res, await this.service.saveRecipe(req.outletId, req.params.id, req.body, this.actor(req)));
    } catch (error) {
      next(error);
    }
  };

  remove = async (req: Request, res: Response, next: NextFunction) => {
    try {
      return sendSuccess(res, await this.service.deleteRecipe(req.outletId, req.params.id, this.actor(req)));
    } catch (error) {
      next(error);
    }
  };

  coverage = async (req: Request, res: Response, next: NextFunction) => {
    try {
      return sendSuccess(res, await this.service.listCoverage(req.outletId, req.user?.businessId));
    } catch (error) {
      next(error);
    }
  };

  usageVariance = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { from, to } = req.query as { from?: string; to?: string };
      return sendSuccess(res, await this.variance.getVariance(req.outletId, { from, to }));
    } catch (error) {
      next(error);
    }
  };

  getModifier = async (req: Request, res: Response, next: NextFunction) => {
    try {
      return sendSuccess(res, await this.modifiers.getRecipe(req.outletId, req.params.id, req.user?.businessId));
    } catch (error) {
      next(error);
    }
  };

  saveModifier = async (req: Request, res: Response, next: NextFunction) => {
    try {
      return sendSuccess(res, await this.modifiers.saveRecipe(req.outletId, req.params.id, req.body, this.actor(req)));
    } catch (error) {
      next(error);
    }
  };

  removeModifier = async (req: Request, res: Response, next: NextFunction) => {
    try {
      return sendSuccess(res, await this.modifiers.deleteRecipe(req.outletId, req.params.id, this.actor(req)));
    } catch (error) {
      next(error);
    }
  };
}
