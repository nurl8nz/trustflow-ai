import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message, { code, details, debugId } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.debugId = debugId;
  }
}

export const newId = (prefix, bytes = 6) => `${prefix}_${crypto.randomBytes(bytes).toString('hex')}`;
export const nowIso = () => new Date().toISOString();
export const clampText = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
export const clampBlock = (value, max) => String(value ?? '').trim().slice(0, max);

export function cleanList(value, maxItems, maxLength) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => clampText(item, maxLength)).filter(Boolean).slice(0, maxItems);
}

// Currencies supported by the PayPal REST APIs.
export const PAYPAL_CURRENCIES = new Set([
  'AUD', 'BRL', 'CAD', 'CNY', 'CZK', 'DKK', 'EUR', 'HKD', 'HUF', 'ILS', 'JPY', 'MYR',
  'MXN', 'TWD', 'NZD', 'NOK', 'PHP', 'PLN', 'GBP', 'SGD', 'SEK', 'CHF', 'THB', 'USD',
]);
const ZERO_DECIMAL = new Set(['HUF', 'JPY', 'TWD']);

// Money is stored as integer minor units (cents) to avoid floating point drift.
export const minorFactor = (currency) => (ZERO_DECIMAL.has(currency) ? 1 : 100);
export const toMinor = (amount, currency) => Math.round(Number(amount || 0) * minorFactor(currency));
export const fromMinor = (minor, currency) => minor / minorFactor(currency);
export const toPayPalValue = (minor, currency) =>
  ZERO_DECIMAL.has(currency) ? String(Math.round(minor)) : (minor / 100).toFixed(2);
export const formatMoney = (minor, currency) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: ZERO_DECIMAL.has(currency) ? 0 : 2,
  }).format(fromMinor(minor, currency));

/** Sliding-window limiter keyed by workspace. Protects the AI quota from abuse. */
export function createRateLimiter({ limit, windowMs }) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) return false;
    recent.push(now);
    hits.set(key, recent);
    return true;
  };
}

/** Stops a double click from creating two PayPal operations for the same milestone. */
const inflight = new Set();
export async function withLock(key, fn) {
  if (inflight.has(key)) {
    throw new HttpError(409, 'This step is already in progress. Wait a moment, then refresh.', { code: 'IN_PROGRESS' });
  }
  inflight.add(key);
  try {
    return await fn();
  } finally {
    inflight.delete(key);
  }
}

export function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export const isEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
