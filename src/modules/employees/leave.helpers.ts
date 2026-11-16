import { prisma } from '../../config/prisma';
import { outletLocalParts } from '../../utils/outletTime';

/**
 * The approved leave (if any) that covers a calendar date for an employee.
 * Dates are stored as UTC midnight of the calendar day (Postgres DATE), like shift and attendance dates.
 */
export async function findApprovedLeaveOn(employeeId: string, date: Date) {
  return prisma.leaveRequest.findFirst({
    where: {
      employeeId,
      status: 'APPROVED',
      startDate: { lte: date },
      endDate: { gte: date },
    },
  });
}

export function formatLeaveDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

// Outlets operate in the UK (Europe/London); "today" is the outlet's local calendar date at UTC midnight
export function outletToday(now: Date = new Date()): Date {
  const { year, month, day } = outletLocalParts(now);
  return new Date(Date.UTC(year, month, day));
}
