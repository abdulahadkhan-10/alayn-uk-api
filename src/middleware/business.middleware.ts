import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/prisma';
import { AppError } from '../utils/AppError';

// Business-level subscriptions predate per-outlet billing. Ones created by a promotional coupon
// (planId COUPON_*) only ever covered the redeemed outlet, which has its own OutletSubscription,
// so they must not unlock the rest of the business.
function isLegacySubActive(sub: { status: string; planId: string } | null) {
  return !!sub && sub.status === 'ACTIVE' && !sub.planId.startsWith('COUPON_');
}

export async function businessMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    return next(new AppError('UNAUTHORIZED', 'Authentication required', 401));
  }

  // Dedicated bypass for Suppliers: Linked to their registered supplier profile
  if (req.user.role === 'SUPPLIER') {
    const supplier = await prisma.supplier.findFirst({
      where: { userId: req.user.id, deletedAt: null },
      include: { outlet: true },
    });
    if (!supplier) {
      return next(new AppError('FORBIDDEN', 'No supplier profile linked to this user account', 403));
    }
    req.outletId = supplier.outletId;
    return next();
  }

  // Everyone except a super admin must belong to a business. Without one, the outlet checks below have
  // nothing to restrict by and would let the account reach any business's outlets.
  if (req.user.role !== 'SUPER_ADMIN' && !req.user.businessId) {
    return next(new AppError('FORBIDDEN', 'Your account is not linked to a business', 403));
  }

  // Retrieve outlet ID from header, query, params, or body
  let outletId = (req.headers['x-outlet-id'] as string) || 
                 (req.query.outletId as string) || 
                 (req.params.outletId as string) || 
                 (req.body.outletId as string);

  const isUuid = (id: string) => /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id);

  // If provided outletId is invalid non-UUID string (and not 'all'), reset it to trigger auto-fallback
  if (outletId && outletId !== 'all' && !isUuid(outletId)) {
    outletId = undefined as any;
  }

  // Fallback: If no valid outletId passed in header, auto-fallback to user's first outlet
  if (!outletId && req.user.businessId) {
    const firstOutlet = await prisma.outlet.findFirst({
      where: { businessId: req.user.businessId },
    });
    if (firstOutlet) {
      outletId = firstOutlet.id;
    }
  }

  if (!outletId) {
    if (req.user.role === 'SUPER_ADMIN') {
      return next(new AppError('OUTLET_REQUIRED', "Super Administrators must provide an explicit 'x-outlet-id' header or query parameter to access branch operations.", 400));
    }
    return next(new AppError('BAD_REQUEST', 'Outlet ID is required for this operation', 400));
  }


  // Support 'all' outlets for business owners/super admins
  if (outletId === 'all') {
    if (req.user.role === 'BUSINESS_OWNER' || req.user.role === 'SUPER_ADMIN') {
      if (req.user.role !== 'SUPER_ADMIN' && req.user.businessId && process.env.NODE_ENV !== 'test') {
        const hasActiveSub = await prisma.outletSubscription.findFirst({
          where: {
            businessId: req.user.businessId,
            status: 'ACTIVE',
            currentPeriodEnd: { gte: new Date() }
          }
        });
        if (!hasActiveSub) {
          const legacySub = await prisma.subscription.findUnique({
            where: { businessId: req.user.businessId },
          });
          if (!isLegacySubActive(legacySub)) {
            return next(new AppError('SUBSCRIPTION_REQUIRED', 'An active subscription is required to access aggregated outlet operations. Please complete payment to activate.', 402));
          }
        }
      }
      req.outletId = 'all';
      return next();
    } else {
      return next(new AppError('FORBIDDEN', 'Only business owners can access aggregated data across all outlets', 403));
    }
  }

  try {
    // 1. Verify the outlet belongs to the user's business (or allow SUPER_ADMIN to inspect any valid outlet)
    const outlet = await prisma.outlet.findFirst({
      where: {
        id: outletId,
        ...(req.user.role !== 'SUPER_ADMIN' && req.user.businessId ? { businessId: req.user.businessId } : {}),
      },
    });

    if (!outlet) {
      return next(new AppError('FORBIDDEN', 'Access to this outlet is denied or does not exist under your business', 403));
    }

    // 2. Verify outlet subscription status (operational features require ACTIVE subscription)
    if (req.user.role !== 'SUPER_ADMIN' && process.env.NODE_ENV !== 'test') {
      const subscription = await prisma.outletSubscription.findUnique({
        where: { outletId: outlet.id },
      });

      const now = new Date();
      const isSubActive = subscription && 
                          subscription.status === 'ACTIVE' && 
                          new Date(subscription.currentPeriodEnd) > now;

      if (!isSubActive) {
        // Fallback: check legacy business-level subscription
        const legacySub = req.user.businessId ? await prisma.subscription.findUnique({
          where: { businessId: req.user.businessId },
        }) : null;

        if (!isLegacySubActive(legacySub)) {
          return next(new AppError(
            'SUBSCRIPTION_REQUIRED',
            `An active subscription is required to operate branch "${outlet.name}". Please complete subscription payment to unlock this feature.`,
            402
          ));
        }
      }
    }

    // 3. Business Owners and Super Admins have access to all outlets under their business
    if (req.user.role === 'BUSINESS_OWNER' || req.user.role === 'SUPER_ADMIN') {
      req.outletId = outletId;
      return next();
    }

    // 4. Otherwise (Managers, Staff, etc.), check explicit assignment to this outlet
    const userOutlet = await prisma.userOutlet.findUnique({
      where: {
        userId_outletId: {
          userId: req.user.id,
          outletId: outletId,
        },
      },
    });

    if (!userOutlet) {
      return next(new AppError('FORBIDDEN', 'Access to this outlet is denied', 403));
    }

    req.outletId = outletId;
    next();
  } catch (error) {
    next(error);
  }
}

export default businessMiddleware;
