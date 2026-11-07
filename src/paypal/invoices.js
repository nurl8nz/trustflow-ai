import { config } from '../config.js';
import { paypalRequest } from './client.js';
import { toPayPalValue } from '../util.js';

/** Creates a DRAFT invoice. Nothing is sent to anyone until sendInvoice is called. */
export async function createDraftInvoice({ currency, recipientEmail, itemName, itemDescription, amountMinor, note, reference, requestId }) {
  const body = {
    detail: {
      currency_code: currency,
      reference: reference?.slice(0, 120),
      note: note?.slice(0, 4000),
      terms_and_conditions: 'Issued through TrustFlow AI for an approved milestone.',
      payment_term: { term_type: 'DUE_ON_RECEIPT' },
    },
    items: [{
      name: itemName.slice(0, 200),
      description: itemDescription?.slice(0, 1000),
      quantity: '1',
      unit_amount: { currency_code: currency, value: toPayPalValue(amountMinor, currency) },
      unit_of_measure: 'AMOUNT',
    }],
  };
  if (recipientEmail) body.primary_recipients = [{ billing_info: { email_address: recipientEmail } }];

  const result = await paypalRequest('POST', '/v2/invoicing/invoices', { body, requestId });
  // With Prefer: return=representation PayPal returns the invoice; older behaviour returns only a link.
  const id = result?.id ?? result?.href?.split('/').pop();
  return { id, number: result?.detail?.invoice_number ?? null, status: result?.status ?? 'DRAFT' };
}

/** Sends the invoice. Without a recipient email PayPal still issues it and returns a shareable payer link. */
export async function sendInvoice(invoiceId, { subject, note, notifyRecipient }) {
  await paypalRequest('POST', `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/send`, {
    requestId: `send-${invoiceId}`,
    body: {
      subject: subject?.slice(0, 4000),
      note: note?.slice(0, 4000),
      send_to_recipient: Boolean(notifyRecipient),
      send_to_invoicer: false,
    },
  });
  return getInvoiceSummary(invoiceId);
}

export async function getInvoiceSummary(invoiceId) {
  const invoice = await paypalRequest('GET', `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}`);
  return {
    id: invoice.id,
    number: invoice.detail?.invoice_number ?? null,
    status: invoice.status,
    payerUrl: invoice.detail?.metadata?.recipient_view_url ?? `${config.paypal.webBase}/invoice/p/#${invoice.id}`,
  };
}

export async function deleteDraftInvoice(invoiceId) {
  await paypalRequest('DELETE', `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}`);
}
