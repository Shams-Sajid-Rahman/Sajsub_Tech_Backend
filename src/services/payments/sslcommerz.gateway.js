import { createHash, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';
import { ApiError } from '../../utils/ApiError.js';

const REQUEST_TIMEOUT_MS = 15000;
const SUCCESS_STATUSES = new Set(['VALID', 'VALIDATED']);

// Stored with each payment. Card numbers and everything else the provider sends are left out.
const STORED_FIELDS = [
  'status', 'tran_date', 'tran_id', 'val_id', 'amount', 'currency', 'currency_type', 'currency_amount',
  'bank_tran_id', 'card_type', 'card_brand', 'card_issuer_country', 'risk_level', 'risk_title',
];

const baseUrl = () => (env.sslcommerz.sandbox ? 'https://sandbox.sslcommerz.com' : 'https://securepay.sslcommerz.com');
const md5 = (text) => createHash('md5').update(text).digest('hex');

const credentials = () => ({ store_id: env.sslcommerz.storeId, store_passwd: env.sslcommerz.storePassword });

// The URLs contain the store password, so they are never logged or included in errors.
const requestJson = async (url, options) => {
  try {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    return await response.json();
  } catch {
    throw new ApiError(502, 'The payment provider could not be reached. Please try again.');
  }
};

const pickStoredFields = (data) =>
  Object.fromEntries(STORED_FIELDS.filter((field) => data[field] !== undefined).map((field) => [field, data[field]]));

// Kept as an object so tests can replace it and avoid real provider calls.
export const paymentGateway = {
  isConfigured: () => Boolean(env.sslcommerz.storeId && env.sslcommerz.storePassword),

  // Returns the hosted payment page the customer should be sent to.
  createSession: async (params) => {
    const data = await requestJson(`${baseUrl()}/gwprocess/v4/api.php`, {
      method: 'POST',
      body: new URLSearchParams({ ...credentials(), ...params }),
    });
    if (data.status !== 'SUCCESS' || !data.GatewayPageURL) {
      console.error('SSLCommerz refused to start a payment:', data.failedreason);
      throw new ApiError(502, 'The payment could not be started. Please try again.');
    }
    return { gatewayUrl: data.GatewayPageURL };
  },

  // The authoritative check: asks the provider directly whether this payment succeeded.
  validate: async (valId) => {
    const params = new URLSearchParams({ ...credentials(), val_id: valId, format: 'json' });
    const data = await requestJson(`${baseUrl()}/validator/api/validationserverAPI.php?${params}`);
    return {
      valid: SUCCESS_STATUSES.has(data.status),
      transactionRef: data.tran_id,
      // currency_type and currency_amount are what was sent to the provider. amount and currency
      // are the settlement values, which can differ when the store doesn't sell in BDT.
      amount: data.currency_amount ?? data.amount,
      currency: data.currency_type ?? data.currency,
      bankTransactionId: data.bank_tran_id,
      riskFlagged: String(data.risk_level) === '1',
      details: pickStoredFields(data),
    };
  },

  // Looks a payment up by our own reference, for when a notification never arrived.
  queryByTransaction: async (transactionRef) => {
    const params = new URLSearchParams({ ...credentials(), tran_id: transactionRef, format: 'json' });
    const data = await requestJson(`${baseUrl()}/validator/api/merchantTransIDvalidationAPI.php?${params}`);
    if (data.APIConnect !== 'DONE') throw new ApiError(502, 'The payment provider could not confirm this payment.');
    return (data.element ?? []).map(({ status, val_id: valId }) => ({ status, valId }));
  },

  // Signature on notifications: MD5 of the listed fields plus the hashed store password, sorted by name.
  verifySignature: (body) => {
    if (typeof body.verify_sign !== 'string' || typeof body.verify_key !== 'string') return false;
    const signed = Object.fromEntries(
      body.verify_key.split(',').filter((key) => body[key] !== undefined).map((key) => [key, body[key]]),
    );
    signed.store_passwd = md5(env.sslcommerz.storePassword ?? '');
    const text = Object.keys(signed).sort().map((key) => `${key}=${signed[key]}`).join('&');
    const expected = Buffer.from(md5(text));
    const actual = Buffer.from(body.verify_sign);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  },
};
