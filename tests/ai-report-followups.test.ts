import { aiService } from '../src/modules/ai/ai.service';
import { buildReport } from '../src/modules/reports/report.service';

jest.mock('../src/config/prisma', () => ({ prisma: {} }));
jest.mock('../src/modules/reports/report.service', () => ({ buildReport: jest.fn() }));
jest.mock('../src/modules/reports/access', () => ({ businessOutletIds: jest.fn(async () => ['o1']) }));
jest.mock('../src/modules/ai/aiContext', () => ({
  ...jest.requireActual('../src/modules/ai/aiContext'),
  buildExtendedContext: jest.fn(async () => ''),
}));

const report = {
  period: { label: 'Sep 2026', compareLabel: 'vs Aug 2026' },
  totals: { current: { netSalesPaise: 100, orders: 1, avgOrderPaise: 100 }, previous: null, changePct: {} },
  highlights: [], channels: [], items: [], hourly: [], days: [], categories: [], outlets: [],
  scope: { outletNames: ['One'], businessName: 'Biz' },
};

// Wed 21 Oct 2026, 3 PM India time
const NOW = new Date(Date.UTC(2026, 9, 21, 15, 0) - 330 * 60 * 1000);
const user = (content: string) => ({ role: 'user' as const, content });
const assistant = (content: string) => ({ role: 'assistant' as const, content });

async function systemPrompt(prompt: string, history: { role: 'user' | 'assistant'; content: string }[], role: string | null = 'BUSINESS_OWNER') {
  const prepared: any = await (aiService as any).prepareReply(prompt, 'o1', 'b1', history, role ?? undefined);
  return prepared.messages[0].content as string;
}

describe('Report periods in follow-up questions', () => {
  beforeAll(() => {
    // Only the clock is faked, so promises and timers behave normally
    jest.useFakeTimers({
      now: NOW,
      doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'],
    });
  });
  afterAll(() => jest.useRealTimers());

  beforeEach(() => {
    (buildReport as jest.Mock).mockReset();
    (buildReport as jest.Mock).mockResolvedValue(report);
    jest.spyOn(aiService as any, 'getProductionDbContext').mockResolvedValue('- Outlet Scope: One');
    jest.spyOn(aiService as any, 'getForecastContext').mockResolvedValue('');
  });

  it('"August report" then "who is working today" brings no report figures or report rules', async () => {
    const content = await systemPrompt('who is working today', [user('August report'), assistant('August sales were ₹1')]);
    expect(content).not.toContain('[REQUESTED PERIODS]');
    expect(content).not.toContain('REPORTS:');
    expect(buildReport).not.toHaveBeenCalled();
  });

  it('"how was August" then "and September?" compares September with August', async () => {
    const content = await systemPrompt('and September?', [user('how was August'), assistant('August sales were ₹1')]);
    expect(content).toContain('[REQUESTED PERIODS]');
    expect((buildReport as jest.Mock).mock.calls[0][0]).toMatchObject({
      custom: { from: '2026-09-01', to: '2026-09-30' },
      compare: 'CUSTOM',
      compareCustom: { from: '2026-08-01', to: '2026-08-31' },
    });
  });

  it('"a report for that day" uses the day the last answer named, typos included', async () => {
    const history = [
      user('which was my busiest day last week?'),
      assistant('Saturday 10 Oct was the busiest day last week, with sales of ₹36,440.'),
    ];
    for (const prompt of ['give me a report for that day please', 'give me a report fo taht day please']) {
      (buildReport as jest.Mock).mockClear();
      const content = await systemPrompt(prompt, history);
      expect(content).toContain('[REQUESTED PERIODS]');
      expect((buildReport as jest.Mock).mock.calls[0][0]).toMatchObject({ custom: { from: '2026-10-10', to: '2026-10-10' }, compare: 'PREVIOUS' });
    }
  });

  it('report rules forbid estimated figures and other /reports links', async () => {
    const content = await systemPrompt('August vs September report', []);
    expect(content).toContain('never change the link');
    expect(content).toContain('Never estimate a figure');
  });

  it('"who is working today" then "and tomorrow?" stays a staff conversation: no report figures', async () => {
    const content = await systemPrompt('and tomorrow?', [user('who is working today'), assistant('Asha and Ravi')]);
    expect(content).not.toContain('[REQUESTED PERIODS]');
    expect(buildReport).not.toHaveBeenCalled();
  });

  it('"who is working today" then "and yesterday?" brings no report either', async () => {
    const content = await systemPrompt('and yesterday?', [user('who is working today')]);
    expect(content).not.toContain('[REQUESTED PERIODS]');
    expect(buildReport).not.toHaveBeenCalled();
  });

  it('only earlier sales questions are joined: a staff question in between is skipped', async () => {
    await systemPrompt('and September?', [user('how was August'), user('who is working today')]);
    expect(buildReport).not.toHaveBeenCalled(); // the latest turn was about staff
    await systemPrompt('and September sales?', [user('who is working today'), user('how was August')]);
    expect((buildReport as jest.Mock).mock.calls[0][0]).toMatchObject({
      custom: { from: '2026-09-01', to: '2026-09-30' },
      compareCustom: { from: '2026-08-01', to: '2026-08-31' },
    });
  });

  it('a sales question without a period still follows on from the earlier period', async () => {
    await systemPrompt('what about by channel?', [user('August report')]);
    expect((buildReport as jest.Mock).mock.calls[0][0]).toMatchObject({ custom: { from: '2026-08-01', to: '2026-08-31' } });
  });

  it('a new sales question with its own period ignores the earlier one', async () => {
    await systemPrompt('how were sales yesterday?', [user('August report')]);
    expect(buildReport).toHaveBeenCalledTimes(1);
    expect((buildReport as jest.Mock).mock.calls[0][0]).toMatchObject({ preset: 'YESTERDAY', compare: 'PREVIOUS' });
  });

  it('asks for both periods in words and bans abbreviations in report answers', async () => {
    const content = await systemPrompt('August vs September report', []);
    expect(content).toMatch(/first line names both periods in words/i);
    expect(content).toContain('1–15 Sep sales were up 49.0% on 1–15 Aug');
    expect(content).toMatch(/never write YoY, MoM, WoW, Avg, AOV/i);
  });

  it.each(['STAFF', 'KITCHEN', 'SUPPLIER', null])('%s gets no report figures or report rules', async (role) => {
    const content = await systemPrompt('August vs September report', [], role);
    expect(content).not.toContain('[REQUESTED PERIODS]');
    expect(content).not.toContain('REPORTS:');
    expect(buildReport).not.toHaveBeenCalled();
  });

  it.each(['BUSINESS_OWNER', 'MANAGER', 'SUPER_ADMIN'])('%s gets the report figures', async (role) => {
    const content = await systemPrompt('August vs September report', [], role);
    expect(content).toContain('[REQUESTED PERIODS]');
    expect(buildReport).toHaveBeenCalled();
  });
});
