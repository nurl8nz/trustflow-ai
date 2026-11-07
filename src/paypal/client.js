import { config } from '../config.js';
import { HttpError } from '../util.js';

let cachedToken = null;

export class PayPalError extends HttpError {
  constructor(status, data) {
    const detail = data?.details?.[0];
    const issue = detail?.issue;
    const text = detail?.description || data?.message || data?.error_description || 'PayPal request failed.';
    const hint = HINTS[issue] || HINTS[data?.name] || (status === 401 || data?.error === 'invalid_client' ? HINTS.AUTH : '');
    super(status >= 500 ? 502 : status === 401 || status === 403 ? 502 : 422, hint ? `${text} ${hint}` : text, {
      code: issue || data?.name || data?.error || 'PAYPAL_ERROR',
      debugId: data?.debug_id,
      details: data?.details,
    });
    this.paypalStatus = status;
    this.paypalIssue = issue || data?.name;
  }
}

const HINTS = {
  AUTH: 'Check PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env (use the Sandbox app credentials).',
  NOT_AUTHORIZED: 'Enable this feature for your app in the PayPal Developer Dashboard (Apps & Credentials > your app > Features).',
  PERMISSION_DENIED: 'Enable Invoicing for your app in the PayPal Developer Dashboard (Apps & Credentials > your app > Features).',
  ORDER_NOT_APPROVED: 'The buyer has not approved this payment in PayPal yet.',
  AUTHORIZATION_EXPIRED: 'The hold expired. Ask the client to fund the milestone again.',
};

export function assertPayPalConfigured() {
  if (!config.paypal.clientId || !config.paypal.clientSecret) {
    throw new HttpError(503, 'PayPal is not configured. Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to .env and restart.', { code: 'PAYPAL_NOT_CONFIGURED' });
  }
}

async function getAccessToken({ force = false } = {}) {
  assertPayPalConfigured();
  if (!force && cachedToken && cachedToken.expiresAt - 60_000 > Date.now()) return cachedToken.value;
  const basic = Buffer.from(`${config.paypal.clientId}:${config.paypal.clientSecret}`).toString('base64');
  const response = await fetch(`${config.paypal.apiBase}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new PayPalError(response.status, data);
  cachedToken = { value: data.access_token, expiresAt: Date.now() + Number(data.expires_in || 300) * 1000 };
  return cachedToken.value;
}

/**
 * Calls the PayPal REST API. `requestId` becomes the PayPal-Request-Id header,
 * which makes retries idempotent: PayPal returns the original result instead
 * of creating a second order, capture or invoice.
 */
export async function paypalRequest(method, path, { body, requestId, prefer = 'return=representation' } = {}, retried = false) {
  const token = await getAccessToken({ force: retried });
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: prefer };
  if (requestId) headers['PayPal-Request-Id'] = requestId;
  let response;
  try {
    response = await fetch(`${config.paypal.apiBase}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new HttpError(502, `Could not reach PayPal (${error.name === 'TimeoutError' ? 'timed out' : error.message}). Try again.`, { code: 'PAYPAL_UNREACHABLE' });
  }
  if (response.status === 401 && !retried) return paypalRequest(method, path, { body, requestId, prefer }, true);
  if (response.status === 204) return null;
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { message: text.slice(0, 200) }; }
  if (!response.ok) throw new PayPalError(response.status, data);
  return data;
}
