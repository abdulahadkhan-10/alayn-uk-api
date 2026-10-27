import path from 'path';
import PDFDocument from 'pdfkit';
import { BreakdownRow, ItemRow, ReportData, Totals, TrendBucket, formatRupees } from '../aggregate';
import { businessDateString, outletLocalParts } from '../../../utils/outletTime';

// Renders a report as an A4 PDF. Layout is plain top-to-bottom flow: every table row has a fixed
// height and is only drawn when it fits, so a page break never cuts a row. Money is formatted with
// formatRupees; dates and times are India time. Text uses Noto Sans because the built-in PDF
// fonts have no rupee sign.

export type ReportWithScope = ReportData & { scope: { outletNames: string[]; businessName: string } };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FONT_DIR = path.join(process.cwd(), 'assets', 'fonts');

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 40;
const WIDTH = PAGE_W - MARGIN * 2;
const FOOTER_ZONE = 28;
const BOTTOM = PAGE_H - MARGIN - FOOTER_ZONE;
const ROW_H = 18;

const INK = '#111827';
const MUTED = '#6B7280';
const RULE = '#E5E7EB';
const HEAD_BG = '#F3F4F6';
const GOOD = '#15803D';
const BAD = '#B91C1C';
const CURRENT = '#7C3AED';
const COMPARE = '#CBD5E1';
const MAX_BAR_PAIRS = 31;

// ---------- file name ----------

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export function reportFileName(report: ReportWithScope, ext: 'pdf' | 'xlsx' | 'csv', section?: string): string {
  const outlets = report.scope.outletNames;
  const outlet = outlets.length === 1 && slug(outlets[0]) ? slug(outlets[0]) : 'all-outlets';
  const day = (iso: string) => businessDateString(new Date(iso));
  return `alayn-report_${outlet}_${day(report.period.start)}_to_${day(report.period.end)}${section ? `_${section}` : ''}.${ext}`;
}

// ---------- formatting ----------

function generatedLabel(at: Date): string {
  const p = outletLocalParts(at);
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const mm = String(p.minute).padStart(2, '0');
  return `Generated ${p.day} ${MONTHS[p.month]} ${p.year}, ${h12}:${mm} ${p.hour < 12 ? 'AM' : 'PM'} India time`;
}

const fmtPct = (pct: number | null | undefined) =>
  pct == null ? '—' : `${pct > 0 ? '+' : ''}${(Math.round(pct * 10) / 10).toFixed(1)}%`;
const fmtCount = (n: number) => n.toLocaleString('en-IN');
const fmtShare = (pct: number) => `${(Math.round(pct * 10) / 10).toFixed(1)}%`;

/** Green when the change is good, red when bad, grey when none or unknown. */
function changeColor(pct: number | null | undefined, lowerIsBetter: boolean): string {
  if (pct == null || pct === 0) return MUTED;
  return (pct < 0) === lowerIsBetter ? GOOD : BAD;
}

// ---------- table model ----------

interface Column { label: string; width: number; align?: 'left' | 'right' }
type Cell = string | { text: string; color?: string };

// ---------- renderer ----------

class Writer {
  y = MARGIN;
  constructor(readonly doc: PDFKit.PDFDocument) {}

  ensure(height: number) {
    if (this.y + height > BOTTOM) {
      this.doc.addPage();
      this.y = MARGIN;
    }
  }

  text(s: string, opts: { size?: number; bold?: boolean; color?: string; gap?: number } = {}) {
    const { doc } = this;
    doc.font(opts.bold ? 'Bold' : 'Regular').fontSize(opts.size ?? 9).fillColor(opts.color ?? INK);
    const h = doc.heightOfString(s, { width: WIDTH });
    this.ensure(h);
    doc.text(s, MARGIN, this.y, { width: WIDTH });
    this.y += h + (opts.gap ?? 2);
  }

  /** Starts a section; `keepWith` is how much room must remain below the title so it is never alone at the page bottom. */
  heading(title: string, subtitle?: string, keepWith = ROW_H * 3) {
    this.ensure(24 + (subtitle ? 12 : 0) + keepWith);
    this.y += 8;
    this.text(title, { size: 12, bold: true, gap: subtitle ? 1 : 5 });
    if (subtitle) this.text(subtitle, { size: 8, color: MUTED, gap: 5 });
  }

  private cells(columns: Column[], cells: Cell[], bold = false) {
    const { doc } = this;
    let x = MARGIN;
    columns.forEach((col, i) => {
      const cell = cells[i];
      const text = typeof cell === 'string' ? cell : cell.text;
      const color = typeof cell === 'string' || !cell.color ? (bold ? MUTED : INK) : cell.color;
      doc.font(bold ? 'Bold' : 'Regular').fontSize(8.5).fillColor(color);
      doc.text(text, x + 4, this.y + 5, { width: col.width - 8, height: ROW_H - 6, align: col.align ?? 'left', ellipsis: true });
      x += col.width;
    });
  }

