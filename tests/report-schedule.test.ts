import { prisma } from '../src/config/prisma';
import { emailService } from '../src/utils/email.service';
import { buildReport } from '../src/modules/reports/report.service';
import { renderReportPdf, reportFileName } from '../src/modules/reports/export/pdf';
import { dueSchedules, sendScheduledReport, parseScheduleInput, sendTestReport, saveSchedule } from '../src/modules/reports/schedule.service';
import { scheduleReportEmails } from '../src/modules/reports/schedule.job';
import { ReportController } from '../src/modules/reports/report.controller';

jest.mock('../src/config/prisma', () => ({
  prisma: {
    reportSchedule: { findMany: jest.fn(), updateMany: jest.fn(), update: jest.fn(), upsert: jest.fn() },
    outlet: { findMany: jest.fn() },
  },
}));
jest.mock('../src/utils/email.service', () => ({ emailService: { sendMail: jest.fn() } }));
jest.mock('../src/modules/reports/report.service', () => ({ buildReport: jest.fn() }));
jest.mock('../src/modules/reports/export/pdf', () => ({
  renderReportPdf: jest.fn().mockResolvedValue(Buffer.from('pdf')),
  reportFileName: jest.fn().mockReturnValue('report.pdf'),
}));

const p = prisma as any;
const IST = (iso: string) => new Date(`${iso}+05:30`);
// Report periods start at 5 AM (business day), so the claimed period start is 5 AM on its first day
const DAY_START = (date: string) => IST(`${date}T05:00:00`);
const row = (over: Record<string, unknown> = {}) => ({
  id: 's1', businessId: 'b1', outletId: null, frequency: 'MONTHLY', recipients: ['a@example.com'],
  enabled: true, lastPeriodStart: null, ...over,
});

beforeEach(() => {
  jest.resetAllMocks();
  // resetAllMocks also clears the factory's return values, so set them again
  (renderReportPdf as jest.Mock).mockResolvedValue(Buffer.from('pdf'));
  (reportFileName as jest.Mock).mockReturnValue('report.pdf');
  p.outlet.findMany.mockResolvedValue([{ id: 'o1' }, { id: 'o2' }]);
  (emailService.sendMail as jest.Mock).mockResolvedValue('not_configured');
  (buildReport as jest.Mock).mockResolvedValue({
    period: { label: 'Oct 2026' }, highlights: ['Sales were up'],
    totals: { current: { netSalesPaise: 123400, orders: 5, avgOrderPaise: 24680 }, changePct: {} },
    scope: { outletNames: ['One'], businessName: 'Biz' },
  });
});

describe('due schedules', () => {
  it('monthly is due on the 1st after 9 AM', async () => {
    p.reportSchedule.findMany.mockResolvedValue([row()]);
    const due = await dueSchedules(IST('2026-11-01T09:05:00'));
    expect(due).toHaveLength(1);
    expect(p.reportSchedule.findMany.mock.calls[0][0].where).toMatchObject({ enabled: true });
  });

  it('not due at 8:59', async () => {
    p.reportSchedule.findMany.mockResolvedValue([row()]);
    expect(await dueSchedules(IST('2026-11-01T08:59:00'))).toHaveLength(0);
  });

  it('not due on other days', async () => {
    // behave like the database: only return rows matching the frequency filter
    p.reportSchedule.findMany.mockImplementation(async ({ where }: any) =>
      [row()].filter((r) => where.frequency.in.includes(r.frequency)));
    expect(await dueSchedules(IST('2026-11-03T10:00:00'))).toHaveLength(0); // Tuesday, not the 1st
    // only the daily schedule is looked up on an ordinary day
    expect(p.reportSchedule.findMany.mock.calls[0][0].where.frequency).toEqual({ in: ['DAILY'] });
  });

  it('daily is due every day after 9 AM for yesterday', async () => {
    p.reportSchedule.findMany.mockResolvedValue([
      row({ frequency: 'DAILY', lastPeriodStart: DAY_START('2026-11-02') }),
      row({ id: 's2', frequency: 'DAILY', lastPeriodStart: DAY_START('2026-11-01') }),
    ]);
    const due = await dueSchedules(IST('2026-11-03T09:30:00')); // yesterday = 2 Nov
    expect(due.map((d: any) => d.id)).toEqual(['s2']);
    expect(await dueSchedules(IST('2026-11-03T08:59:00'))).toHaveLength(0);
  });

  it('not due again once sent', async () => {
    p.reportSchedule.findMany.mockResolvedValue([row({ lastPeriodStart: DAY_START('2026-10-01') })]);
    expect(await dueSchedules(IST('2026-11-01T10:00:00'))).toHaveLength(0);
  });

  it('weekly is due Monday for last week', async () => {
    p.reportSchedule.findMany.mockResolvedValue([
      row({ frequency: 'WEEKLY', lastPeriodStart: DAY_START('2026-10-12') }),
      row({ id: 's2', frequency: 'WEEKLY', lastPeriodStart: DAY_START('2026-10-19') }),
    ]);
    const due = await dueSchedules(IST('2026-10-26T09:00:00')); // Monday 26 Oct; last week starts 19 Oct
    expect(due.map((d: any) => d.id)).toEqual(['s1']);
  });

  it('a Monday that is the 1st sends both the weekly and the monthly report', async () => {
    p.reportSchedule.findMany.mockImplementation(async ({ where }: any) =>
      [row({ id: 'w', frequency: 'WEEKLY' }), row({ id: 'm', frequency: 'MONTHLY' })].filter((r) => where.frequency.in.includes(r.frequency)));
    const due = await dueSchedules(IST('2027-02-01T09:05:00')); // Monday 1 Feb 2027
    expect(p.reportSchedule.findMany.mock.calls[0][0].where.frequency).toEqual({ in: ['DAILY', 'WEEKLY', 'MONTHLY'] });
    expect(due.map((d: any) => d.id)).toEqual(['w', 'm']);
  });
});

