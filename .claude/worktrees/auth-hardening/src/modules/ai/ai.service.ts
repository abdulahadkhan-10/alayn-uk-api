import { prisma } from '../../config/prisma';
import { logger } from '../../config/logger';
import { outletScope } from '../../utils/tenantScope';
import { outletDayStart, outletLocalParts, outletStartOfDay } from '../../utils/outletTime';
import { DashboardService } from '../analytics/dashboard.service';
import { InventoryRepository } from '../inventory/inventory.repository';
import { RUN_OUT_WARN_DAYS, stockOutlook } from '../analytics/runOut';
import { isCodingRequest } from './guardrails';
import { buildExtendedContext, detectTopics, Topic } from './aiContext';

/*
 * Which topic each snapshot line belongs to. Lines marked 'core' always go to the model; the rest only
 * when the question is about that topic. 'never' lines are covered in more detail elsewhere.
 */
const LINE_TOPICS: [prefix: string, topic: Topic | 'core' | 'never' | 'salesOrStaff'][] = [
  ['- Outlet Scope', 'core'],
  ["- Today's Revenue", 'core'],
  ['- MTD Net Revenue', 'core'],
  ['- Today is', 'core'],
  ['- Average Ticket Value', 'sales'],
  ['- Sales Forecast', 'salesOrStaff'], // staffing questions need to know the busy days
  ['- Daily Forecast', 'salesOrStaff'],
  ['- Total Staff Count', 'staff'],
  ['- Dining Floor', 'staff'],
  ['- Low Stock Alerts', 'stock'],
  ['- Running Out Soon', 'stock'],
  ['- Recorded Waste', 'stock'],
  ['- Top Selling Menu Items', 'never'], // the menu section lists every item sold
];

/** Keeps only the snapshot lines this question needs. */
function trimContext(text: string, topics: Set<Topic>): string {
  return text
    .split('\n')
    .filter((line) => {
      const match = LINE_TOPICS.find(([prefix]) => line.startsWith(prefix));
      if (!match) return true; // section headers and anything unclassified
      const topic = match[1];
      if (topic === 'core') return true;
      if (topic === 'never') return false;
      if (topic === 'salesOrStaff') return topics.has('sales') || topics.has('staff');
      return topics.has(topic);
    })
    .join('\n');
}

const rupees = (n: number) => `₹${n.toLocaleString('en-IN')}`;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Sat 17 Oct" for a forecast point — weekday names stop the model guessing which days are the weekend. */
const dayLabel = (p: { date: string }) => {
  const weekday = WEEKDAYS[new Date(`${p.date}T00:00:00Z`).getUTCDay()];
  const [, m, d] = p.date.split('-').map(Number);
  const month = new Date(Date.UTC(2000, m - 1, 1)).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  return `${weekday} ${d} ${month}`;
};

/** An earlier message in the same AlaynAI conversation. */
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * What the streaming endpoint sends, in order: the data sections checked, the answer in pieces as it
 * is written, then done (or error if it was cut off part way).
 */
export type StreamEvent =
  | { type: 'chat'; chatId: string; title: string } // the saved chat this answer belongs to
  | { type: 'topics'; topics: Topic[] }
  | { type: 'delta'; text: string }
  | { type: 'done'; source: 'groq' | 'fallback' | 'guardrail' }
  | { type: 'error'; message: string };

// Tried in order; the next one is used when a model is rate-limited or down
const GROQ_MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'];
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

type GroqMessage = { role: 'system' | 'user' | 'assistant'; content: string };

function groqRequest(model: string, messages: GroqMessage[], stream: boolean, key: string, signal?: AbortSignal) {
  return fetch(GROQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
      // Short answers by design; gpt-oss also spends part of this on hidden reasoning, kept low below
      max_tokens: 1000,
      ...(model.startsWith('openai/gpt-oss') ? { reasoning_effort: 'low' } : {}),
      ...(stream ? { stream: true } : {}),
    }),
    signal,
  });
}

/** Tokens one Groq call used, as Groq reports them */
export interface GroqUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/**
 * One log line per answer with the tokens it used, split into what was sent (instructions, café data,
 * earlier turns, question) and what came back, so the real cost per question can be read from the logs.
 */
