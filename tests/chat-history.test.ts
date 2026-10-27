import { prisma } from '../src/config/prisma';
import {
  deleteChat,
  finishTurn,
  getChat,
  listChats,
  outletKeyOf,
  purgeExpiredChats,
  startTurn,
} from '../src/modules/ai/chatHistory';
import { aiController } from '../src/modules/ai/ai.controller';
import { aiService } from '../src/modules/ai/ai.service';

jest.mock('../src/config/prisma', () => ({
  prisma: {
    aiChat: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn((a) => a), updateMany: jest.fn(), deleteMany: jest.fn() },
    aiChatMessage: { create: jest.fn((a) => a), deleteMany: jest.fn() },
    $transaction: jest.fn((ops) => Promise.resolve(ops)),
  },
}));

const NOW = new Date('2026-10-17T10:00:00Z');
const THIRTY_DAYS_AGO = new Date('2026-09-17T10:00:00Z');
const msg = (id: string, role: string, content: string, status = 'done') => ({ id, role, content, status });

beforeEach(() => jest.clearAllMocks());

describe('Saved Alayn AI chats', () => {
  it('lists only the person’s own chats for this outlet from the last 30 days', async () => {
    (prisma.aiChat.findMany as jest.Mock).mockResolvedValue([]);
    await listChats('user-1', 'outlet-1', NOW);
    expect((prisma.aiChat.findMany as jest.Mock).mock.calls[0][0].where).toEqual({
      userId: 'user-1',
      outletKey: 'outlet-1',
      updatedAt: { gte: THIRTY_DAYS_AGO },
    });
  });

  it('files all-outlets chats under "all"', () => {
    expect(outletKeyOf('all')).toBe('all');
    expect(outletKeyOf(undefined)).toBe('all');
    expect(outletKeyOf('outlet-1')).toBe('outlet-1');
  });

  it('cannot open someone else’s chat (or an expired one)', async () => {
    (prisma.aiChat.findFirst as jest.Mock).mockResolvedValue(null);
    await expect(getChat('user-2', 'chat-of-user-1', NOW)).rejects.toMatchObject({ statusCode: 404 });
    expect((prisma.aiChat.findFirst as jest.Mock).mock.calls[0][0].where).toEqual({
      id: 'chat-of-user-1',
      userId: 'user-2',
      updatedAt: { gte: THIRTY_DAYS_AGO },
    });
  });

  it('cannot delete someone else’s chat', async () => {
    (prisma.aiChat.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
    await expect(deleteChat('user-2', 'chat-of-user-1')).rejects.toMatchObject({ statusCode: 404 });
    expect((prisma.aiChat.deleteMany as jest.Mock).mock.calls[0][0].where).toEqual({ id: 'chat-of-user-1', userId: 'user-2' });
  });

  it('starts a new chat titled from the question', async () => {
    (prisma.aiChat.create as jest.Mock).mockResolvedValue({ id: 'chat-1', title: 'How were sales?' });
    const turn = await startTurn({ userId: 'user-1', businessId: 'biz-1', outletKey: 'outlet-1', prompt: '  How were\nsales?  ', now: NOW });
    expect(turn).toEqual({ chatId: 'chat-1', title: 'How were sales?', history: [] });
    expect((prisma.aiChat.create as jest.Mock).mock.calls[0][0].data).toMatchObject({ userId: 'user-1', outletKey: 'outlet-1', title: 'How were sales?' });
    expect((prisma.aiChatMessage.create as jest.Mock).mock.calls[0][0].data).toEqual({ chatId: 'chat-1', role: 'user', content: '  How were\nsales?  ' });
  });

  it('sends the last 3 finished exchanges of a saved chat, skipping stopped answers', async () => {
    (prisma.aiChat.findFirst as jest.Mock).mockResolvedValue({
      id: 'chat-1',
      title: 'Sales',
      messages: [
        msg('1', 'user', 'q1'), msg('2', 'assistant', 'a1'),
        msg('3', 'user', 'q2'), msg('4', 'assistant', 'a2'),
        msg('5', 'user', 'q3'), msg('6', 'assistant', 'half', 'stopped'),
        msg('7', 'user', 'q4'), msg('8', 'assistant', 'a4'),
        msg('9', 'user', 'q5'), msg('10', 'assistant', 'a5'),
      ],
    });
    const turn = await startTurn({ userId: 'user-1', outletKey: 'outlet-1', chatId: 'chat-1', prompt: 'and Sunday?', now: NOW });
    expect(turn.history.map((t) => t.content)).toEqual(['q2', 'a2', 'q4', 'a4', 'q5', 'a5']);
  });

  it('"Ask again" replaces the last question and its answer', async () => {
    (prisma.aiChat.findFirst as jest.Mock).mockResolvedValue({
      id: 'chat-1',
      title: 'Sales',
      messages: [msg('1', 'user', 'q1'), msg('2', 'assistant', 'a1'), msg('3', 'user', 'q2'), msg('4', 'assistant', 'bad answer')],
    });
    const turn = await startTurn({ userId: 'user-1', outletKey: 'outlet-1', chatId: 'chat-1', prompt: 'q2', retry: true, now: NOW });
    expect((prisma.aiChatMessage.deleteMany as jest.Mock).mock.calls[0][0].where).toEqual({ id: { in: ['3', '4'] } });
    expect(turn.history.map((t) => t.content)).toEqual(['q1', 'a1']);
  });

  it('continuing someone else’s chat is refused', async () => {
    (prisma.aiChat.findFirst as jest.Mock).mockResolvedValue(null);
    await expect(startTurn({ userId: 'user-2', outletKey: 'outlet-1', chatId: 'chat-of-user-1', prompt: 'q', now: NOW })).rejects.toMatchObject({ statusCode: 404 });
    expect(prisma.aiChatMessage.create).not.toHaveBeenCalled();
  });

  it('saves the answer and keeps the chat for another 30 days', async () => {
    await finishTurn('chat-1', 'Sales were ₹12,400.', ['sales'], 'done');
    expect((prisma.aiChatMessage.create as jest.Mock).mock.calls[0][0].data).toEqual({
      chatId: 'chat-1', role: 'assistant', content: 'Sales were ₹12,400.', topics: '["sales"]', status: 'done',
    });
    expect((prisma.aiChat.update as jest.Mock).mock.calls[0][0].where).toEqual({ id: 'chat-1' });
  });

  it('deletes chats with no message in 30 days', async () => {
    (prisma.aiChat.deleteMany as jest.Mock).mockResolvedValue({ count: 4 });
    expect(await purgeExpiredChats(NOW)).toBe(4);
    expect((prisma.aiChat.deleteMany as jest.Mock).mock.calls[0][0].where).toEqual({ updatedAt: { lt: THIRTY_DAYS_AGO } });
  });
});

describe('Streaming saves the conversation', () => {
  function fakeRes() {
    const writes: string[] = [];
    const handlers: Record<string, () => void> = {};
    return {
      writes,
      handlers,
      writableEnded: false,
      writeHead: jest.fn(),
      flushHeaders: jest.fn(),
      write: jest.fn((s: string) => writes.push(s)),
      on: jest.fn((ev: string, fn: () => void) => (handlers[ev] = fn)),
      end: jest.fn(function (this: any) { this.writableEnded = true; }),
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
  }
  const req = (body: object) => ({ body, headers: {}, outletId: 'outlet-1', businessId: 'biz-1', user: { id: 'user-1' } }) as any;

  afterEach(() => jest.restoreAllMocks());

  it('tells the page which chat it is, then saves the full answer', async () => {
    (prisma.aiChat.create as jest.Mock).mockResolvedValue({ id: 'chat-1', title: 'How were sales?' });
    jest.spyOn(aiService, 'streamAssistant').mockImplementation(async (_p, _o, _b, _h, emit) => {
      emit({ type: 'topics', topics: ['sales'] });
      emit({ type: 'delta', text: 'Sales were ' });
      emit({ type: 'delta', text: '₹12,400.' });
      emit({ type: 'done', source: 'groq' });
    });
    const res = fakeRes();
    await aiController.streamAssistant(req({ prompt: 'How were sales?' }), res as any, jest.fn());

    expect(res.writes[0]).toContain('"type":"chat","chatId":"chat-1"');
    const saved = (prisma.aiChatMessage.create as jest.Mock).mock.calls.map(([a]) => a.data);
    expect(saved[1]).toMatchObject({ role: 'assistant', content: 'Sales were ₹12,400.', topics: '["sales"]', status: 'done' });
  });

  it('saves what was written so far as "stopped" when the owner presses Stop', async () => {
    (prisma.aiChat.create as jest.Mock).mockResolvedValue({ id: 'chat-1', title: 'q' });
    const res = fakeRes();
    jest.spyOn(aiService, 'streamAssistant').mockImplementation(async (_p, _o, _b, _h, emit) => {
      emit({ type: 'delta', text: 'Half an ' });
      res.handlers.close(); // the page closed the connection
    });
    await aiController.streamAssistant(req({ prompt: 'q' }), res as any, jest.fn());
    const saved = (prisma.aiChatMessage.create as jest.Mock).mock.calls.map(([a]) => a.data);
    expect(saved[1]).toMatchObject({ content: 'Half an ', status: 'stopped' });
  });

  it('refuses to continue a chat that is not theirs, before streaming starts', async () => {
    (prisma.aiChat.findFirst as jest.Mock).mockResolvedValue(null);
    const res = fakeRes();
    const next = jest.fn();
    await aiController.streamAssistant(req({ prompt: 'q', chatId: '7b0c6a43-1f2a-4c1e-9d63-2a1b3c4d5e6f' }), res as any, next);
    expect(res.writeHead).not.toHaveBeenCalled();
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 404 });
  });
});

