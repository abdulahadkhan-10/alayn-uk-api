import { z } from 'zod';
import type { ReportSchedule } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { logger } from '../../config/logger';
import AppError from '../../utils/AppError';
import { emailService, SendMailResult } from '../../utils/email.service';
import { outletLocalParts, businessParts, businessDayStart, businessDateString } from '../../utils/outletTime';
import { businessOutletIds } from './access';
import { buildReport } from './report.service';
import { renderReportPdf, reportFileName } from './export/pdf';
import { formatRupees } from './aggregate';
import { resolvePeriod, PeriodPreset } from './periods';
import type { ReportRequest } from './query';

export type Frequency = 'DAILY' | 'WEEKLY' | 'MONTHLY';

const SEND_HOUR = 9; // India time
const FREQUENCIES: Frequency[] = ['DAILY', 'WEEKLY', 'MONTHLY'];
const PRESET: Record<Frequency, PeriodPreset> = { DAILY: 'YESTERDAY', WEEKLY: 'LAST_WEEK', MONTHLY: 'LAST_MONTH' };
const WORD: Record<Frequency, string> = { DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly' };
const RECIPIENT_MESSAGE = 'Add between 1 and 5 email addresses';

const scheduleInput = z.object({
  frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY'], { errorMap: () => ({ message: 'Choose daily, weekly or monthly' }) }),
  enabled: z.boolean({ errorMap: () => ({ message: 'Choose whether the report is on or off' }) }),
  outletId: z.string().uuid('Pick a valid outlet').nullable().optional(),
  recipients: z
    .array(z.string({ errorMap: () => ({ message: RECIPIENT_MESSAGE }) }).trim().toLowerCase().email(RECIPIENT_MESSAGE), {
      errorMap: () => ({ message: RECIPIENT_MESSAGE }),
    })
    .transform((list) => [...new Set(list)])
    .pipe(z.array(z.string()).min(1, RECIPIENT_MESSAGE).max(5, RECIPIENT_MESSAGE)),
});

export interface ScheduleInput {
  frequency: Frequency;
  enabled: boolean;
  outletId: string | null;
  recipients: string[];
}

export function parseScheduleInput(body: unknown): ScheduleInput {
  const parsed = scheduleInput.safeParse(body);
  if (!parsed.success) throw new AppError('BAD_REQUEST', parsed.error.issues[0]?.message ?? RECIPIENT_MESSAGE, 400);
  return { ...parsed.data, outletId: parsed.data.outletId ?? null };
}

/** The report a schedule sends at `now`, and when that report's period began. */
const periodFor = (frequency: Frequency, now: Date) => resolvePeriod(PRESET[frequency], now);

/** Enabled schedules whose report for this week or month hasn't been sent yet, from 9 AM India time on the day. */
export async function dueSchedules(now: Date): Promise<ReportSchedule[]> {
  const local = outletLocalParts(now);
  if (local.hour < SEND_HOUR) return [];
  const frequencies = FREQUENCIES.filter((f) => f === 'DAILY' || (f === 'WEEKLY' ? local.weekday === 1 : local.day === 1));
  if (frequencies.length === 0) return [];
  const rows = await prisma.reportSchedule.findMany({ where: { enabled: true, frequency: { in: frequencies } } });
  return rows.filter((s) => s.lastPeriodStart?.getTime() !== periodFor(s.frequency, now).start.getTime());
}

const esc = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

type BuiltReport = Awaited<ReturnType<typeof buildReport>>;

function emailBody(report: BuiltReport, frequency: Frequency) {
  const t = report.totals.current;
  const rows: [string, string][] = [
    ['Sales (before tax)', formatRupees(t.netSalesPaise)],
    ['Orders', String(t.orders)],
    ['Average order value', formatRupees(t.avgOrderPaise)],
  ];
  const where = report.scope.outletNames.join(', ');
  const title = `Your ${WORD[frequency]} report: ${report.period.label}`;
  const cell = 'padding:8px;border-bottom:1px solid #E8ECF1';
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#1B2A4A;max-width:560px">
<h2 style="margin:0 0 4px">${esc(title)}</h2>
<p style="margin:0 0 16px;color:#6B7A90">${esc(report.scope.businessName)}${where ? ` · ${esc(where)}` : ''}</p>
${report.highlights.length ? `<ul style="padding-left:18px;line-height:1.6">${report.highlights.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>` : ''}
<table style="border-collapse:collapse;width:100%;margin:16px 0">${rows
    .map(([k, v]) => `<tr><td style="${cell}">${esc(k)}</td><td style="${cell};text-align:right;font-weight:700">${esc(v)}</td></tr>`)
    .join('')}</table>
<p style="color:#6B7A90;font-size:13px">The full report is attached as a PDF.</p></div>`;
  const text = [title, '', ...report.highlights.map((h) => `- ${h}`), '', ...rows.map(([k, v]) => `${k}: ${v}`), '', 'The full report is attached as a PDF.'].join('\n');
  return { html, text };
}

/**
 * What a scheduled report is compared with. Weekly and monthly use the period before. Daily uses the same
 * weekday last week: restaurants swing a lot between weekdays, so Saturday vs Friday would always look like a jump.
 */
function comparisonFor(frequency: Frequency, now: Date): Pick<ReportRequest, 'compare' | 'compareCustom'> {
  if (frequency !== 'DAILY') return { compare: 'PREVIOUS' };
  const yesterday = periodFor('DAILY', now).start;
  const p = businessParts(yesterday);
  const weekBefore = businessDateString(businessDayStart(p.year, p.month, p.day - 7));
  return { compare: 'CUSTOM', compareCustom: { from: weekBefore, to: weekBefore } };
}

/** Builds the report for these outlets and emails it with the PDF attached. Returns what happened to the email. */
async function deliver(frequency: Frequency, recipients: string[], outletIds: string[], now: Date): Promise<SendMailResult> {
  const request: ReportRequest = { preset: PRESET[frequency], ...comparisonFor(frequency, now), filters: {} };
  const report = await buildReport(request, outletIds, now);
  const pdf = await renderReportPdf(report, now);
  const { html, text } = emailBody(report, frequency);
  return emailService.sendMail({
    to: recipients,
    subject: `Alayn ${WORD[frequency]} report: ${report.period.label}`,
    html,
    text,
    attachments: [{ filename: reportFileName(report, 'pdf'), content: pdf }],
  });
}

/** Every outlet the schedule covers, or null when it covers none (no outlets, or its outlet is gone). */
async function scheduleOutlets(businessId: string, outletId: string | null): Promise<string[] | null> {
  const all = await businessOutletIds(businessId);
  const ids = outletId ? all.filter((id) => id === outletId) : all;
  return ids.length ? ids : null;
}

/**
 * Sends one schedule's report. The period is claimed first so two servers (or two runs) never both send.
 * If sending fails after the claim the error is logged and the period is not retried: a missed email is
 * better than duplicates.
 */
export async function sendScheduledReport(s: ReportSchedule, now: Date): Promise<void> {
  const outletIds = await scheduleOutlets(s.businessId, s.outletId);
  if (!outletIds) {
    logger.warn({ scheduleId: s.id }, '[ReportEmails] No outlets to report on; skipped');
    return;
  }
  const periodStart = periodFor(s.frequency, now).start;
  const { count } = await prisma.reportSchedule.updateMany({
    where: { id: s.id, OR: [{ lastPeriodStart: null }, { lastPeriodStart: { not: periodStart } }] },
    data: { lastPeriodStart: periodStart },
  });
  if (count === 0) return;
  try {
    const result = await deliver(s.frequency, s.recipients, outletIds, now);
    if (result !== 'sent') logger.warn({ scheduleId: s.id, result }, '[ReportEmails] Report was built but not emailed');
  } catch (err: any) {
    logger.error({ scheduleId: s.id, err: err?.message || err }, '[ReportEmails] Sending failed after the period was claimed; not retrying');
  }
}

/** Last week's report to the saved recipients (or the fallback), without touching any schedule. */
export async function sendTestReport(
  businessId: string,
  outletId: string | null,
  fallbackEmail: string | undefined,
  now = new Date(),
): Promise<{ sent: boolean; reason?: 'not_configured' | 'failed' }> {
  const outletIds = await scheduleOutlets(businessId, outletId);
  if (!outletIds) throw new AppError('BAD_REQUEST', 'Pick an outlet that belongs to your business', 400);
  const saved = await prisma.reportSchedule.findMany({ where: { businessId }, orderBy: { frequency: 'asc' } });
  const recipients = saved.find((s) => s.recipients.length > 0)?.recipients ?? (fallbackEmail ? [fallbackEmail.toLowerCase()] : []);
  if (recipients.length === 0) throw new AppError('BAD_REQUEST', RECIPIENT_MESSAGE, 400);
  const result = await deliver('WEEKLY', recipients, outletIds, now);
  return result === 'sent' ? { sent: true } : { sent: false, reason: result };
}

/** Both schedules for a business; a frequency that was never saved comes back switched off. */
export async function getSchedules(businessId: string) {
  const rows = await prisma.reportSchedule.findMany({ where: { businessId } });
  return FREQUENCIES.map((frequency) => {
    const row = rows.find((r) => r.frequency === frequency);
    return { frequency, enabled: row?.enabled ?? false, recipients: row?.recipients ?? [], outletId: row?.outletId ?? null };
  });
}

export async function saveSchedule(businessId: string, input: ScheduleInput) {
  if (input.outletId && !(await businessOutletIds(businessId)).includes(input.outletId)) {
    throw new AppError('FORBIDDEN', 'You do not have access to that outlet', 403);
  }
  const data = { enabled: input.enabled, outletId: input.outletId, recipients: input.recipients };
  await prisma.reportSchedule.upsert({
    where: { businessId_frequency: { businessId, frequency: input.frequency } },
    create: { businessId, frequency: input.frequency, ...data },
    update: data,
  });
  return getSchedules(businessId);
}