function logUsage(
  usage: GroqUsage | undefined,
  info: { model: string; outletId?: string; topics: Set<Topic>; messages: GroqMessage[]; streamed: boolean },
) {
  if (!usage) return;
  const historyMessages = info.messages.filter((m) => m.role !== 'system').length - 1; // minus the new question
  logger.info(
    {
      model: info.model,
      outletId: info.outletId,
      streamed: info.streamed,
      topics: [...info.topics],
      historyMessages,
      // Rough split of what was sent: the system message is instructions plus café data
      systemChars: info.messages[0]?.content.length ?? 0,
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
    },
    '[AlaynAI] Token usage',
  );
}

/**
 * The answer text from a Groq (OpenAI-style) server-sent-events stream, piece by piece. Groq puts the
 * token usage in the last chunk (under `x_groq.usage`); it is passed to `onUsage`.
 */
export async function* groqDeltas(body: ReadableStream<Uint8Array>, onUsage?: (usage: GroqUsage) => void): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const data = line.trim();
      if (!data.startsWith('data:')) continue;
      const payload = data.slice(5).trim();
      if (payload === '[DONE]') return;
      let chunk: any;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue; // A malformed line is skipped rather than ending the answer
      }
      const usage = chunk?.x_groq?.usage ?? chunk?.usage;
      if (usage && onUsage) onUsage(usage);
      // Only the visible answer; gpt-oss's hidden reasoning comes in a separate field
      const text = chunk?.choices?.[0]?.delta?.content;
      if (typeof text === 'string' && text) yield text;
    }
  }
}

export class AiService {
  private dashboardService = new DashboardService();

  /**
   * The same sales forecast the dashboard chart shows, as plain text, so AlaynAI never quotes
   * a different (or invented) projection. Failures here must not break the assistant.
   */
  private async getForecastContext(outletId?: string, businessId?: string): Promise<string> {
    try {
      const f = await this.dashboardService.getSalesForecast(outletId, businessId);
      if (f.status === 'learning' || !f.summary) {
        return `- Sales Forecast: Not available yet. Alayn has seen ${f.salesDays} day(s) of sales and gives a first estimate after ${f.earlyEstimateAfterDays}. Do NOT estimate or invent future sales figures; say an estimate will appear once enough sales are recorded.`;
      }
      const early = f.status === 'early'
        ? ` EARLY ESTIMATE based on only ${f.salesDays} days of sales: treat as rough and say so; the full forecast starts after ${f.fullForecastAfterDays} days.`
        : '';
      const future = f.points.filter((p) => p.isFuture).slice(0, 7);
      const low = future.reduce((s, p) => s + (p.low ?? 0), 0);
      const high = future.reduce((s, p) => s + (p.high ?? 0), 0);
      const daily = future
        .map((p) =>
          p.closed
            ? `${dayLabel(p)}: closed`
            : `${dayLabel(p)}: ${rupees(p.projected ?? 0)}${p.low !== null && p.high !== null ? ` (likely ${rupees(p.low)}–${rupees(p.high)})` : ''}`,
        )
        .join(', ');
      const today = f.points.find((p) => p.isToday);
      const pct = f.summary.vsLast7DaysPct;
      const change = pct === null
        ? 'no full week yet to compare with'
        : `${pct >= 0 ? '+' : ''}${pct}% vs last 7 days (${rupees(f.summary.last7DaysActual)})`;
      const accuracy = f.accuracy
        ? `past forecasts were off by ${f.accuracy.mapePct}% on average (checked on ${f.accuracy.daysEvaluated} days)`
        : 'accuracy not measured yet';
      const coverage = f.coverage.forecasted < f.coverage.total
        ? ` (covers ${f.coverage.forecasted} of ${f.coverage.total} outlets; the rest are too new)`
        : '';
      return [
        ...(today ? [`- Today is ${dayLabel(today)} (Sat and Sun are the weekend)`] : []),
        `- Sales Forecast, next 7 days (before tax): ${rupees(f.summary.next7DaysProjected)}, likely between ${rupees(low)} and ${rupees(high)}, ${change}; ${accuracy}${coverage}.${early}`,
        `- Daily Forecast: ${daily}`,
      ].join('\n');
    } catch (err) {
      logger.error({ err, outletId }, '[AlaynAI] Sales forecast unavailable for assistant context');
      return '- Sales Forecast: Unavailable right now. Do NOT estimate future sales figures.';
    }
  }

