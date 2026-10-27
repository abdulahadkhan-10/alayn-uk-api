import { prisma } from '../../config/prisma';
import AppError from '../../utils/AppError';

export interface ReportUser { id: string; role: string; businessId?: string | null }

const denied = () => new AppError('FORBIDDEN', 'You do not have access to that outlet', 403);

/** Every non-deleted outlet of one business. */
export async function businessOutletIds(businessId: string): Promise<string[]> {
  const rows = await prisma.outlet.findMany({
    where: { businessId, deletedAt: null },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => r.id);
}

/** Outlets this user may report on: owners (and super admins acting for a business) get the whole business; managers their assignments. */
export async function accessibleOutletIds(user: ReportUser): Promise<string[]> {
  if (user.role === 'MANAGER') {
    const rows = await prisma.userOutlet.findMany({
      where: { userId: user.id, outlet: { deletedAt: null } },
      select: { outletId: true },
    });
    return rows.map((r) => r.outletId);
  }
  if ((user.role === 'BUSINESS_OWNER' || user.role === 'SUPER_ADMIN') && user.businessId) {
    return businessOutletIds(user.businessId);
  }
  return [];
}

/** Decides which outlets one report request covers, refusing anything the caller cannot see. */
export async function resolveReportOutlets(user: ReportUser, selectedOutletId: string, requested?: string[]): Promise<string[]> {
  const unscopedAdmin = user.role === 'SUPER_ADMIN' && !user.businessId;
  if (unscopedAdmin && selectedOutletId === 'all') throw denied();
  const accessible = unscopedAdmin ? [selectedOutletId] : await accessibleOutletIds(user);

  if (!requested || requested.length === 0) {
    if (selectedOutletId === 'all') return accessible;
    if (!accessible.includes(selectedOutletId)) throw denied();
    return [selectedOutletId];
  }

  const wanted = [...new Set(requested)];
  if (!wanted.every((id) => accessible.includes(id))) throw denied();
  if (wanted.length > 1 && selectedOutletId !== 'all') {
    throw new AppError('FORBIDDEN', 'Comparing several outlets needs the "All outlets" view', 403);
  }
  // With one outlet selected, only that outlet: otherwise another outlet could be read without passing
  // that outlet's own subscription check in businessMiddleware
  if (selectedOutletId !== 'all' && wanted[0] !== selectedOutletId) throw denied();
  return wanted;
}