describe('Alayn AI only ever uses the outlet the access check approved', () => {
  // businessMiddleware sets req.outletId after checking access; the raw header and body are not trusted
  const req = (body: object, extra: object = {}) =>
    ({
      body: { ...body, outletId: 'o-body' },
      query: { outletId: 'o-query' },
      headers: { 'x-outlet-id': 'o-other' },
      outletId: 'o-own',
      businessId: 'biz-1',
      user: { id: 'user-1', role: 'BUSINESS_OWNER' },
      ...extra,
    }) as any;
  const res = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() }) as any;

  afterEach(() => jest.restoreAllMocks());

  it('answers for the checked outlet, not the x-outlet-id header', async () => {
    const spy = jest.spyOn(aiService, 'queryAssistant').mockResolvedValue('ok');
    await aiController.queryAssistant(req({ prompt: 'How were sales?', save: false }), res(), jest.fn());
    expect(spy.mock.calls[0][1]).toBe('o-own');
  });

  it('streams for the checked outlet, not the x-outlet-id header', async () => {
    const spy = jest.spyOn(aiService, 'streamAssistant').mockResolvedValue();
    const r = { writableEnded: false, writeHead: jest.fn(), flushHeaders: jest.fn(), write: jest.fn(), on: jest.fn(), end: jest.fn() } as any;
    await aiController.streamAssistant(req({ prompt: 'q', save: false }), r, jest.fn());
    expect(spy.mock.calls[0][1]).toBe('o-own');
  });

  it('files a new chat under the checked outlet', async () => {
    jest.spyOn(aiService, 'queryAssistant').mockResolvedValue('ok');
    (prisma.aiChat.create as jest.Mock).mockResolvedValue({ id: 'chat-1', title: 'q' });
    await aiController.queryAssistant(req({ prompt: 'q' }), res(), jest.fn());
    expect((prisma.aiChat.create as jest.Mock).mock.calls[0][0].data).toMatchObject({ outletKey: 'o-own' });
  });

  it('lists chats for the checked outlet only', async () => {
    (prisma.aiChat.findMany as jest.Mock).mockResolvedValue([]);
    await aiController.listChats(req({}), res(), jest.fn());
    expect((prisma.aiChat.findMany as jest.Mock).mock.calls[0][0].where).toMatchObject({ outletKey: 'o-own' });
  });

  it('passes the person’s role on, so report figures can be limited to managers', async () => {
    const q = jest.spyOn(aiService, 'queryAssistant').mockResolvedValue('ok');
    await aiController.queryAssistant(req({ prompt: 'q', save: false }, { user: { id: 'u', role: 'STAFF' } }), res(), jest.fn());
    expect((q.mock.calls[0] as unknown[])[4]).toBe('STAFF');
    const s = jest.spyOn(aiService, 'streamAssistant').mockResolvedValue();
    const r = { writableEnded: false, writeHead: jest.fn(), flushHeaders: jest.fn(), write: jest.fn(), on: jest.fn(), end: jest.fn() } as any;
    await aiController.streamAssistant(req({ prompt: 'q', save: false }, { user: { id: 'u', role: 'STAFF' } }), r, jest.fn());
    expect((s.mock.calls[0] as unknown[])[6]).toBe('STAFF');
  });
});