  /**
   * Production-grade, highly optimized DB context aggregator.
   * Uses parallel queries, select filters, aggregations, and indexed lookups.
   */
  private async getProductionDbContext(outletId?: string, businessId?: string): Promise<string> {
    const isAll = !outletId || outletId === 'all';
    
    // Always limited to one outlet or the caller's own business (never every business)
    const orderOutletFilter = outletScope(outletId, businessId);
    const directOutletFilter = outletScope(outletId, businessId);

    // India-time day / month boundaries (the server runs in UTC)
    const now = new Date();
    const { year: localYear, month: localMonth } = outletLocalParts(now);
    const startOfCurrentMonth = outletDayStart(localYear, localMonth, 1);
    const startOfToday = outletStartOfDay(now);

    // Execute optimized queries in parallel
    const [
      outletInfo,
      revenueAggregate,
      todayRevenueAggregate,
      topMenuItems,
      stock,
      recentWasteAggregate,
      staffCount,
      activeStaffCount,
      tableStats,
    ] = await Promise.all([
      // 1. Outlet Name & Details
      !isAll && outletId
        ? prisma.outlet.findUnique({
            where: { id: outletId },
            select: { name: true, city: true, openingTime: true, closingTime: true },
          })
        : null,

      // 2. MTD Revenue & Order Count — settled sales before tax (same rule as the dashboard)
      prisma.order.aggregate({
        where: {
          ...orderOutletFilter,
          status: 'COMPLETED',
          createdAt: { gte: startOfCurrentMonth },
          deletedAt: null,
        },
        _sum: { subtotalPaise: true, discountPaise: true },
        _count: { id: true },
      }),

      // 3. Today's Revenue & Order Count — settled sales before tax
      prisma.order.aggregate({
        where: {
          ...orderOutletFilter,
          status: 'COMPLETED',
          createdAt: { gte: startOfToday },
          deletedAt: null,
        },
        _sum: { subtotalPaise: true, discountPaise: true },
        _count: { id: true },
      }),

      // 4. Top 5 Menu Items (Group by quantity)
      prisma.orderItem.groupBy({
        by: ['menuItemId'],
        where: {
          order: {
            ...orderOutletFilter,
            status: { not: 'CANCELLED' },
            createdAt: { gte: startOfCurrentMonth },
            deletedAt: null,
          },
        },
        _sum: { quantity: true },
        orderBy: { _sum: { quantity: 'desc' } },
        take: 5,
      }).then(async (groups) => {
        if (groups.length === 0) return [];
        const itemIds = groups.map((g) => g.menuItemId);
        const items = await prisma.menuItem.findMany({
          where: { id: { in: itemIds } },
          select: { id: true, name: true, pricePaise: true },
        });
        const itemMap = new Map(items.map((i) => [i.id, i]));
        return groups.map((g) => ({
          name: itemMap.get(g.menuItemId)?.name || 'Unknown Item',
          volume: g._sum.quantity || 0,
          pricePaise: itemMap.get(g.menuItemId)?.pricePaise || 0,
        }));
      }),

      // 5. Low stock (up to 5) and items about to run out at the recent rate of use: the same stock-ledger
      // figures as the Inventory page and the Overview's "Needs attention", so AlaynAI never contradicts them
      new InventoryRepository().findManyItems(outletId ?? 'all', businessId ?? undefined).then(async (items) => {
        const outlook = await stockOutlook(outletId, businessId ?? undefined, now, items);
        return {
          low: items
            .filter((i) => i.currentStock <= i.reorderThreshold)
            .slice(0, 5)
            .map((i) => ({ name: i.name, unit: i.unit, stock: +i.currentStock.toFixed(2), threshold: i.reorderThreshold })),
          runningOut: items
            .filter((i) => i.currentStock > i.reorderThreshold)
            .map((i) => ({ name: i.name, days: outlook.get(i.id)?.daysLeft ?? null }))
            .filter((i): i is { name: string; days: number } => i.days !== null && i.days <= RUN_OUT_WARN_DAYS)
            .sort((a, b) => a.days - b.days)
            .slice(0, 5),
        };
      }),

      // 6. Recent Waste Log Aggregation (Current Month)
      prisma.wasteLog.aggregate({
        where: {
          ...directOutletFilter,
          createdAt: { gte: startOfCurrentMonth },
        },
        _sum: { costAtLoggingPaise: true },
        _count: { id: true },
      }),

      // 7. Total Employee Count
      prisma.employee.count({
        where: {
          ...directOutletFilter,
          deletedAt: null,
        },
      }),

      // 8. Active Employee Count
      prisma.employee.count({
        where: {
          ...directOutletFilter,
          status: 'ACTIVE',
          deletedAt: null,
        },
      }),

      // 9. Dining Floor Table Occupancy Summary
      prisma.table.groupBy({
        by: ['status'],
        where: {
          ...directOutletFilter,
          deletedAt: null,
        },
        _count: { id: true },
      }),
    ]);

    // Format metrics into a concise context block
    const mtdRevenue = ((revenueAggregate._sum.subtotalPaise || 0) - (revenueAggregate._sum.discountPaise || 0)) / 100;
    const mtdOrders = revenueAggregate._count.id || 0;
    const avgOrderValue = mtdOrders > 0 ? (mtdRevenue / mtdOrders).toFixed(2) : '0';

    const todayRevenue = ((todayRevenueAggregate._sum.subtotalPaise || 0) - (todayRevenueAggregate._sum.discountPaise || 0)) / 100;
    const todayOrders = todayRevenueAggregate._count.id || 0;

    const wasteCost = (recentWasteAggregate._sum.costAtLoggingPaise || 0) / 100;
    const wasteCount = recentWasteAggregate._count.id || 0;

    let occupiedTables = 0;
    let totalTables = 0;
    for (const t of tableStats) {
      totalTables += t._count.id;
      if (t.status === 'OCCUPIED') occupiedTables += t._count.id;
    }

    // Empty data is reported as empty: an example value here would be repeated to the owner as fact
    const topItemStr = topMenuItems.length > 0
      ? topMenuItems.map((i) => `${i.name} (${i.volume} sold)`).join(', ')
      : 'None yet (no items sold this month)';

    const lowStockStr = stock.low.length > 0
      ? stock.low.map((i) => `${i.name} (${i.stock} ${i.unit} left, threshold: ${i.threshold})`).join(', ')
      : 'None (no items at or below their reorder level)';
    const runningOutStr = stock.runningOut.length > 0
      ? stock.runningOut.map((i) => `${i.name} (about ${Math.max(0, +i.days.toFixed(1))} days left at the recent rate of use)`).join(', ')
      : 'None';

    const outletName = outletInfo?.name || (isAll ? 'All Outlets' : 'Main Outlet');

    return `
[OUTLET DATA]
- Outlet Scope: ${outletName}
- MTD Net Revenue: ₹${mtdRevenue.toLocaleString('en-IN')} across ${mtdOrders} orders
- Today's Revenue: ₹${todayRevenue.toLocaleString('en-IN')} (${todayOrders} settled orders today)
- Average Ticket Value (AOV): ₹${avgOrderValue}
- Total Staff Count: ${staffCount} (${activeStaffCount} active employees)
- Dining Floor: ${occupiedTables} occupied out of ${totalTables} total tables
- Top Selling Menu Items: ${topItemStr}
- Low Stock Alerts: ${lowStockStr}
- Running Out Soon (above reorder level, but lasting ${RUN_OUT_WARN_DAYS} days or less): ${runningOutStr}
- Recorded Waste (MTD): ₹${wasteCost.toLocaleString('en-IN')} across ${wasteCount} waste events
`.trim();
  }

