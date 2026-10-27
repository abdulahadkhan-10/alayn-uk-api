import * as XLSX from 'xlsx';
import { renderReportXlsx, renderReportCsv } from '../src/modules/reports/export/sheets';
import { renderReportPdf, reportFileName, trendModel } from '../src/modules/reports/export/pdf';
import { ReportData, Totals, BreakdownRow, ItemRow } from '../src/modules/reports/aggregate';

const totals = (n: number): Totals => ({
  netSalesPaise: 1234500 * n, orders: 40 * n, avgOrderPaise: 30862, discountPaise: 5000, taxPaise: 61725,
  serviceChargePaise: 0, cancelledOrders: 2, cancelledPaise: 9000, wastePaise: 12000, itemsSold: 90 * n,
});
const row = (i: number): BreakdownRow => ({
  key: `k${i}`, label: `Row ${i}`, current: { netSalesPaise: 100000 * (i + 1), orders: 5 }, previous: { netSalesPaise: 90000, orders: 4 },
  changePct: 11.1, sharePct: 20,
});
const item = (i: number): ItemRow => ({
  menuItemId: `m${i}`, name: `Item number ${i}`, category: 'Mains', qty: 10 + i, salesPaise: 50000 + i * 100,
  prevQty: 8, prevSalesPaise: 40000, changePct: 25,
});
const start = new Date('2026-09-30T23:30:00.000Z').toISOString(); // 1 Oct 2026, 5 AM India time (business day start)
const end = new Date('2026-10-31T23:29:59.999Z').toISOString(); // end of 31 Oct 2026's business day (4:59 AM 1 Nov)

function report(over: Partial<ReportData> = {}, items = 0): ReportData & { scope: { outletNames: string[]; businessName: string } } {
  return {
    period: { start, end, label: '1–31 Oct 2026' },
    comparison: { start, end, label: '1–30 Sep 2026', compareLabel: 'vs 1–30 Sep 2026' },
    totals: { current: totals(1), previous: totals(1), changePct: { netSalesPaise: 12.5, wastePaise: -10, orders: null } },
    trend: { granularity: 'day', current: [{ label: '1 Oct', start, netSalesPaise: 50000, orders: 3, wastePaise: 0 }], previous: [{ label: '1 Sep', start, netSalesPaise: 40000, orders: 2, wastePaise: 0 }] },
    channels: [row(0), row(1)], payments: [row(0)], categories: [row(0)], outlets: [row(0), row(1)],
    hours: [row(0)], weekdays: [row(0)], waste: [row(0)],
    items: Array.from({ length: items }, (_, i) => item(i)),
    highlights: ['Sales are up 12.5% on last month'], notes: ['Payments are amounts received, including tax'],
    scope: { outletNames: ['Brew Bay Bandra'], businessName: 'Brew Bay' },
    ...over,
  };
}

