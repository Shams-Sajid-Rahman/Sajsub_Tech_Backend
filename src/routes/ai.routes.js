import { Router } from 'express';
import * as ai from '../controllers/ai.controller.js';
import { optionalAuthenticate } from '../middleware/auth.middleware.js';
import { createRateLimiter } from '../middleware/rateLimit.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import { idParamSchema } from '../validators/admin.validator.js';
import { aiMessageSchema } from '../validators/store.validator.js';

const router = Router();

// Each message costs money, so this is much tighter than the general API limit.
const messageLimiter = createRateLimiter({ max: 30 });

router.use(optionalAuthenticate);
router.post('/messages', messageLimiter, validate({ body: aiMessageSchema }), ai.sendMessage);
router.get('/conversations/:id', validate({ params: idParamSchema }), ai.getConversation);
router.delete('/conversations/:id', validate({ params: idParamSchema }), ai.deleteConversation);

export default router;
