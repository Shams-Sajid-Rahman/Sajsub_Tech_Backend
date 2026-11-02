import { env } from '../config/env.js';
import { handleBrowserCallback, handleIpn } from '../services/payments/payment.service.js';
import { sendSuccess } from '../utils/response.js';

// The customer's browser posts here on its way back from the payment page.
export const browserCallback = (kind) => async (req, res) => {
  const { orderId, result } = await handleBrowserCallback(kind, req.validated.body);
  const path = orderId ? `/orders/${orderId}?payment=${result}` : '/orders';
  res.redirect(303, `${env.clientUrl}${path}`);
};

export const ipn = async (req, res) => {
  sendSuccess(res, { outcome: await handleIpn(req.validated.body) });
};
