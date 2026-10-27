import * as XLSX from 'xlsx';
import { BreakdownRow, ReportData, Totals } from '../aggregate';
import { pctChange } from '../periods';

// Excel and CSV renderings of a ReportData. Rupee values are numbers (paise / 100, 2 decimals),
// never formatted strings, so they sum and sort in Excel. Missing values are empty cells.

export type ReportSection =
  | 'summary' | 'trend' | 'items' | 'channels' | 'payments' | 'categories' | 'hours' | 'weekdays' | 'waste' | 'outlets';

export const REPORT_SECTIONS: ReportSection[] = [
  'summary', 'trend', 'items', 'channels', 'payments', 'categories', 'hours', 'weekdays', 'waste', 'outlets',
];

export const isReportSection = (v: unknown): v is ReportSection => REPORT_SECTIONS.includes(v as ReportSection);

type Format = 'money' | 'pct';
interface Cell { v: string | number | null; f?: Format }
type Table = Cell[][]; // first row is the header

const text = (v: string): Cell => ({ v });
const num = (v: number | null | undefined): Cell => ({ v: v ?? null });
const money = (paise: number | null | undefined): Cell => ({ v: paise == null ? null : Math.round(paise) / 100, f: 'money' });
const pct = (v: number | null | undefined): Cell => ({ v: v ?? null, f: 'pct' });
const header = (...names: string[]): Cell[] => names.map(text);

const sheetName = (s: ReportSection) => s.charAt(0).toUpperCase() + s.slice(1);

function summaryTable(r: ReportData): Table {
  const c = r.totals.current;
  const p = r.totals.previous;
  const metrics: { name: string; key: keyof Totals; money: boolean }[] = [
    { name: 'Net sales ₹', key: 'netSalesPaise', money: true },
    { name: 'Orders', key: 'orders', money: false },
    { name: 'Average order value ₹', key: 'avgOrderPaise', money: true },
    { name: 'Discounts ₹', key: 'discountPaise', money: true },
    { name: 'Tax ₹', key: 'taxPaise', money: true },
    { name: 'Service charge ₹', key: 'serviceChargePaise', money: true },
    { name: 'Cancelled orders', key: 'cancelledOrders', money: false },
    { name: 'Cancelled sales ₹', key: 'cancelledPaise', money: true },
    { name: 'Waste ₹', key: 'wastePaise', money: true },
    { name: 'Items sold', key: 'itemsSold', money: false },
  ];
  const cell = (n: number | undefined, isMoney: boolean) => (n == null ? num(null) : isMoney ? money(n) : num(n));
  const hasPrev = r.comparison != null && p != null;
  const head = hasPrev ? header('Metric', r.period.label, r.comparison!.label, 'Change %') : header('Metric', r.period.label);
  return [head, ...metrics.map((m) => {
    const row = [text(m.name), cell(c[m.key], m.money)];
    if (hasPrev) row.push(cell(p![m.key], m.money), pct(r.totals.changePct[m.key]));
    return row;
  })];
}

function trendTable(r: ReportData): Table {
  const hasPrev = r.comparison != null;
  const head = hasPrev
    ? header('Period', 'Sales ₹', 'Orders', 'Waste ₹', 'Comparison sales ₹', 'Comparison orders', 'Change %')
    : header('Period', 'Sales ₹', 'Orders', 'Waste ₹');
  return [head, ...r.trend.current.map((b, i) => {
    const row = [text(b.label), money(b.netSalesPaise), num(b.orders), money(b.wastePaise)];
    if (hasPrev) {
      const prev = r.trend.previous[i];
      const change = prev ? pctChange(b.netSalesPaise, prev.netSalesPaise) : null;
      row.push(money(prev?.netSalesPaise), num(prev?.orders), pct(change));
    }
    return row;
  })];
}

function itemsTable(r: ReportData): Table {
  const hasPrev = r.comparison != null;
  const head = hasPrev
    ? header('Item', 'Category', 'Qty', 'Sales ₹', 'Comparison qty', 'Comparison sales ₹', 'Change %')
    : header('Item', 'Category', 'Qty', 'Sales ₹');
  return [head, ...r.items.map((i) => {
    const row = [text(i.name), text(i.category), num(i.qty), money(i.salesPaise)];
    if (hasPrev) row.push(num(i.prevQty), money(i.prevSalesPaise), pct(i.changePct));
    return row;
  })];
}

function breakdownTable(r: ReportData, rows: BreakdownRow[], names: { name: string; value: string; count: string }): Table {
  const hasPrev = r.comparison != null;
  const head = hasPrev
    ? header(names.name, names.value, names.count, 'Share %', `Comparison ${names.value.charAt(0).toLowerCase()}${names.value.slice(1)}`, `Comparison ${names.count.toLowerCase()}`, 'Change %')
    : header(names.name, names.value, names.count, 'Share %');
  return [head, ...rows.map((b) => {
    const row = [text(b.label), money(b.current.netSalesPaise), num(b.current.orders), pct(b.sharePct)];
    if (hasPrev) row.push(money(b.previous?.netSalesPaise), num(b.previous?.orders), pct(b.changePct));
    return row;
  })];
}

const SALES_NAMES = { name: 'Name', value: 'Sales ₹', count: 'Orders' };

function tableFor(r: ReportData, section: ReportSection): Table {
  switch (section) {
    case 'summary': return summaryTable(r);
    case 'trend': return trendTable(r);
    case 'items': return itemsTable(r);
    // Waste rows carry cost in the sales field and entry counts in the orders field.
    case 'waste': return breakdownTable(r, r.waste, { name: 'Reason', value: 'Cost ₹', count: 'Entries' });
    default: return breakdownTable(r, r[section], SALES_NAMES);
  }
}

// A line above the table in Excel only, so the CSV header stays the table's own header row
const SHEET_NOTES: Partial<Record<ReportSection, string>> = { items: 'Item sales before bill discounts' };

export function renderReportXlsx(report: ReportData): Buffer {
  const wb = XLSX.utils.book_new();
  for (const section of REPORT_SECTIONS) {
    const table = tableFor(report, section);
    const note = SHEET_NOTES[section];
    const top = note ? 1 : 0; // the table starts below the note
    const ws = XLSX.utils.aoa_to_sheet([...(note ? [[note]] : []), ...table.map((row) => row.map((c) => c.v))]);
    table.forEach((row, r) => row.forEach((c, col) => {
      const ref = ws[XLSX.utils.encode_cell({ r: r + top, c: col })];
      if (ref && r > 0 && c.f) ref.z = c.f === 'money' ? '#,##0.00' : '0.0';
    }));
    ws['!cols'] = table[0].map((h, col) => ({
      wch: Math.min(40, Math.max(String(h.v).length + 2, ...table.slice(1).map((row) => String(row[col].v ?? '').length + 2), 10)),
    }));
    XLSX.utils.book_append_sheet(wb, ws, sheetName(section));
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

const csvText = (c: Cell): string => {
  if (c.v == null) return '';
  if (typeof c.v === 'number') return c.f === 'money' ? c.v.toFixed(2) : c.f === 'pct' ? c.v.toFixed(1) : String(c.v);
  // Text that Excel could read as a formula gets a leading apostrophe (numbers are never touched).
  const safe = /^[=+\-@\t\r]/.test(c.v) ? `'${c.v}` : c.v;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function renderReportCsv(report: ReportData, section: ReportSection): string {
  const lines = tableFor(report, section).map((row) => row.map(csvText).join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
