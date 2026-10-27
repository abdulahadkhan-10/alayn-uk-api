import { logger } from '../../config/logger';
import { dueSchedules, sendScheduledReport } from './schedule.service';

const EVERY_15_MINUTES = 15 * 60 * 1000;

/** One pass: send every schedule that is due now. One failing schedule never stops the others. */
export async function runReportEmails(now = new Date()): Promise<void> {
  const due = await dueSchedules(now);
  for (const schedule of due) {
    try {
      await sendScheduledReport(schedule, now);
    } catch (err: any) {
      logger.error({ scheduleId: schedule.id, err: err?.message || err }, '[ReportEmails] Schedule failed');
    }
  }
}

/** Checks for due weekly/monthly report emails every 15 minutes. The BullMQ jobs in src/jobs are never started, so this uses a plain timer. */
export function scheduleReportEmails() {
  // Never email (or poll the database) from a test run
  if (process.env.NODE_ENV === 'test') return;
  const run = () =>
    runReportEmails().catch((err) => logger.error({ err: err?.message || err }, '[ReportEmails] Run failed'));
  run();
  setInterval(run, EVERY_15_MINUTES).unref();
}