describe('sending', () => {
  it('claim prevents double send', async () => {
    p.reportSchedule.updateMany.mockResolvedValue({ count: 0 });
    await sendScheduledReport(row() as any, IST('2026-11-01T09:05:00'));
    expect(emailService.sendMail).not.toHaveBeenCalled();
    expect(buildReport).not.toHaveBeenCalled();
  });

  it('claims the period then emails the PDF', async () => {
    p.reportSchedule.updateMany.mockResolvedValue({ count: 1 });
    await sendScheduledReport(row() as any, IST('2026-11-01T09:05:00'));
    expect(p.reportSchedule.updateMany.mock.calls[0][0].data.lastPeriodStart).toEqual(DAY_START('2026-10-01'));
    expect((buildReport as jest.Mock).mock.calls[0][1]).toEqual(['o1', 'o2']);
    const mail = (emailService.sendMail as jest.Mock).mock.calls[0][0];
    expect(mail.subject).toBe('Alayn monthly report: Oct 2026');
    expect(mail.to).toEqual(['a@example.com']);
    expect(mail.attachments[0].filename).toBe('report.pdf');
    expect(mail.html).toContain('Sales were up');
  });

  it('skips without claiming when the outlet no longer belongs to the business', async () => {
    await sendScheduledReport(row({ outletId: 'gone' }) as any, IST('2026-11-01T09:05:00'));
    expect(p.reportSchedule.updateMany).not.toHaveBeenCalled();
    expect(emailService.sendMail).not.toHaveBeenCalled();
  });

  it('skips a business with no outlets', async () => {
    p.outlet.findMany.mockResolvedValue([]);
    await sendScheduledReport(row() as any, IST('2026-11-01T09:05:00'));
    expect(p.reportSchedule.updateMany).not.toHaveBeenCalled();
  });

  it('daily compares yesterday with the same weekday last week', async () => {
    p.reportSchedule.updateMany.mockResolvedValue({ count: 1 });
    await sendScheduledReport(row({ frequency: 'DAILY' }) as any, IST('2026-11-01T09:05:00')); // yesterday = Sat 31 Oct
    expect(p.reportSchedule.updateMany.mock.calls[0][0].data.lastPeriodStart).toEqual(DAY_START('2026-10-31'));
    const request = (buildReport as jest.Mock).mock.calls[0][0];
    expect(request).toMatchObject({ preset: 'YESTERDAY', compare: 'CUSTOM', compareCustom: { from: '2026-10-24', to: '2026-10-24' } });
    expect((emailService.sendMail as jest.Mock).mock.calls[0][0].subject).toBe('Alayn daily report: Oct 2026');
  });

  it('daily comparison crosses a month boundary: yesterday 3 Nov is compared with 27 Oct', async () => {
    p.reportSchedule.updateMany.mockResolvedValue({ count: 1 });
    await sendScheduledReport(row({ frequency: 'DAILY' }) as any, IST('2026-11-04T09:05:00'));
    expect(p.reportSchedule.updateMany.mock.calls[0][0].data.lastPeriodStart).toEqual(DAY_START('2026-11-03'));
    expect((buildReport as jest.Mock).mock.calls[0][0]).toMatchObject({ compareCustom: { from: '2026-10-27', to: '2026-10-27' } });
  });

  it('keeps the claim when sending fails afterwards, without throwing', async () => {
    p.reportSchedule.updateMany.mockResolvedValue({ count: 1 });
    (emailService.sendMail as jest.Mock).mockRejectedValue(new Error('SMTP down'));
    await expect(sendScheduledReport(row() as any, IST('2026-11-01T09:05:00'))).resolves.toBeUndefined();
    expect(p.reportSchedule.updateMany).toHaveBeenCalledTimes(1); // the claim, never undone
    expect(p.reportSchedule.update).not.toHaveBeenCalled();
  });

  it('escapes HTML in business, outlet and item names', async () => {
    p.reportSchedule.updateMany.mockResolvedValue({ count: 1 });
    (buildReport as jest.Mock).mockResolvedValue({
      period: { label: 'Oct 2026' }, highlights: ['Top item: <script>alert(1)</script> Biryani'],
      totals: { current: { netSalesPaise: 100, orders: 1, avgOrderPaise: 100 }, changePct: {} },
      scope: { outletNames: ['<b>Main</b>'], businessName: 'Tom & <script>Jerry</script>' },
    });
    await sendScheduledReport(row() as any, IST('2026-11-01T09:05:00'));
    const { html } = (emailService.sendMail as jest.Mock).mock.calls[0][0];
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>Main');
    expect(html).toContain('Tom &amp; &lt;script&gt;Jerry&lt;/script&gt;');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; Biryani');
  });
});

