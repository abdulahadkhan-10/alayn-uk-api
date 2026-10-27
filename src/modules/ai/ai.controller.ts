import { Request, Response, NextFunction } from 'express';
import { aiService, ChatTurn, StreamEvent } from './ai.service';
import { logger } from '../../config/logger';
import { sendSuccess, sendError } from '../../utils/response';
import {
  AnswerStatus,
  deleteAllChats,
  deleteChat,
  finishTurn,
  getChat,
  listChats,
  outletKeyOf,
  renameChat,
  startTurn,
} from './chatHistory';

// Enough for "and what about Sunday?" without sending whole conversations to the model
const MAX_HISTORY_TURNS = 6;
const MAX_TURN_CHARS = 4000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Earlier messages of this conversation, kept only if well-formed; anything else is dropped. */
function parseHistory(raw: unknown): ChatTurn[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (t): t is ChatTurn =>
        !!t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string' && t.content.trim() !== '',
    )
    .slice(-MAX_HISTORY_TURNS)
    .map((t) => ({ role: t.role, content: t.content.slice(0, MAX_TURN_CHARS) }));
}

// Only the outlet businessMiddleware checked. The raw x-outlet-id header, query or body are never
// trusted here: for supplier accounts the middleware ignores them, so they could name any outlet.
const outletOf = (req: Request) => req.outletId;

/**
 * Saves the question to the person's chat (a new one unless `chatId` names one of theirs) and returns
 * the history to send with it. Saved chats use their own stored history; `history` in the body only
 * counts when saving is switched off (`save: false`).
 */
async function beginTurn(req: Request, prompt: string) {
  const { chatId, retry, save } = req.body ?? {};
  if (save === false || !req.user) return { chatId: null, title: null, history: parseHistory(req.body?.history) };
  if (chatId !== undefined && chatId !== null && (typeof chatId !== 'string' || !UUID.test(chatId))) {
    return { error: 'This conversation was not found.' as const };
  }
  return startTurn({
    userId: req.user.id,
    businessId: req.businessId,
    outletKey: outletKeyOf(outletOf(req)),
    chatId: chatId || null,
    prompt: prompt.slice(0, MAX_TURN_CHARS),
    retry: retry === true,
  });
}

export class AiController {
  queryAssistant = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { prompt } = req.body;
      if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
        return sendError(res, 'INVALID_INPUT', 'Please provide a valid prompt for AlaynAI.', 400);
      }
      const turn = await beginTurn(req, prompt.trim());
      if ('error' in turn) return sendError(res, 'CHAT_NOT_FOUND', turn.error!, 404);

      const answer = await aiService.queryAssistant(prompt.trim(), outletOf(req), req.businessId, turn.history, req.user?.role);
      if (turn.chatId) await finishTurn(turn.chatId, answer, [], 'done');

      return sendSuccess(res, { answer, chatId: turn.chatId, title: turn.title });
    } catch (error) {
      next(error);
    }
  };

  /** Same as queryAssistant, but streams the answer as server-sent events (see StreamEvent). */
  streamAssistant = async (req: Request, res: Response, next: NextFunction) => {
    const { prompt } = req.body;
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return sendError(res, 'INVALID_INPUT', 'Please provide a valid prompt for AlaynAI.', 400);
    }
    // Saved before streaming starts, so a missing or someone else's chat is a plain 404
    let turn: Awaited<ReturnType<typeof beginTurn>>;
    try {
      turn = await beginTurn(req, prompt.trim());
    } catch (error) {
      return next(error);
    }
    if ('error' in turn) return sendError(res, 'CHAT_NOT_FOUND', turn.error!, 404);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // nginx would otherwise hold the answer back until it's finished
    });
    res.flushHeaders();

    // The owner pressed Stop or closed the page: stop asking Groq for more
    const abort = new AbortController();
    res.on('close', () => abort.abort());

    // What gets saved: the answer as far as it got, the sections checked, and how it ended
    let answer = '';
    let topics: string[] = [];
    let status: AnswerStatus = 'done';
    const emit = (event: StreamEvent) => {
      if (event.type === 'delta') answer += event.text;
      else if (event.type === 'topics') topics = event.topics;
      else if (event.type === 'error') status = 'error';
      if (!res.writableEnded) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    if (turn.chatId) emit({ type: 'chat', chatId: turn.chatId, title: turn.title! });
    try {
      await aiService.streamAssistant(prompt.trim(), outletOf(req), req.businessId, turn.history, emit, abort.signal, req.user?.role);
    } catch (error) {
      logger.error({ err: (error as Error)?.message || error }, '[AlaynAI] Streaming request failed');
      emit({ type: 'error', message: 'Alayn AI could not answer just now. Please try again.' });
    } finally {
      if (abort.signal.aborted && status === 'done') status = 'stopped';
      if (turn.chatId) {
        await finishTurn(turn.chatId, answer, topics, status).catch((err) =>
          logger.error({ err: err?.message || err }, '[AlaynAI] Could not save the answer'),
        );
      }
      res.end();
    }
  };

  /** The signed-in person's own chats for the current outlet (last 30 days). */
  listChats = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const chats = await listChats(req.user!.id, outletKeyOf(outletOf(req)));
      return sendSuccess(res, { chats });
    } catch (error) {
      next(error);
    }
  };

  getChat = async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!UUID.test(req.params.id)) return sendError(res, 'CHAT_NOT_FOUND', 'This conversation was not found.', 404);
      return sendSuccess(res, await getChat(req.user!.id, req.params.id));
    } catch (error) {
      next(error);
    }
  };

  renameChat = async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!UUID.test(req.params.id)) return sendError(res, 'CHAT_NOT_FOUND', 'This conversation was not found.', 404);
      if (typeof req.body?.title !== 'string') return sendError(res, 'INVALID_INPUT', 'Please give the conversation a name.', 400);
      return sendSuccess(res, await renameChat(req.user!.id, req.params.id, req.body.title));
    } catch (error) {
      next(error);
    }
  };

  deleteChat = async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!UUID.test(req.params.id)) return sendError(res, 'CHAT_NOT_FOUND', 'This conversation was not found.', 404);
      await deleteChat(req.user!.id, req.params.id);
      return sendSuccess(res, { deleted: 1 });
    } catch (error) {
      next(error);
    }
  };

  deleteAllChats = async (req: Request, res: Response, next: NextFunction) => {
    try {
      return sendSuccess(res, await deleteAllChats(req.user!.id));
    } catch (error) {
      next(error);
    }
  };
}

export const aiController = new AiController();
