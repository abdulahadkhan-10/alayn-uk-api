import { Router } from 'express';
import { aiController } from './ai.controller';
import { authMiddleware } from '../../middleware/auth.middleware';
import { businessMiddleware } from '../../middleware/business.middleware';

const router = Router();

router.use(authMiddleware);

router.post('/assistant', businessMiddleware, aiController.queryAssistant);
router.post('/assistant/stream', businessMiddleware, aiController.streamAssistant);

// Saved conversations: each person only ever sees their own
router.get('/chats', businessMiddleware, aiController.listChats);
router.get('/chats/:id', businessMiddleware, aiController.getChat);
router.patch('/chats/:id', businessMiddleware, aiController.renameChat);
router.delete('/chats/:id', businessMiddleware, aiController.deleteChat);
router.delete('/chats', businessMiddleware, aiController.deleteAllChats);

export default router;