describe('test email', () => {
  const NOW = IST('2026-11-04T11:00:00');

  it('refuses an outlet from another business with 400', async () => {
    await expect(sendTestReport('b1', 'other-business-outlet', 'owner@example.com', NOW)).rejects.toMatchObject({ statusCode: 400 });
    expect(emailService.sendMail).not.toHaveBeenCalled();
  });

  it("falls back to the owner's email when no recipients are saved, and never touches lastPeriodStart", async () => {
    p.reportSchedule.findMany.mockResolvedValue([]);
    (emailService.sendMail as jest.Mock).mockResolvedValue('sent');
    const result = await sendTestReport('b1', null, 'Owner@Example.com', NOW);
    expect(result).toEqual({ sent: true });
    expect((emailService.sendMail as jest.Mock).mock.calls[0][0].to).toEqual(['owner@example.com']);
    expect(p.reportSchedule.updateMany).not.toHaveBeenCalled();
    expect(p.reportSchedule.update).not.toHaveBeenCalled();
    expect(p.reportSchedule.upsert).not.toHaveBeenCalled();
  });

  it('uses saved recipients when there are some', async () => {
    p.reportSchedule.findMany.mockResolvedValue([row({ recipients: ['team@example.com'] })]);
    (emailService.sendMail as jest.Mock).mockResolvedValue('sent');
    await sendTestReport('b1', 'o2', 'owner@example.com', NOW);
    expect((emailService.sendMail as jest.Mock).mock.calls[0][0].to).toEqual(['team@example.com']);
    expect((buildReport as jest.Mock).mock.calls[0][1]).toEqual(['o2']);
  });

  it('says why nothing was sent: email not set up, or sending failed', async () => {
    p.reportSchedule.findMany.mockResolvedValue([]);
    (emailService.sendMail as jest.Mock).mockResolvedValue('not_configured');
    expect(await sendTestReport('b1', null, 'owner@example.com', NOW)).toEqual({ sent: false, reason: 'not_configured' });
    (emailService.sendMail as jest.Mock).mockResolvedValue('failed');
    expect(await sendTestReport('b1', null, 'owner@example.com', NOW)).toEqual({ sent: false, reason: 'failed' });
  });
});