  private tableHeader(columns: Column[]) {
    this.doc.rect(MARGIN, this.y, WIDTH, ROW_H).fill(HEAD_BG);
    this.cells(columns, columns.map((c) => c.label), true);
    this.y += ROW_H;
  }

  table(columns: Column[], rows: Cell[][]) {
    this.ensure(ROW_H * 2);
    this.tableHeader(columns);
    for (const row of rows) {
      if (this.y + ROW_H > BOTTOM) {
        this.doc.addPage();
        this.y = MARGIN;
        this.tableHeader(columns);
      }
      this.cells(columns, row);
      this.doc.moveTo(MARGIN, this.y + ROW_H).lineTo(MARGIN + WIDTH, this.y + ROW_H).lineWidth(0.5).strokeColor(RULE).stroke();
      this.y += ROW_H;
    }
    this.y += 6;
  }
}

/** Room to keep below a heading: the header row plus up to five rows, so a table is never left with one lonely row. */
const keepRows = (n: number) => ROW_H * (Math.min(n, 5) + 1);

function nameColumns(first: string, hasPrev: boolean): Column[] {
  const rest: Column[] = [
    { label: 'Sales', width: 90, align: 'right' },
    { label: 'Orders', width: 60, align: 'right' },
    { label: 'Share', width: 60, align: 'right' },
  ];
  if (hasPrev) rest.push({ label: 'Change', width: 70, align: 'right' });
  const used = rest.reduce((s, c) => s + c.width, 0);
  return [{ label: first, width: WIDTH - used }, ...rest];
}

function breakdownTable(w: Writer, title: string, first: string, rows: BreakdownRow[], hasPrev: boolean) {
  if (rows.length === 0) return;
  w.heading(title, undefined, keepRows(rows.length));
  w.table(nameColumns(first, hasPrev), rows.map((r) => {
    const cells: Cell[] = [r.label, formatRupees(r.current.netSalesPaise), fmtCount(r.current.orders), fmtShare(r.sharePct)];
    if (hasPrev) cells.push({ text: fmtPct(r.changePct), color: changeColor(r.changePct, false) });
    return cells;
  }));
}

function itemsTable(w: Writer, title: string, rows: ItemRow[], hasPrev: boolean) {
  if (rows.length === 0) return;
  w.heading(title, 'Item sales before bill discounts', keepRows(rows.length));
  const tail: Column[] = [
    { label: 'Sold', width: 50, align: 'right' },
    { label: 'Sales', width: 90, align: 'right' },
  ];
  if (hasPrev) tail.push({ label: 'Change', width: 70, align: 'right' });
  const used = 140 + tail.reduce((s, c) => s + c.width, 0);
  const columns: Column[] = [{ label: 'Item', width: WIDTH - used }, { label: 'Category', width: 140 }, ...tail];
  w.table(columns, rows.map((r) => {
    const cells: Cell[] = [r.name, r.category, fmtCount(r.qty), formatRupees(r.salesPaise)];
    if (hasPrev) cells.push({ text: fmtPct(r.changePct), color: changeColor(r.changePct, false) });
    return cells;
  }));
}

// ---------- sections ----------

const HEADLINE: { label: string; key: keyof Totals; money: boolean; lowerIsBetter?: boolean; neutral?: boolean }[] = [
  { label: 'Sales (before tax)', key: 'netSalesPaise', money: true },
  { label: 'Orders', key: 'orders', money: false },
  { label: 'Average order value', key: 'avgOrderPaise', money: true },
  { label: 'Discounts', key: 'discountPaise', money: true, neutral: true },
  { label: 'Tax collected', key: 'taxPaise', money: true, neutral: true },
  { label: 'Service charge', key: 'serviceChargePaise', money: true, neutral: true },
  { label: 'Cancelled orders', key: 'cancelledOrders', money: false, lowerIsBetter: true },
  { label: 'Waste', key: 'wastePaise', money: true, lowerIsBetter: true },
];

