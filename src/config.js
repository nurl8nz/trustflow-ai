import path from 'node:path';
import { ROOT_DIR } from './env.js';

const env = process.env;
const clean = (value) => (value ?? '').trim();
const isLive = clean(env.PAYPAL_ENV).toLowerCase() === 'live';

export const config = Object.freeze({
  port: Number(env.PORT) || 3000,
  publicUrl: clean(env.PUBLIC_URL).replace(/\/$/, ''),
  dataFile: clean(env.DATA_FILE) || path.join(ROOT_DIR, 'data', 'db.json'),
  publicDir: path.join(ROOT_DIR, 'public'),
  paypal: Object.freeze({
    env: isLive ? 'live' : 'sandbox',
    clientId: clean(env.PAYPAL_CLIENT_ID),
    clientSecret: clean(env.PAYPAL_CLIENT_SECRET),
    webhookId: clean(env.PAYPAL_WEBHOOK_ID),
    apiBase: clean(env.PAYPAL_API_BASE) || (isLive ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com'),
    webBase: isLive ? 'https://www.paypal.com' : 'https://www.sandbox.paypal.com',
    sdkUrl: isLive ? 'https://www.paypal.com/web-sdk/v6/core' : 'https://www.sandbox.paypal.com/web-sdk/v6/core',
    brandName: 'TrustFlow AI',
  }),
  gemini: Object.freeze({
    apiKey: clean(env.GEMINI_API_KEY),
    model: clean(env.GEMINI_MODEL) || 'gemini-3.5-flash-lite',
    apiBase: clean(env.GEMINI_API_BASE) || 'https://generativelanguage.googleapis.com',
  }),
  demo: Object.freeze({
    // Optional: a sandbox buyer email to prefill as the invoice recipient.
    clientEmail: clean(env.DEMO_CLIENT_EMAIL),
  }),
  limits: Object.freeze({
    aiCallsPerHour: Number(env.AI_CALLS_PER_HOUR) || 60,
    agreementsPerWorkspace: 25,
  }),
});

export function readiness() {
  return {
    paypal: Boolean(config.paypal.clientId && config.paypal.clientSecret),
    ai: Boolean(config.gemini.apiKey),
    webhooks: Boolean(config.paypal.webhookId),
  };
}