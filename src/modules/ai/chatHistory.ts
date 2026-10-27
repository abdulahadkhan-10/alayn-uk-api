/*
 * Saved Alayn AI conversations. Each chat is private to the person who asked (nobody else, not even
 * the business owner, can list or open it) and is deleted 30 days after its last message.
 */
import { prisma } from '../../config/prisma';
import { logger } from '../../config/logger';
import { AppError } from '../../utils/AppError';
import { isAllOutlets } from '../../utils/tenantScope';
import { ONE_DAY_MS } from '../../utils/outletTime';
import type { ChatTurn } from './ai.service';

export const CHAT_RETENTION_DAYS = 30;
/** Earlier exchanges sent to the model with a new question, so "and Sunday?" makes sense */
const HISTORY_EXCHANGES = 3;
const TITLE_LENGTH = 60;
const LIST_LIMIT = 100;

export type AnswerStatus = 'done' | 'stopped' | 'error';

const cutoff = (now: Date) => new Date(now.getTime() - CHAT_RETENTION_DAYS * ONE_DAY_MS);
/** Chats belong to the outlet they were about, or to the all-outlets view */
export const outletKeyOf = (outletId?: string | null) => (isAllOutlets(outletId) ? 'all' : outletId!);

function titleFrom(prompt: string) {
  const oneLine = prompt.replace(/\s+/g, ' ').trim();
  return oneLine.length > TITLE_LENGTH ? `${oneLine.slice(0, TITLE_LENGTH - 1)}…` : oneLine;
}

const parseTopics = (raw: string): string[] => {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((t) => typeof t === 'string') : [];
  } catch {
    return [];
  }
};

/** The person's chats for this outlet from the last 30 days, newest first. */
export async function listChats(userId: string, outletKey: string, now = new Date()) {
  return prisma.aiChat.findMany({
    where: { userId, outletKey, updatedAt: { gte: cutoff(now) } },
    select: { id: true, title: true, updatedAt: true },
    orderBy: { updatedAt: 'desc' },
    take: LIST_LIMIT,
  });
}

/** One of the person's own chats with its messages, or a 404 (also for someone else's chat). */
export async function getChat(userId: string, chatId: string, now = new Date()) {
  const chat = await prisma.aiChat.findFirst({
    where: { id: chatId, userId, updatedAt: { gte: cutoff(now) } },
    select: {
      id: true,
      title: true,
      outletKey: true,
      updatedAt: true,
      messages: { orderBy: { createdAt: 'asc' }, select: { id: true, role: true, content: true, topics: true, status: true, createdAt: true } },
    },
  });
  if (!chat) throw new AppError('CHAT_NOT_FOUND', 'This conversation was not found. It may have been deleted.', 404);
  return { ...chat, messages: chat.messages.map((m) => ({ ...m, topics: parseTopics(m.topics) })) };
}

export async function renameChat(userId: string, chatId: string, title: string) {
  const clean = titleFrom(title);
  if (!clean) throw new AppError('INVALID_INPUT', 'Please give the conversation a name.', 400);
  const { count } = await prisma.aiChat.updateMany({ where: { id: chatId, userId }, data: { title: clean } });
  if (!count) throw new AppError('CHAT_NOT_FOUND', 'This conversation was not found.', 404);
  return { id: chatId, title: clean };
}

export async function deleteChat(userId: string, chatId: string) {
  const { count } = await prisma.aiChat.deleteMany({ where: { id: chatId, userId } });
  if (!count) throw new AppError('CHAT_NOT_FOUND', 'This conversation was not found.', 404);
}

/** Deletes all of the person's chats (for every outlet). */
export async function deleteAllChats(userId: string) {
  const { count } = await prisma.aiChat.deleteMany({ where: { userId } });
  return { deleted: count };
}

/**
 * Records a new question. Continues the given chat (it must be the person's own) or starts one, and
 * returns the earlier exchanges to send with it. `retry` replaces the last question and its answer.
 */
export async function startTurn(opts: {
  userId: string;
  businessId?: string | null;
  outletKey: string;
  chatId?: string | null;
  prompt: string;
  retry?: boolean;
  now?: Date;
}): Promise<{ chatId: string; title: string; history: ChatTurn[] }> {
  const now = opts.now ?? new Date();
  let chat: { id: string; title: string };
  let history: ChatTurn[] = [];

  if (opts.chatId) {
    const found = await prisma.aiChat.findFirst({
      where: { id: opts.chatId, userId: opts.userId, updatedAt: { gte: cutoff(now) } },
      select: { id: true, title: true, messages: { orderBy: { createdAt: 'asc' }, select: { id: true, role: true, content: true, status: true } } },
    });
    if (!found) throw new AppError('CHAT_NOT_FOUND', 'This conversation was not found. It may have been deleted.', 404);
    let messages = found.messages;

    if (opts.retry && messages.length) {
      // Drop the last question and its answer (if any); the question is asked again below
      const lastUser = messages.map((m) => m.role).lastIndexOf('user');
      if (lastUser >= 0) {
        await prisma.aiChatMessage.deleteMany({ where: { id: { in: messages.slice(lastUser).map((m) => m.id) } } });
        messages = messages.slice(0, lastUser);
      }
    }

    // Finished exchanges only: a stopped or failed answer isn't something to build on
    const pairs: ChatTurn[][] = [];
    for (let i = 0; i < messages.length - 1; i++) {
      const [q, a] = [messages[i], messages[i + 1]];
      if (q.role === 'user' && a.role === 'assistant' && a.status === 'done' && a.content.trim()) {
        pairs.push([
          { role: 'user', content: q.content },
          { role: 'assistant', content: a.content },
        ]);
      }
    }
    history = pairs.slice(-HISTORY_EXCHANGES).flat();
    chat = found;
  } else {
    chat = await prisma.aiChat.create({
      data: { userId: opts.userId, businessId: opts.businessId ?? null, outletKey: opts.outletKey, title: titleFrom(opts.prompt) },
      select: { id: true, title: true },
    });
  }

  await prisma.aiChatMessage.create({ data: { chatId: chat.id, role: 'user', content: opts.prompt } });
  return { chatId: chat.id, title: chat.title, history };
}

/** Records the answer (also a stopped or failed one, so the chat reads correctly when reopened). */
export async function finishTurn(chatId: string, answer: string, topics: string[], status: AnswerStatus) {
  await prisma.$transaction([
    prisma.aiChatMessage.create({
      data: { chatId, role: 'assistant', content: answer, topics: JSON.stringify(topics), status },
    }),
    // Keeps the chat for another 30 days and moves it to the top of the list
    prisma.aiChat.update({ where: { id: chatId }, data: { updatedAt: new Date() } }),
  ]);
}

/** Deletes chats with no message in the last 30 days. */
export async function purgeExpiredChats(now = new Date()) {
  const { count } = await prisma.aiChat.deleteMany({ where: { updatedAt: { lt: cutoff(now) } } });
  if (count) logger.info({ count }, '[AlaynAI] Deleted chats older than 30 days');
  return count;
}

/**
 * Runs the 30-day clean-up at start-up and every 6 hours. Lists and opens already hide older chats,
 * so a missed run never shows an expired chat; it only delays removing it from the database.
 */
export function scheduleChatCleanup() {
  const run = () => purgeExpiredChats().catch((err) => logger.error({ err: err?.message || err }, '[AlaynAI] Chat clean-up failed'));
  run();
  setInterval(run, 6 * 60 * 60 * 1000).unref();
}