function headlineTable(w: Writer, r: ReportData) {
  const cur = r.totals.current;
  const prev = r.totals.previous;
  const hasPrev = prev != null && r.comparison != null;
  w.heading('Headline figures');
  const show = (t: Totals, key: keyof Totals, money: boolean) => (money ? formatRupees(t[key]) : fmtCount(t[key]));
  const columns: Column[] = hasPrev
    ? [
        { label: 'Metric', width: WIDTH - 3 * 105 },
        { label: r.period.label, width: 105, align: 'right' },
        { label: r.comparison!.label, width: 105, align: 'right' },
        { label: 'Change', width: 105, align: 'right' },
      ]
    : [{ label: 'Metric', width: WIDTH - 140 }, { label: r.period.label, width: 140, align: 'right' }];
  w.table(columns, HEADLINE.map((m) => {
    const row: Cell[] = [m.label, show(cur, m.key, m.money)];
    if (hasPrev) {
      const pct = r.totals.changePct[m.key];
      row.push(show(prev!, m.key, m.money));
      row.push({ text: fmtPct(pct), color: m.neutral ? MUTED : changeColor(pct, !!m.lowerIsBetter) });
    }
    return row;
  }));
}

export interface Bar { label: string; cur: number; orders: number; prev: number | null }

/** Groups neighbouring buckets `size` at a time (1 keeps every bucket). */
function condense(current: TrendBucket[], previous: TrendBucket[], size: number): Bar[] {
  const n = current.length; // comparison buckets line up by position; extra ones (a longer previous period) are dropped
  const out: Bar[] = [];
  for (let i = 0; i < n; i += size) {
    const cs = current.slice(i, i + size);
    const ps = previous.slice(i, i + size);
    out.push({
      label: cs[0]?.label ?? '',
      cur: cs.reduce((s, b) => s + b.netSalesPaise, 0),
      orders: cs.reduce((s, b) => s + b.orders, 0),
      prev: previous.length > 0 ? ps.reduce((s, b) => s + b.netSalesPaise, 0) : null,
    });
  }
  return out;
}

/**
 * The chart merges neighbouring buckets so it never needs more than MAX_BAR_PAIRS bar pairs; the table
 * below it keeps every bucket, so each row's label matches its figures (the table runs onto more pages).
 */
export function trendModel(r: ReportData): { chart: Bar[]; table: Bar[] } {
  const { current, previous } = r.trend;
  return {
    chart: condense(current, previous, Math.max(1, Math.ceil(current.length / MAX_BAR_PAIRS))),
    table: condense(current, previous, 1),
  };
}

function trendSection(w: Writer, r: ReportData) {
  const { chart: buckets, table } = trendModel(r);
  if (buckets.length === 0) return;
  const hasPrev = r.comparison != null && r.trend.previous.length > 0;
  const { doc } = w;
  const chartH = 110;
  w.heading('Sales trend', undefined, chartH + 60);

  const legendY = w.y;
  doc.rect(MARGIN, legendY + 1, 8, 8).fill(CURRENT);
  doc.font('Regular').fontSize(8).fillColor(INK).text(r.period.label, MARGIN + 12, legendY, { lineBreak: false });
  if (hasPrev) {
    const x = MARGIN + 12 + doc.widthOfString(r.period.label) + 16;
    doc.rect(x, legendY + 1, 8, 8).fill(COMPARE);
    doc.fillColor(INK).text(r.comparison!.label, x + 12, legendY, { lineBreak: false });
  }
  w.y += 16;

  const top = w.y + 12;
  const base = top + chartH;
  const max = Math.max(1, ...buckets.map((b) => Math.max(b.cur, b.prev ?? 0)));
  doc.font('Regular').fontSize(7).fillColor(MUTED).text(formatRupees(max), MARGIN, w.y, { lineBreak: false });
  doc.moveTo(MARGIN, base).lineTo(MARGIN + WIDTH, base).lineWidth(0.5).strokeColor(MUTED).stroke();
  const pairW = WIDTH / buckets.length;
  const bars = hasPrev ? 2 : 1;
  const barW = Math.min(14, (pairW * 0.8) / bars);
  const step = Math.max(1, Math.ceil(buckets.length / 14));
  const height = (v: number) => (v > 0 ? Math.max(0.5, (v / max) * chartH) : 0);
  buckets.forEach((b, i) => {
    const pairStart = MARGIN + i * pairW + (pairW - barW * bars) / 2;
    if (hasPrev) doc.rect(pairStart, base - height(b.prev ?? 0), barW, height(b.prev ?? 0)).fill(COMPARE);
    const curX = hasPrev ? pairStart + barW : pairStart;
    doc.rect(curX, base - height(b.cur), barW, height(b.cur)).fill(CURRENT);
    if (i % step === 0) {
      doc.font('Regular').fontSize(6.5).fillColor(MUTED)
        .text(b.label, MARGIN + i * pairW, base + 3, { width: pairW * step, height: 9, align: 'left', ellipsis: true });
    }
  });
  w.y = base + 18;

  const columns: Column[] = hasPrev
    ? [{ label: 'Period', width: WIDTH - 3 * 100 }, { label: 'Sales', width: 100, align: 'right' }, { label: 'Orders', width: 100, align: 'right' }, { label: 'Comparison sales', width: 100, align: 'right' }]
    : [{ label: 'Period', width: WIDTH - 200 }, { label: 'Sales', width: 100, align: 'right' }, { label: 'Orders', width: 100, align: 'right' }];
  w.table(columns, table.map((b) => {
    const row: Cell[] = [b.label, formatRupees(b.cur), fmtCount(b.orders)];
    if (hasPrev) row.push(formatRupees(b.prev ?? 0));
    return row;
  }));
}

