import { z } from 'zod';
import AppError from '../../utils/AppError';
import { CompareMode, DayStrings, PeriodPreset } from './periods';
import { Channel, Granularity, ReportFilters } from './aggregate';

export interface ReportRequest {
  preset: PeriodPreset;
  compare: CompareMode;
  custom?: DayStrings;
  compareCustom?: DayStrings;
  outlets?: string[];
  filters: Omit<ReportFilters, 'outletIds'>;
}

const PRESETS = ['TODAY', 'YESTERDAY', 'LAST_7_DAYS', 'THIS_WEEK', 'LAST_WEEK', 'THIS_MONTH', 'LAST_MONTH',
  'THIS_QUARTER', 'LAST_QUARTER', 'THIS_YEAR', 'LAST_YEAR', 'CUSTOM'] as const;

// Query strings arrive as text; empty values mean "not set".
const text = z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().optional());
const list = (v: string | undefined) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);
const whole = (label: string, min: number, max: number) =>
  text.transform((v, ctx) => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) {
      ctx.addIssue({ code: 'custom', message: `${label} must be a whole number from ${min} to ${max}` });
      return z.NEVER;
    }
    return n;
  });

const schema = z.object({
  preset: z.enum(PRESETS, { errorMap: () => ({ message: 'Pick a valid period' }) }).default('THIS_MONTH'),
  compare: z.enum(['PREVIOUS', 'LAST_YEAR', 'CUSTOM', 'NONE'], { errorMap: () => ({ message: 'Pick a valid comparison' }) }).default('PREVIOUS'),
  from: text, to: text, cFrom: text, cTo: text,
  outlets: text, sources: text, categories: text, weekdays: text,
  hourFrom: whole('Start hour', 0, 23),
  hourTo: whole('End hour', 1, 24),
  granularity: z.enum(['hour', 'day', 'week', 'month'], { errorMap: () => ({ message: 'Pick hourly, daily, weekly or monthly' }) }).optional(),
});

function bad(message: string): never {
  throw new AppError('BAD_REQUEST', message, 400);
}

export function parseReportQuery(q: Record<string, unknown>): ReportRequest {
  const flat = Object.fromEntries(Object.entries(q).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v]));
  const parsed = schema.safeParse(flat);
  if (!parsed.success) bad(parsed.error.issues[0]?.message ?? 'Check the report options and try again');
  const d = parsed.data;

  if (d.preset === 'CUSTOM' && (!d.from || !d.to)) bad('Pick a start and end date');
  if (d.compare === 'CUSTOM' && (!d.cFrom || !d.cTo)) bad('Pick a start and end date to compare with');
  if (d.hourFrom !== undefined && d.hourTo !== undefined && d.hourFrom >= d.hourTo) bad('The start hour must be before the end hour');

  const sources = list(d.sources);
  if (sources && !sources.every((s) => ['TABLE', 'QR', 'COUNTER', 'DELIVERY'].includes(s))) bad('Pick valid order channels');
  const weekdays = list(d.weekdays)?.map(Number);
  if (weekdays && !weekdays.every((n) => Number.isInteger(n) && n >= 0 && n <= 6)) bad('Weekdays must be numbers from 0 (Sunday) to 6 (Saturday)');

  const filters: ReportRequest['filters'] = {};
  if (sources) filters.sources = sources as Channel[];
  const categoryIds = list(d.categories);
  if (categoryIds) filters.categoryIds = categoryIds;
  if (weekdays) filters.weekdays = weekdays;
  if (d.hourFrom !== undefined) filters.hourFrom = d.hourFrom;
  if (d.hourTo !== undefined) filters.hourTo = d.hourTo;
  if (d.granularity) filters.granularity = d.granularity as Granularity;

  return {
    preset: d.preset,
    compare: d.compare,
    custom: d.preset === 'CUSTOM' ? { from: d.from!, to: d.to! } : undefined,
    compareCustom: d.compare === 'CUSTOM' ? { from: d.cFrom!, to: d.cTo! } : undefined,
    outlets: list(d.outlets),
    filters,
  };
}