  /**
   * Checks the question and builds everything a reply needs: the messages for the model (instructions,
   * the café data this question needs, earlier turns) and the full data for the built-in fallback.
   * Off-topic questions get the standard rejection instead.
   */
  private async prepareReply(
    prompt: string,
    outletId?: string,
    businessId?: string,
    history: ChatTurn[] = [],
  ): Promise<{ rejection: string } | { messages: GroqMessage[]; topics: Set<Topic>; dbContext: string; forecastContext: string }> {
    const standardRejection = "I am AlaynAI, your restaurant operational executive assistant. I can only assist with restaurant operational queries, sales forecasts, inventory management, menu analytics, and shift staffing for your outlet.";

    logger.info({ outletId, prompt }, '[AlaynAI] Incoming assistant request');

    // Guardrail Check 1: Fast keyword check for code/programming/out-of-scope prompts
    if (isCodingRequest(prompt)) {
      logger.warn({ outletId, prompt, rejection: standardRejection }, '[AlaynAI] Out-of-context query rejected');
      return { rejection: standardRejection };
    }

    // Retrieve production-grade DB Context
    // Earlier questions count too, so "and Sunday?" after a sales question still gets sales data
    const topics = detectTopics([prompt, ...history.filter((t) => t.role === 'user').slice(-2).map((t) => t.content)].join(' '));
    const [baseContext, forecastContext, extendedContext] = await Promise.all([
      this.getProductionDbContext(outletId, businessId),
      this.getForecastContext(outletId, businessId),
      buildExtendedContext(outletId, businessId, new Date(), topics),
    ]);
    // The built-in fallback reads the full snapshot; the model only gets what the question needs
    const dbContext = `${baseContext}
${forecastContext}`;
    const modelContext = `${trimContext(dbContext, topics)}
${extendedContext}`;

    // System instruction prompt framing AlaynAI
    const systemInstruction = `You are AlaynAI, the Executive Assistant for Alayn Restaurant & Hospitality Operations Management Platform.
You assist restaurant managers, business owners, and chefs with real-time operational decisions, sales velocity forecasts, inventory management, menu pair optimizations, and workforce staffing.

HOW TO ANSWER (owners read this on their phone between orders):
- Answer exactly what was asked, in the FIRST sentence, with the key number or name. No preamble.
- Add the one or two details that make the answer useful on its own (for a forecast: the likely range; for busiest hours: the typical sales in those hours), but nothing more.
- Keep it short: about 80 words. For a broad question ("how is business?", "give me a summary") up to 150 words, covering only the 3-4 most important points. Go longer only if the user asks for detail or a report.
- Do not add advice, tips or recommendations unless the user asks for them ("what should I do", "how can I improve"). At most one short tip, and only if it follows directly from the numbers.
- No title or heading for short answers. Use a few short headings only when the answer has 3 or more separate parts.
- Use a table only to compare 3 or more rows; otherwise use plain sentences or a short bullet list.
- Never mention "telemetry", "snapshot", "the data provided" or where the numbers come from, unless the user asks.
- Never invent targets, goals, labels or explanations the data does not support. Report a number as what it is (a forecast is a forecast, not a target).
- Write times as 1 PM / 10:30 AM, amounts as ₹37,278.
- Simple, plain English. No emojis. No buzzwords. No abbreviations: say "this month so far" not "MTD", "average order value" not "AOV".


STRICT DOMAIN GUARDRAILS:
1. You MUST ONLY answer questions related to restaurant management, food business operations, sales, inventory, menu items, staff roster, dining floor, customer feedback, and operational strategy.
2. If the user asks for source code (Python, JavaScript, C++, Java, HTML, SQL, etc.), coding instructions, software development, math homework, or any topic outside restaurant management, YOU MUST REJECT IT IMMEDIATELY using exact text:
"${standardRejection}"
3. Base your operational numbers, recommendations, and insights directly on the outlet data below. Do not make up fake metrics if the data provides specific numbers. For any future sales question, use ONLY the Sales Forecast lines; never invent percentages or surges.
4. If a line says "None" or "Unavailable", or the data below does not cover something, say that plainly. Never fill the gap with example names, items, times or numbers.
5. Provide a complete, fully finished response without cutting off.

${modelContext}
`;

    const messages: GroqMessage[] = [
      { role: 'system', content: systemInstruction },
      // Earlier turns let follow-ups like "and Sunday?" make sense; the data above is always current
      ...history,
      { role: 'user', content: prompt },
    ];
    return { messages, topics, dbContext, forecastContext };
  }