function rankedItems(items: ItemRow[]): { top: ItemRow[]; lowest: ItemRow[] } {
  const sold = items.filter((i) => i.qty > 0).sort((a, b) => b.salesPaise - a.salesPaise);
  return { top: sold.slice(0, 20), lowest: sold.slice(20).slice(-10).reverse() };
}

// ---------- entry point ----------

export function renderReportPdf(report: ReportWithScope, generatedAt: Date, opts: { compress?: boolean } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: MARGIN,
      bufferPages: true,
      compress: opts.compress ?? true,
      font: path.join(FONT_DIR, 'NotoSans-Regular.ttf'),
      info: { Title: `Alayn report, ${report.period.label}`, Author: 'Alayn' },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      doc.registerFont('Regular', path.join(FONT_DIR, 'NotoSans-Regular.ttf'));
      doc.registerFont('Bold', path.join(FONT_DIR, 'NotoSans-Bold.ttf'));
      const w = new Writer(doc);
      const hasPrev = report.comparison != null && report.totals.previous != null;
      const outlets = report.scope.outletNames;

      w.text(report.scope.businessName || 'Alayn', { size: 18, bold: true, gap: 3 });
      w.text(outlets.length === 1 ? outlets[0] : 'All outlets', { size: 10, gap: 2 });
      w.text(hasPrev ? `${report.period.label} ${report.comparison!.compareLabel}` : report.period.label, { size: 10, bold: true, gap: 2 });
      w.text(generatedLabel(generatedAt), { size: 8, color: MUTED, gap: 4 });
      doc.moveTo(MARGIN, w.y).lineTo(MARGIN + WIDTH, w.y).lineWidth(1).strokeColor(CURRENT).stroke();
      w.y += 6;

      const noSales = report.totals.current.orders === 0 && report.totals.current.netSalesPaise === 0;
      if (noSales) {
        w.heading('No sales in this period', undefined, 0);
      } else {
        if (report.highlights.length > 0) {
          w.heading('Highlights', undefined, 30);
          for (const h of report.highlights) w.text(`•  ${h}`, { size: 9, gap: 3 });
        }
        headlineTable(w, report);
        trendSection(w, report);
        breakdownTable(w, 'Channels', 'Channel', report.channels, hasPrev);
        breakdownTable(w, 'Payments', 'Payment method', report.payments, hasPrev);
        breakdownTable(w, 'Categories', 'Category', report.categories, hasPrev);
        const { top, lowest } = rankedItems(report.items);
        itemsTable(w, 'Top 20 items', top, hasPrev);
        itemsTable(w, 'Lowest 10 items', lowest, hasPrev);
        breakdownTable(w, 'Hours', 'Hour', report.hours, hasPrev);
        breakdownTable(w, 'Weekdays', 'Weekday', report.weekdays, hasPrev);
      }

      if (report.waste.length > 0) {
        w.heading('Waste by reason', undefined, keepRows(report.waste.length));
        w.table(
          [{ label: 'Reason', width: WIDTH - 200 }, { label: 'Cost', width: 100, align: 'right' }, { label: 'Entries', width: 100, align: 'right' }],
          report.waste.map((r) => [r.label, formatRupees(r.current.netSalesPaise), fmtCount(r.current.orders)]),
        );
      }
      if (!noSales && outlets.length > 1) breakdownTable(w, 'Outlets', 'Outlet', report.outlets, hasPrev);

      if (report.notes.length > 0) {
        w.heading('Notes', undefined, 20);
        for (const n of report.notes) w.text(`•  ${n}`, { size: 8.5, color: MUTED, gap: 3 });
      }

      // Footer on every page. The footer sits inside the bottom margin, so lift it for these writes.
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(range.start + i);
        doc.page.margins.bottom = 0;
        doc.font('Regular').fontSize(7.5).fillColor(MUTED)
          .text(`Sales are settled bills before tax · Page ${i + 1} of ${range.count}`, MARGIN, PAGE_H - MARGIN + 6, { width: WIDTH, align: 'center', lineBreak: false });
      }
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
