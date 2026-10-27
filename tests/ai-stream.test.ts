import { aiService, groqDeltas, StreamEvent } from '../src/modules/ai/ai.service';

jest.mock('../src/config/prisma', () => ({ prisma: {} }));

/** A web stream that sends the given SSE text in chunks (split mid-line, as networks do). */
function sseBody(lines: string[], chunkSize = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(lines.join('\n') + '\n');
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}
const chunk = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`;

describe('Reading a Groq stream', () => {
  it('yields only the answer text, across chunk boundaries, until [DONE]', async () => {
    const body = sseBody([
      chunk('Sales '),
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning: 'hidden thinking' } }] })}`,
      ': keep-alive comment',
      chunk('were ₹12,400.'),
      'data: not json',
      'data: [DONE]',
      chunk('never read'),
    ]);
    const parts: string[] = [];
    for await (const t of groqDeltas(body)) parts.push(t);
    expect(parts).toEqual(['Sales ', 'were ₹12,400.']);
  });

  it('reports the token usage Groq sends in the last chunk', async () => {
    const usage = { prompt_tokens: 2100, completion_tokens: 180, total_tokens: 2280 };
    const body = sseBody([chunk('Hi'), `data: ${JSON.stringify({ choices: [{ delta: {} }], x_groq: { usage } })}`, 'data: [DONE]']);
    const seen: unknown[] = [];
    for await (const _ of groqDeltas(body, (u) => seen.push(u))) void _;
    expect(seen).toEqual([usage]);
  });
});

describe('Streaming AlaynAI answers', () => {
  const prepared = {
    messages: [{ role: 'user' as const, content: 'How were sales?' }],
    topics: new Set(['sales' as const]),
    dbContext: 'ctx',
    forecastContext: 'forecast',
  };
  let events: StreamEvent[];
  const emit = (e: StreamEvent) => events.push(e);
  const originalFetch = global.fetch;

  beforeEach(() => {
    events = [];
    process.env.GROQ_API_KEY = 'test-key';
    jest.spyOn(aiService as any, 'prepareReply').mockResolvedValue(prepared);
    jest.spyOn(aiService as any, 'generateRuleBasedFallback').mockReturnValue('Built-in answer');
  });
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('sends the data checked first, then the text, then done', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, body: sseBody([chunk('Hello'), chunk(' there'), 'data: [DONE]']) }) as any;
    await aiService.streamAssistant('How were sales?', 'o1', 'b1', [], emit, new AbortController().signal);
    expect(events).toEqual([
      { type: 'topics', topics: ['sales'] },
      { type: 'delta', text: 'Hello' },
      { type: 'delta', text: ' there' },
      { type: 'done', source: 'groq' },
    ]);
    expect(JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body).stream).toBe(true);
  });

  it('tries the next model when one is rate-limited', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429, body: null })
      .mockResolvedValueOnce({ ok: true, body: sseBody([chunk('From model 2'), 'data: [DONE]']) }) as any;
    await aiService.streamAssistant('q', 'o1', 'b1', [], emit, new AbortController().signal);
    expect(events.map((e) => e.type)).toEqual(['topics', 'delta', 'done']);
    expect(JSON.parse((global.fetch as jest.Mock).mock.calls[1][1].body).model).toBe('openai/gpt-oss-20b');
  });

  it('sends the built-in answer when no model can start', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network down')) as any;
    await aiService.streamAssistant('q', 'o1', 'b1', [], emit, new AbortController().signal);
    expect(events.slice(1)).toEqual([
      { type: 'delta', text: 'Built-in answer' },
      { type: 'done', source: 'fallback' },
    ]);
  });

  it('says the answer was cut off if the stream breaks part way', async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(chunk('Half an ') + '\n'));
      },
      pull(controller) {
        controller.error(new Error('connection reset'));
      },
    });
    global.fetch = jest.fn().mockResolvedValue({ ok: true, body: broken }) as any;
    await aiService.streamAssistant('q', 'o1', 'b1', [], emit, new AbortController().signal);
    expect(events.map((e) => e.type)).toEqual(['topics', 'delta', 'error']);
    expect(global.fetch).toHaveBeenCalledTimes(1); // no second model mixed into the same answer
  });

  it('stops quietly when the owner presses Stop', async () => {
    const abort = new AbortController();
    global.fetch = jest.fn().mockImplementation(() => {
      abort.abort();
      return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    }) as any;
    await aiService.streamAssistant('q', 'o1', 'b1', [], emit, abort.signal);
    expect(events.map((e) => e.type)).toEqual(['topics']);
  });

  it('answers off-topic questions with the rejection, without calling Groq', async () => {
    (aiService as any).prepareReply.mockResolvedValue({ rejection: 'I am AlaynAI...' });
    global.fetch = jest.fn() as any;
    await aiService.streamAssistant('write python', 'o1', 'b1', [], emit, new AbortController().signal);
    expect(events).toEqual([
      { type: 'delta', text: 'I am AlaynAI...' },
      { type: 'done', source: 'guardrail' },
    ]);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