  /** Answers a question in one piece (the original endpoint, and the fallback when streaming fails). */
  async queryAssistant(prompt: string, outletId?: string, businessId?: string, history: ChatTurn[] = []): Promise<string> {
    const reply = await this.prepareReply(prompt, outletId, businessId, history);
    if ('rejection' in reply) return reply.rejection;

    // ── Tier 1: Groq Cloud (contractually never trains on inputs/outputs, on every tier) ──
    // Groq may still keep logs for up to 30 days for abuse/reliability unless Zero Data Retention is
    // switched on under Data Controls in the Groq console.
    const groqKey = process.env.GROQ_API_KEY;
    if (groqKey) {
      for (const model of GROQ_MODELS) {
        try {
          const groqRes = await groqRequest(model, reply.messages, false, groqKey);
          if (!groqRes.ok) {
            const errText = await groqRes.text();
            logger.warn({ model, status: groqRes.status, errText }, '[AlaynAI] Groq model attempt failed, trying fallback...');
            continue;
          }
          const data = (await groqRes.json()) as any;
          const text = data?.choices?.[0]?.message?.content;
          if (text && text.trim()) {
            logger.info({ model, outletId, prompt }, '[AlaynAI] Response successfully generated via Groq (Zero-Training Privacy)');
            logUsage(data?.usage, { model, outletId, topics: reply.topics, messages: reply.messages, streamed: false });
            return text.trim();
          }
        } catch (err: any) {
          logger.error({ model, err: err?.message || err }, '[AlaynAI] Network error calling Groq model');
        }
      }
    }

    // ── Tier 2: Deterministic Rule-Based Telemetry Fallback ──
    // Deliberately no other AI provider here: café data only leaves the server through Groq, which
    // contractually never trains on it. If Groq is down or rate-limited, owners get answers built
    // from their own data on this server instead.
    logger.warn('[AlaynAI] Groq unavailable or not configured. Executing Rule-Based Telemetry Analytics Fallback.');
    return this.generateRuleBasedFallback(prompt, reply.dbContext, reply.forecastContext);
  }

