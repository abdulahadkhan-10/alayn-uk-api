import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../../utils/response';
import { accessibleOutletIds, resolveReportOutlets } from './access';
import { parseReportQuery } from './query';
import { buildReport, reportOptions } from './report.service';
import { buildRemovedItemsReport } from './removals';
import { renderReportPdf, reportFileName } from './export/pdf';
import { renderReportXlsx, renderReportCsv, isReportSection, ReportSection } from './export/sheets';
import AppError from '../../utils/AppError';
import { getSchedules, saveSchedule, sendTestReport, parseScheduleInput } from './schedule.service';

// When each business last asked for a test email. Kept in memory, so the limit is per server instance
// (enough to stop someone filling an inbox by pressing the button over and over).
const TEST_EMAIL_GAP_MS = 60_000;
const lastTestEmail = new Map<string, number>();

export class ReportController {
  // Same parsing and outlet access for the page and every download.
  private async report(req: Request) {
    const request = parseReportQuery(req.query);
    const outletIds = await resolveReportOutlets(req.user!, req.outletId!, request.outlets);
    return buildReport(request, outletIds);
  }

  getReport = async (req: Request, res: Response, next: NextFunction) => {
    try {
      return sendSuccess(res, await this.report(req));
    } catch (error) {
      next(error);
    }
  };

  getRemovedItems = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const request = parseReportQuery(req.query);
      const outletIds = await resolveReportOutlets(req.user!, req.outletId!, request.outlets);
      return sendSuccess(res, await buildRemovedItemsReport(request, outletIds));
    } catch (error) {
      next(error);
    }
  };

  exportReport = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const format = String(req.query.format ?? '');
      if (format !== 'pdf' && format !== 'xlsx' && format !== 'csv') throw new AppError('BAD_REQUEST', 'Choose PDF, Excel or CSV', 400);
      const section = req.query.section;
      if (format === 'csv' && !isReportSection(section)) throw new AppError('BAD_REQUEST', 'Choose which table to download', 400);
      const report = await this.report(req);
      const disposition = (name: string) => `attachment; filename="${name}"`;
      if (format === 'xlsx') {
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', disposition(reportFileName(report, 'xlsx')));
        return res.send(renderReportXlsx(report));
      }
      if (format === 'csv') {
        const chosen = section as ReportSection;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', disposition(reportFileName(report, 'csv', chosen)));
        return res.send(renderReportCsv(report, chosen));
      }
      const pdf = await renderReportPdf(report, new Date());
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', disposition(reportFileName(report, 'pdf')));
      return res.send(pdf);
    } catch (error) {
      next(error);
    }
  };

  private businessIdOf(req: Request): string {
    const businessId = req.user?.businessId;
    if (!businessId) throw new AppError('FORBIDDEN', 'Only business owners can manage report emails', 403);
    return businessId;
  }

  getSchedule = async (req: Request, res: Response, next: NextFunction) => {
    try {
      return sendSuccess(res, await getSchedules(this.businessIdOf(req)));
    } catch (error) {
      next(error);
    }
  };

  saveSchedule = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const businessId = this.businessIdOf(req);
      return sendSuccess(res, await saveSchedule(businessId, parseScheduleInput(req.body)));
    } catch (error) {
      next(error);
    }
  };

  sendTestSchedule = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const businessId = this.businessIdOf(req);
      const now = Date.now();
      const last = lastTestEmail.get(businessId);
      if (last !== undefined && now - last < TEST_EMAIL_GAP_MS) {
        throw new AppError('TOO_MANY_REQUESTS', 'Please wait a minute before sending another sample email.', 429);
      }
      const raw = req.body?.outletId;
      const outletId = typeof raw === 'string' && raw.length > 0 ? raw : null;
      lastTestEmail.set(businessId, now);
      try {
        return sendSuccess(res, await sendTestReport(businessId, outletId, req.user?.email ?? undefined));
      } catch (error) {
        // A refused request (such as another business's outlet) sent nothing, so it does not count
        if (lastTestEmail.get(businessId) === now) lastTestEmail.delete(businessId);
        throw error;
      }
    } catch (error) {
      next(error);
    }
  };

  getOptions = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user!;
      // Every outlet the caller may report on; the single-outlet rule is enforced on the report itself.
      const outletIds = user.role === 'SUPER_ADMIN' && !user.businessId
        ? await resolveReportOutlets(user, req.outletId!)
        : await accessibleOutletIds(user);
      return sendSuccess(res, await reportOptions(outletIds));
    } catch (error) {
      next(error);
    }
  };
}
