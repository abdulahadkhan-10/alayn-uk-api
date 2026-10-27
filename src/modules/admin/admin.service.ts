import { AdminRepository } from './admin.repository';
import { AppError } from '../../utils/AppError';
import {
  CouponStatusFilter,
  CreateCouponInput,
  UpdateCouponInput,
  createCoupon,
  deleteCoupon,
  listCoupons,
  updateCoupon,
} from '../subscription/couponAdmin';
import { callLiteCoupons } from './liteCoupons';

export type CouponProduct = 'alayn' | 'lite';

export class AdminService {
  private repository = new AdminRepository();

  async getDashboard() {
    return this.repository.getDashboardMetrics();
  }

  async getOutlets(page: number, limit: number, search?: string) {
    return this.repository.getBusinesses(page, limit, search);
  }

  async getOutletDetails(businessId: string) {
    const business = await this.repository.getBusinessById(businessId);
    if (!business) {
      throw new AppError('NOT_FOUND', 'Outlet enterprise not found', 404);
    }

    const branches = business.outlets.map((outlet) => {
      const isSubActive =
        outlet.subscription?.status === 'ACTIVE' &&
        new Date(outlet.subscription.currentPeriodEnd) > new Date();

      return {
        id: outlet.id,
        name: outlet.name,
        address: outlet.address,
        city: outlet.city,
        state: outlet.state,
        country: outlet.country,
        phone: outlet.phone,
        gstin: outlet.gstin,
        openingTime: outlet.openingTime,
        closingTime: outlet.closingTime,
        subscriptionStatus: outlet.subscription?.status || 'PENDING_PAYMENT',
        isSubscriptionActive: isSubActive,
        planName: outlet.subscription?.planName || 'Smart Branch Pro',
        currentPeriodEnd: outlet.subscription?.currentPeriodEnd || null,
        tablesCount: outlet._count.tables,
        staffCount: outlet._count.employees,
        ordersCount: outlet._count.orders,
        tableOrderMode: outlet.tableOrderMode || 'WAITER_SERVICE',
        allowPayAtCounter: outlet.allowPayAtCounter ?? true,
        kitchenMode: (outlet.kitchenMode as 'KOT' | 'KDS' | 'HYBRID') || 'HYBRID',
        createdAt: outlet.createdAt,
      };
    });

    return {
      id: business.id,
      name: business.name,
      businessType: business.businessType || 'Hospitality',
      contactDetail: business.contactDetail,
      createdAt: business.createdAt,
      owner: business.owners[0]?.user
        ? {
            id: business.owners[0].user.id,
            name: business.owners[0].user.name,
            email: business.owners[0].user.email,
            phone: business.owners[0].user.phoneNo,
            registeredAt: business.owners[0].user.createdAt,
          }
        : null,
      totalBranches: branches.length,
      activeBranchesCount: branches.filter((b) => b.isSubscriptionActive).length,
      branches,
    };
  }

  // Coupons: Alayn's live in this database, Alayn Lite's are relayed to the Lite backend
  async getCoupons(
    page: number,
    limit: number,
    status: CouponStatusFilter,
    search?: string,
    product: CouponProduct = 'alayn'
  ) {
    if (product === 'lite') {
      return callLiteCoupons('GET', '', { query: { page, limit, status, search } });
    }
    return listCoupons({ page, limit, status, search });
  }

  async createCoupon(data: CreateCouponInput, adminUserId?: string, product: CouponProduct = 'alayn') {
    if (product === 'lite') {
      // Admin accounts live in this database only, so Lite coupons carry no creator
      return callLiteCoupons('POST', '', { body: data });
    }
    return createCoupon(data, adminUserId ?? null);
  }

  async updateCoupon(id: string, data: UpdateCouponInput, product: CouponProduct = 'alayn') {
    if (product === 'lite') {
      return callLiteCoupons('PATCH', `/${encodeURIComponent(id)}`, { body: data });
    }
    return updateCoupon(id, data);
  }

  async deleteCoupon(id: string, product: CouponProduct = 'alayn') {
    if (product === 'lite') {
      return callLiteCoupons('DELETE', `/${encodeURIComponent(id)}`);
    }
    return deleteCoupon(id);
  }

  async deleteBusiness(businessId: string) {
    const business = await this.repository.getBusinessById(businessId);
    if (!business) {
      throw new AppError('NOT_FOUND', 'Outlet enterprise not found', 404);
    }

    await this.repository.deleteBusiness(businessId);
    return { id: businessId, name: business.name };
  }

  async deleteBranch(outletId: string) {
    const branch = await this.repository.getBranchById(outletId);
    if (!branch) {
      throw new AppError('NOT_FOUND', 'Branch not found', 404);
    }

    await this.repository.deleteBranch(outletId);
    return { id: outletId, name: branch.name };
  }
}
export default AdminService;
