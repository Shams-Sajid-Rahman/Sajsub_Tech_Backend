import express, { Router } from 'express';
import { browserCallback, ipn } from '../controllers/payment.controller.js';
import { createRateLimiter } from '../middleware/rateLimit.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import { paymentCallbackSchema } from '../validators/store.validator.js';

// These come from the payment provider, which has no session or CSRF token, so they are mounted
// ahead of the CSRF check. Nothing posted here is trusted: see payment.service.js.
const router = Router();
const body = validate({ body: paymentCallbackSchema });

router.use(createRateLimiter({ max: 600 }));
router.use(express.urlencoded({ extended: false, limit: '100kb' }));

router.post('/success', body, browserCallback('success'));
router.post('/fail', body, browserCallback('fail'));
router.post('/cancel', body, browserCallback('cancel'));
router.post('/ipn', body, ipn);

export default router;