  /**
   * Same answer, streamed: first the data sections checked, then the text as Groq writes it. If no
   * model can start, the built-in answer is sent instead. Stops quietly when the owner presses Stop.
   */
  async streamAssistant(
    prompt: string,
    outletId: string | undefined,
    businessId: string | undefined,
    history: ChatTurn[],
    emit: (event: StreamEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    logger.info({ outletId, prompt }, '[AlaynAI] Incoming streaming request');
    const reply = await this.prepareReply(prompt, outletId, businessId, history);
    if ('rejection' in reply) {
      emit({ type: 'delta', text: reply.rejection });
      emit({ type: 'done', source: 'guardrail' });
      return;
    }
    emit({ type: 'topics', topics: [...reply.topics] });

    const groqKey = process.env.GROQ_API_KEY;
    if (groqKey) {
      for (const model of GROQ_MODELS) {
        let started = false;
        try {
          const res = await groqRequest(model, reply.messages, true, groqKey, signal);
          if (!res.ok || !res.body) {
            logger.warn({ model, status: res.status }, '[AlaynAI] Groq stream attempt failed, trying the next model');
            continue;
          }
          let usage: GroqUsage | undefined;
          for await (const text of groqDeltas(res.body as ReadableStream<Uint8Array>, (u) => (usage = u))) {
            started = true;
            emit({ type: 'delta', text });
          }
          if (started) {
            logger.info({ model, outletId }, '[AlaynAI] Streamed response via Groq');
            logUsage(usage, { model, outletId, topics: reply.topics, messages: reply.messages, streamed: true });
            emit({ type: 'done', source: 'groq' });
            return;
          }
        } catch (err: any) {
          if (signal.aborted) return;
          logger.error({ model, err: err?.message || err }, '[AlaynAI] Groq stream error');
          // Half an answer can't be continued by another model, so say it was cut off
          if (started) {
            emit({ type: 'error', message: 'The answer was cut off. Please ask again.' });
            return;
          }
        }
        if (signal.aborted) return;
      }
    }

    logger.warn('[AlaynAI] Groq unavailable for streaming. Sending the built-in answer.');
    emit({ type: 'delta', text: this.generateRuleBasedFallback(prompt, reply.dbContext, reply.forecastContext) });
    emit({ type: 'done', source: 'fallback' });
  }

  /**
   * High-reliability rule-based business logic fallback engine.
   * Synthesizes live restaurant database telemetry directly into clean executive analysis
   * when AI model APIs are unreachable, rate-limited, or offline.
   */
  private generateRuleBasedFallback(prompt: string, dbContext: string, forecastContext: string): string {
    const p = prompt.toLowerCase();

    // Extract metrics from dbContext. Anything missing is shown as unavailable, never as an example value.
    const NA = 'not available';
    const revMatch = dbContext.match(/MTD Net Revenue: ₹([0-9,.]+)/);
    const mtdRev = revMatch ? `₹${revMatch[1]}` : NA;

    const todayMatch = dbContext.match(/Today's Revenue: ₹([0-9,.]+)/);
    const todayRev = todayMatch ? `₹${todayMatch[1]}` : NA;

    const aovMatch = dbContext.match(/Average Ticket Value \(AOV\): ₹([0-9,.]+)/);
    const aov = aovMatch ? `₹${aovMatch[1]}` : NA;

    const staffMatch = dbContext.match(/Total Staff Count: (\d+) \((\d+) active/);
    const totalStaff = staffMatch ? staffMatch[1] : NA;
    const activeStaff = staffMatch ? staffMatch[2] : NA;

    const wasteMatch = dbContext.match(/Recorded Waste \(MTD\): ₹([0-9,.]+)/);
    const wasteCost = wasteMatch ? `₹${wasteMatch[1]}` : NA;

    const topItemsMatch = dbContext.match(/Top Selling Menu Items: ([^\n]+)/);
    const topItems = topItemsMatch ? topItemsMatch[1] : NA;

    const lowStockMatch = dbContext.match(/Low Stock Alerts: ([^\n]+)/);
    const lowStock = lowStockMatch ? lowStockMatch[1] : NA;

    // 1. REVENUE / FORECAST QUERIES
    if (p.includes('revenue') || p.includes('forecast') || p.includes('peak') || p.includes('sales') || p.includes('surge') || p.includes('weekend')) {
      return `### Sales & Forecast

**Current Sales Snapshot:**
- Today's Revenue: ${todayRev}
- Month-to-Date Revenue: ${mtdRev}
- Average Order Value (AOV): ${aov}

**Sales Forecast:**
${forecastContext.replace(/^- Sales Forecast, next 7 days \(before tax\): /m, '- Next 7 days (before tax): ').replace(/^- Sales Forecast: /m, '- ').replace(/ Do NOT estimate.*$/m, '').replace(/ EARLY ESTIMATE based on only (\d+) days of sales:.*$/m, ' This is an early estimate from only $1 days of sales, so treat it as rough.')}

**Recommendations:**
- Top sellers this month: ${topItems}.
- Prep more of your top sellers ahead of the busiest forecast days above.`;
    }

    // 2. INVENTORY / WASTE QUERIES
    if (p.includes('inventory') || p.includes('waste') || p.includes('spoilage') || p.includes('stock') || p.includes('losing') || p.includes('cost')) {
      return `### Stock & Waste

**Current Stock & Waste Metrics:**
- Month-to-Date Waste Cost: ${wasteCost}
- Low Stock Reorder Alerts: ${lowStock}

**Optimization Actions:**
- Reorder the low-stock items above before your next busy day.
- Use FIFO (first in, first out) rotation so older stock is used before it expires.
- Check the Waste Management page for which items are wasted most, and prep less of them.`;
    }

    // 3. WORKFORCE / STAFFING QUERIES
    if (p.includes('staff') || p.includes('roster') || p.includes('workforce') || p.includes('shift') || p.includes('schedule') || p.includes('tonight')) {
      return `### Staffing

**Current Staffing Overview:**
- Total Roster Count: ${totalStaff} employees
- Active Employees: ${activeStaff}

**Shift Roster Recommendations:**
- Check the Sales Velocity chart on the dashboard for your real busiest hours, and roster more staff for those.
- Ask "How will my sales look this week?" to see which days are forecast to be busiest.
- Stagger kitchen prep start times to avoid unnecessary overtime.`;
    }

    // 4. MENU / MARGIN QUERIES
    if (p.includes('menu') || p.includes('item') || p.includes('margin') || p.includes('dish') || p.includes('top') || p.includes('profit')) {
      return `### Menu Performance

**Top Selling Menu Items:**
- Bestsellers (Volume & Revenue): ${topItems}
- Average Order Value (AOV): ${aov}

**Menu Engineering Recommendations:**
- Put your bestsellers at the top of the POS and QR menus.
- Pair slower dishes with popular drinks or sides to lift the average order value.
- Review dishes that rarely sell and consider dropping them.`;
    }

    // 5. GENERAL RESTAURANT OVERVIEW (FALLBACK)
    return `### Business Summary

**Key Performance Indicators:**
- Today's Net Revenue: ${todayRev}
- Month-to-Date Net Revenue: ${mtdRev}
- Average Order Value: ${aov}
- Active Employees: ${activeStaff} / ${totalStaff}
- Recorded Spoilage / Waste: ${wasteCost}
- High-Volume Menu Items: ${topItems}
- Stock Reorder Alerts: ${lowStock}

**Next step:**
Ask about sales, next week's forecast, stock and waste, staff, or which dishes sell best for a more specific answer.`;
  }
}

export const aiService = new AiService();

