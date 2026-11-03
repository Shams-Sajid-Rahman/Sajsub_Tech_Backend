import { Router } from 'express';
import * as auth from '../controllers/auth.controller.js';
import { authenticate, optionalAuthenticate } from '../middleware/auth.middleware.js';
import { accountLimiter, loginLimiter } from '../middleware/rateLimit.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  updateProfileSchema,
} from '../validators/auth.validator.js';

const router = Router();

router.get('/csrf-token', auth.getCsrfToken);
router.get('/session', optionalAuthenticate, auth.getSession);

router.post('/register', accountLimiter, validate({ body: registerSchema }), auth.register);
router.post('/login', loginLimiter, validate({ body: loginSchema }), auth.customerLogin);
router.post('/refresh', auth.refresh);
router.post('/logout', auth.logout);
router.post('/forgot-password', accountLimiter, validate({ body: forgotPasswordSchema }), auth.forgotPassword);
router.post('/reset-password', accountLimiter, validate({ body: resetPasswordSchema }), auth.resetPassword);

router.get('/me', authenticate, auth.getMe);
router.patch('/me', authenticate, validate({ body: updateProfileSchema }), auth.updateMe);
router.post('/change-password', authenticate, loginLimiter, validate({ body: changePasswordSchema }), auth.changePassword);

export default router;