describe('test email throttle', () => {
  const req = (businessId: string) => ({ body: {}, user: { id: 'u1', role: 'BUSINESS_OWNER', businessId, email: 'owner@example.com' } }) as any;
  const res = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() }) as any;

  beforeEach(() => {
    jest.useFakeTimers({ now: IST('2026-11-04T11:00:00') });
    p.reportSchedule.findMany.mockResolvedValue([]);
    (emailService.sendMail as jest.Mock).mockResolvedValue('sent');
  });
  afterEach(() => jest.useRealTimers());

  it('allows one test email per business a minute', async () => {
    const controller = new ReportController();
    const first = res();
    await controller.sendTestSchedule(req('b1'), first, jest.fn());
    expect(first.status).toHaveBeenCalledWith(200);

    const next = jest.fn();
    await controller.sendTestSchedule(req('b1'), res(), next);
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 429, message: 'Please wait a minute before sending another sample email.' });
    expect(emailService.sendMail).toHaveBeenCalledTimes(1);

    // Another business is not held up
    const other = res();
    await controller.sendTestSchedule(req('b2'), other, jest.fn());
    expect(other.status).toHaveBeenCalledWith(200);

    jest.advanceTimersByTime(60_000);
    const later = res();
    await controller.sendTestSchedule(req('b1'), later, jest.fn());
    expect(later.status).toHaveBeenCalledWith(200);
    expect(emailService.sendMail).toHaveBeenCalledTimes(3);
  });

  it('a refused request (wrong outlet) does not use up the minute', async () => {
    const controller = new ReportController();
    const bad = { ...req('b3'), body: { outletId: 'other-business-outlet' } };
    const next = jest.fn();
    await controller.sendTestSchedule(bad, res(), next);
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 400 });
    const ok = res();
    await controller.sendTestSchedule(req('b3'), ok, jest.fn());
    expect(ok.status).toHaveBeenCalledWith(200);
  });
});

describe('saving a schedule', () => {
  const input = { frequency: 'WEEKLY' as const, enabled: true, recipients: ['a@example.com'] };

  it("refuses another business's outlet with 403 and saves nothing", async () => {
    await expect(saveSchedule('b1', { ...input, outletId: 'other-business-outlet' })).rejects.toMatchObject({ statusCode: 403 });
    expect(p.reportSchedule.upsert).not.toHaveBeenCalled();
  });

  it('rejects an outlet id that is not a valid id with 400', () => {
    expect(() => parseScheduleInput({ ...input, outletId: 'not-a-uuid' })).toThrow(
      expect.objectContaining({ statusCode: 400, message: 'Pick a valid outlet' }),
    );
  });

  it("saves for one of the business's own outlets", async () => {
    p.reportSchedule.findMany.mockResolvedValue([]);
    await saveSchedule('b1', { ...input, outletId: 'o1' });
    expect(p.reportSchedule.upsert.mock.calls[0][0].where).toEqual({ businessId_frequency: { businessId: 'b1', frequency: 'WEEKLY' } });
  });
});

describe('report email job', () => {
  it('does not start under tests', () => {
    const timer = jest.spyOn(global, 'setInterval');
    scheduleReportEmails();
    expect(timer).not.toHaveBeenCalled();
    expect(p.reportSchedule.findMany).not.toHaveBeenCalled();
    timer.mockRestore();
  });
});

describe('schedule input', () => {
  const base = { frequency: 'WEEKLY', enabled: true, outletId: null };
  it('rejects more than 5 recipients with 400', () => {
    const six = Array.from({ length: 6 }, (_, i) => `p${i}@example.com`);
    expect(() => parseScheduleInput({ ...base, recipients: six })).toThrow(expect.objectContaining({ statusCode: 400, message: 'Add between 1 and 5 email addresses' }));
  });
  it('rejects none and invalid emails', () => {
    expect(() => parseScheduleInput({ ...base, recipients: [] })).toThrow(expect.objectContaining({ statusCode: 400 }));
    expect(() => parseScheduleInput({ ...base, recipients: ['nope'] })).toThrow(expect.objectContaining({ statusCode: 400 }));
  });
  it('trims, lowercases and de-duplicates', () => {
    expect(parseScheduleInput({ ...base, recipients: [' A@Example.com', 'a@example.com'] }).recipients).toEqual(['a@example.com']);
  });
});
