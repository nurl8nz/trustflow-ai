import { config } from '../config.js';
import { paypalRequest } from './client.js';

/**
 * Verifies a webhook with PayPal's verify-webhook-signature API.
 * Unverified events are never applied.
 */
export async function verifyWebhook(headers, event) {
  if (!config.paypal.webhookId) return false;
  const h = (name) => headers[name] ?? headers[name.toLowerCase()];
  const result = await paypalRequest('POST', '/v1/notifications/verify-webhook-signature', {
    prefer: 'return=minimal',
    body: {
      auth_algo: h('paypal-auth-algo'),
      cert_url: h('paypal-cert-url'),
      transmission_id: h('paypal-transmission-id'),
      transmission_sig: h('paypal-transmission-sig'),
      transmission_time: h('paypal-transmission-time'),
      webhook_id: config.paypal.webhookId,
      webhook_event: event,
    },
  });
  return result?.verification_status === 'SUCCESS';
}

/** Pulls the PayPal object id we index milestones by out of a webhook event. */
export function webhookTarget(event) {
  const r = event?.resource ?? {};
  switch (event?.event_type) {
    case 'PAYMENT.AUTHORIZATION.VOIDED':
    case 'PAYMENT.AUTHORIZATION.CREATED':
      return { paypalId: r.id, authorizationStatus: r.status };
    case 'PAYMENT.CAPTURE.COMPLETED':
      return { paypalId: r.supplementary_data?.related_ids?.authorization_id, authorizationStatus: 'CAPTURED' };
    case 'INVOICING.INVOICE.PAID':
    case 'INVOICING.INVOICE.CANCELLED':
      return { paypalId: r.invoice?.id ?? r.id, invoiceStatus: r.invoice?.status ?? (event.event_type.endsWith('PAID') ? 'PAID' : 'CANCELLED') };
    default:
      return null;
  }
}
