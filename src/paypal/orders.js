import { config } from '../config.js';
import { paypalRequest, PayPalError } from './client.js';
import { toPayPalValue } from '../util.js';

/**
 * Creates an order with intent AUTHORIZE. When the buyer approves it, the
 * money is reserved on their account but not taken. We capture it later,
 * only after the client approves the delivered work.
 */
export async function createAuthorizeOrder({ amountMinor, currency, description, referenceId, customId, returnUrl, cancelUrl, requestId }) {
  const order = await paypalRequest('POST', '/v2/checkout/orders', {
    requestId,
    body: {
      intent: 'AUTHORIZE',
      purchase_units: [{
        reference_id: referenceId,
        custom_id: customId,
        description: description.slice(0, 127),
        soft_descriptor: 'TRUSTFLOW',
        amount: { currency_code: currency, value: toPayPalValue(amountMinor, currency) },
      }],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: config.paypal.brandName,
            shipping_preference: 'NO_SHIPPING',
            user_action: 'PAY_NOW',
            // Only the full-page redirect flow needs these. The SDK popup
            // reports approval back to the page through onApprove instead.
            ...(returnUrl && { return_url: returnUrl, cancel_url: cancelUrl }),
          },
        },
      },
    },
  });
  const approveUrl = order.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href ?? null;
  return { id: order.id, status: order.status, approveUrl };
}

export const getOrder = (orderId) => paypalRequest('GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`);

const firstAuthorization = (order) => order?.purchase_units?.[0]?.payments?.authorizations?.[0] ?? null;

/** Authorizes an approved order. Safe to call twice: an already-authorized order is read back. */
export async function authorizeOrder(orderId) {
  let order;
  try {
    order = await paypalRequest('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`, {
      body: {},
      requestId: `authorize-${orderId}`,
    });
  } catch (error) {
    if (!(error instanceof PayPalError) || error.paypalIssue !== 'ORDER_ALREADY_AUTHORIZED') throw error;
    order = await getOrder(orderId);
  }
  const authorization = firstAuthorization(order);
  if (!authorization) throw new PayPalError(422, { message: 'PayPal did not return an authorization for this order.' });
  const unit = order.purchase_units[0];
  return {
    orderId: order.id,
    orderStatus: order.status,
    authorizationId: authorization.id,
    status: authorization.status,
    amount: authorization.amount ?? unit.amount,
    expiresAt: authorization.expiration_time ?? null,
    customId: unit.custom_id ?? null,
    payerEmail: order.payer?.email_address ?? order.payment_source?.paypal?.email_address ?? null,
  };
}

export async function captureAuthorization(authorizationId, { noteToPayer, invoiceId } = {}) {
  const capture = await paypalRequest('POST', `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/capture`, {
    requestId: `capture-${authorizationId}`,
    body: { final_capture: true, note_to_payer: noteToPayer?.slice(0, 255), invoice_id: invoiceId },
  });
  return { captureId: capture.id, captureStatus: capture.status, capturedAt: capture.create_time ?? new Date().toISOString() };
}

export async function voidAuthorization(authorizationId) {
  await paypalRequest('POST', `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/void`, {
    requestId: `void-${authorizationId}`,
  });
}

export const getAuthorization = (authorizationId) =>
  paypalRequest('GET', `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}`);