describe('report pdf', () => {
  it('pdf starts with %PDF and is non-trivial', async () => {
    const buf = await renderReportPdf(report({}, 5), new Date('2026-11-01T05:00:00Z'));
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buf.length).toBeGreaterThan(5_000);
  });

  it('pdf renders an empty report without throwing', async () => {
    const empty = report({
      totals: { current: totals(0), previous: null, changePct: {} }, comparison: null,
      trend: { granularity: 'day', current: [], previous: [] },
      channels: [], payments: [], categories: [], outlets: [], hours: [], weekdays: [], waste: [], items: [], highlights: [],
    });
    empty.totals.current.orders = 0;
    const buf = await renderReportPdf(empty, new Date());
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('pdf with 200 items has more than one page', async () => {
    const buf = await renderReportPdf(report({}, 200), new Date(), { compress: false });
    const pages = buf.toString('latin1').match(/\/Type \/Page\b(?!s)/g) ?? [];
    expect(pages.length).toBeGreaterThan(1);
  });

  it('a 45-day report merges bars in the chart but lists every day in the trend table', () => {
    const day = (i: number, month: string) => ({ label: `${i + 1} ${month}`, start, netSalesPaise: 1000 * (i + 1), orders: i + 1, wastePaise: 0 });
    const r = report({
      trend: {
        granularity: 'day',
        current: Array.from({ length: 45 }, (_, i) => day(i, 'Oct')),
        previous: Array.from({ length: 45 }, (_, i) => day(i, 'Aug')),
      },
    });
    const { chart, table } = trendModel(r);
    expect(chart.length).toBeLessThanOrEqual(31);
    expect(table).toHaveLength(45);
    expect(table[0]).toEqual({ label: '1 Oct', cur: 1000, orders: 1, prev: 1000 });
    expect(table[1]).toEqual({ label: '2 Oct', cur: 2000, orders: 2, prev: 2000 });
  });

  it('file name', () => {
    expect(reportFileName(report(), 'pdf')).toBe('alayn-report_brew-bay-bandra_2026-10-01_to_2026-10-31.pdf');
    expect(reportFileName(report({}, 0), 'csv', 'items')).toBe('alayn-report_brew-bay-bandra_2026-10-01_to_2026-10-31_items.csv');
    const multi = report();
    multi.scope.outletNames = ['A', 'B'];
    expect(reportFileName(multi, 'xlsx')).toBe('alayn-report_all-outlets_2026-10-01_to_2026-10-31.xlsx');
  });
});

describe('report xlsx and csv', () => {
  it('xlsx has a sheet per section', () => {
    const wb = XLSX.read(renderReportXlsx(report({}, 3)), { type: 'buffer', cellNF: true });
    expect(wb.SheetNames).toEqual(expect.arrayContaining(['Summary', 'Trend', 'Items', 'Categories', 'Outlets']));
    // The items sheet opens with a note; the table starts on row 2
    expect(wb.Sheets.Items.A1.v).toBe('Item sales before bill discounts');
    const items = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets.Items, { range: 1 });
    expect(items).toHaveLength(3);
    expect(items[0]['Sales ₹']).toBe(500);
    expect(wb.Sheets.Items.D3.z).toBe('#,##0.00');
    expect(typeof items[0]['Sales ₹']).toBe('number');
    const summary = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets.Summary);
    expect(Object.keys(summary[0])).toEqual(['Metric', '1–31 Oct 2026', '1–30 Sep 2026', 'Change %']);
    expect(summary[0]['1–31 Oct 2026']).toBe(12345);
  });

  it('xlsx drops comparison columns when there is no comparison', () => {
    const wb = XLSX.read(renderReportXlsx(report({ comparison: null }, 1)), { type: 'buffer' });
    const items = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets.Items, { range: 1 });
    expect(Object.keys(items[0])).toEqual(['Item', 'Category', 'Qty', 'Sales ₹']);
  });

  it('csv items header and first row', () => {
    const lines = renderReportCsv(report({}, 2), 'items').split('\r\n');
    expect(lines[0]).toBe('\uFEFFItem,Category,Qty,Sales ₹,Comparison qty,Comparison sales ₹,Change %');
    expect(lines[1]).toBe('Item number 0,Mains,10,500.00,8,400.00,25.0');
    expect(lines[3]).toBe('');
  });

  it('csv starts with a BOM', () => {
    expect(renderReportCsv(report(), 'summary').charCodeAt(0)).toBe(0xfeff);
  });

  it('csv quotes names with commas and leaves nulls empty', () => {
    const r = report({}, 1);
    r.items[0].name = 'Paneer, Tikka';
    r.items[0].prevQty = null;
    r.items[0].prevSalesPaise = null;
    r.items[0].changePct = null;
    expect(renderReportCsv(r, 'items').split('\r\n')[1]).toBe('"Paneer, Tikka",Mains,10,500.00,,,');
  });

  it('csv guards formulas in text but leaves negative numbers alone', () => {
    const r = report({}, 2);
    r.items[0].name = '=HYPERLINK(1)';
    r.items[1].name = '-Special';
    r.items[1].changePct = -12.5;
    const lines = renderReportCsv(r, 'items').split('\r\n');
    expect(lines[1].startsWith("'=HYPERLINK(1),")).toBe(true);
    expect(lines[2]).toBe("'-Special,Mains,11,500.99,8,400.00,-12.5".replace('500.99', '501.00'));
  });
});
