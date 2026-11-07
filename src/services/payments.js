import { store } from '../store/db.js';
import { HttpError, withLock, nowIso, formatMoney, toMinor } from '../util.js';
import * as Orders from '../paypal/orders.js';
import * as Invoices from '../paypal/invoices.js';
import {
  assertCanFund, markFunded, assertCanReview, markApproved, assertCanCancel, markCancelled,
  assertCanInvoice, markInvoiced, applyPayPalStatus, log,
} from '../domain/agreements.js';

/*
 * The only place that moves money. Both the UI routes and the AI agent's
 * approved actions call these functions, so every rule applies to both.
 */

const ref = (wsId, agreement, milestone) => ({ ws: wsId, agreementId: agreement.id, milestoneId: milestone.id });
const describe = (agreement, milestone) => `${agreement.title}: milestone ${milestone.number}, ${milestone.title}`;

export function startFunding(wsId, agreement, milestone, role, { baseUrl, redirect = false }) {
  assertCanFund(agreement, milestone, role);
  return withLock(`fund:${milestone.id}`, async () => {
    const order = await Orders.createAuthorizeOrder({
      amountMinor: milestone.amountMinor,
      currency: agreement.currency,
      description: describe(agreement, milestone),
      referenceId: milestone.id,
      customId: `${agreement.id}:${milestone.id}`,
      returnUrl: redirect ? `${baseUrl}/api/paypal/return` : undefined,
      cancelUrl: redirect ? `${baseUrl}/api/paypal/cancel?agreement=${agreement.id}` : undefined,
      requestId: `order-${milestone.id}-${Date.now()}`,
    });
    milestone.pendingOrderId = order.id;
    store.link(order.id, ref(wsId, agreement, milestone));
    store.save();
    return order;
  });
}

export function completeFunding(wsId, agreement, milestone, role, orderId) {
  assertCanFund(agreement, milestone, role);
  // Only accept the order this server created for this milestone.
  if (!orderId || orderId !== milestone.pendingOrderId) {
    throw new HttpError(400, 'This PayPal order does not belong to this milestone.', { code: 'ORDER_MISMATCH' });
  }
  return withLock(`fund:${milestone.id}`, async () => {
    const auth = await Orders.authorizeOrder(orderId);
    const paidMinor = toMinor(auth.amount?.value, agreement.currency);
    if (auth.amount?.currency_code !== agreement.currency || paidMinor !== milestone.amountMinor) {
      throw new HttpError(422, 'The authorized amount does not match the milestone amount.', { code: 'AMOUNT_MISMATCH' });
    }
    if (!['CREATED', 'PENDING'].includes(auth.status)) {
      throw new HttpError(422, `PayPal did not approve the hold (status ${auth.status}). Try another payment method.`, { code: 'AUTH_DENIED' });
    }
    markFunded(agreement, milestone, {
      orderId,
      authorizationId: auth.authorizationId,
      status: auth.status,
      expiresAt: auth.expiresAt,
      amountMinor: paidMinor,
      payerEmail: auth.payerEmail,
      at: nowIso(),
    });
    if (auth.status === 'PENDING') log(agreement, 'paypal', 'PayPal is still reviewing this hold. It usually clears within minutes.');
    if (!agreement.parties.clientEmail && auth.payerEmail) agreement.parties.clientEmail = auth.payerEmail;
    delete milestone.pendingOrderId;
    store.link(auth.authorizationId, ref(wsId, agreement, milestone));
    store.save();
  });
}

/** Approves submitted work. If money is on hold, captures it in the same step. */
export function approveAndRelease(agreement, milestone, role) {
  assertCanReview(agreement, milestone, role);
  return withLock(`release:${milestone.id}`, async () => {
    let capture = null;
    if (milestone.money === 'held') {
      capture = await Orders.captureAuthorization(milestone.funding.authorizationId, {
        noteToPayer: `Payment released for ${milestone.title}.`,
        invoiceId: `${agreement.id}-${milestone.id}`,
      });
    }
    markApproved(agreement, milestone, capture);
    store.save();
    return capture;
  });
}

export function cancelMilestone(agreement, milestone, role) {
  assertCanCancel(agreement, milestone, role);
  return withLock(`cancel:${milestone.id}`, async () => {
    const voided = milestone.money === 'held';
    if (voided) await Orders.voidAuthorization(milestone.funding.authorizationId);
    markCancelled(agreement, milestone, voided);
    store.save();
  });
}

/** Creates a draft invoice only. Used by the agent before the human approves sending. */
export function prepareInvoice(wsId, agreement, milestone, role, { note }) {
  assertCanInvoice(agreement, milestone, role);
  if (milestone.invoice?.status === 'DRAFT') return Promise.resolve(milestone.invoice);
  return withLock(`invoice:${milestone.id}`, async () => {
    const draft = await Invoices.createDraftInvoice({
      currency: agreement.currency,
      recipientEmail: agreement.parties.clientEmail || undefined,
      itemName: `Milestone ${milestone.number}: ${milestone.title}`,
      itemDescription: milestone.deliverables.join('; '),
      amountMinor: milestone.amountMinor,
      note,
      reference: agreement.title,
      requestId: `invoice-${milestone.id}-${Date.now()}`,
    });
    milestone.invoice = { ...draft, note, createdAt: nowIso() };
    store.link(draft.id, ref(wsId, agreement, milestone));
    log(agreement, 'ai', `Prepared draft PayPal invoice for milestone ${milestone.number} (${formatMoney(milestone.amountMinor, agreement.currency)}). Waiting for approval to send.`, { ref: draft.id });
    store.save();
    return milestone.invoice;
  });
}

export function sendPreparedInvoice(agreement, milestone, role) {
  assertCanInvoice(agreement, milestone, role);
  if (!milestone.invoice?.id) throw new HttpError(409, 'There is no prepared invoice to send.', { code: 'NO_DRAFT' });
  return withLock(`invoice:${milestone.id}`, async () => {
    const sent = await Invoices.sendInvoice(milestone.invoice.id, {
      subject: `Invoice for ${milestone.title}`,
      note: milestone.invoice.note,
      notifyRecipient: Boolean(agreement.parties.clientEmail),
    });
    markInvoiced(agreement, milestone, { ...milestone.invoice, ...sent, sentAt: nowIso() });
    store.save();
    return milestone.invoice;
  });
}

/** Manual path from the UI: prepare and send in one step. */
export async function issueInvoice(wsId, agreement, milestone, role, { note }) {
  await prepareInvoice(wsId, agreement, milestone, role, { note });
  return sendPreparedInvoice(agreement, milestone, role);
}

export async function discardDraftInvoice(agreement, milestone) {
  if (milestone.invoice?.status !== 'DRAFT') return;
  try {
    await Invoices.deleteDraftInvoice(milestone.invoice.id);
  } catch (error) {
    console.warn('[payments] Could not delete draft invoice:', error.message);
  }
  milestone.invoice = null;
  store.save();
}

/** Reads the live state from PayPal and reconciles it. Works without webhooks. */
export async function syncMilestone(agreement, milestone) {
  const status = {};
  if (milestone.funding?.authorizationId && milestone.money === 'held') {
    const auth = await Orders.getAuthorization(milestone.funding.authorizationId);
    status.authorizationStatus = auth.status;
    if (auth.expiration_time) milestone.funding.expiresAt = auth.expiration_time;
  }
  if (milestone.invoice?.id && milestone.invoice.status !== 'DRAFT') {
    const invoice = await Invoices.getInvoiceSummary(milestone.invoice.id);
    status.invoiceStatus = invoice.status;
    milestone.invoice.payerUrl = invoice.payerUrl;
  }
  const changed = applyPayPalStatus(agreement, milestone, status);
  milestone.syncedAt = nowIso();
  store.save();
  return { ...status, changed };
}
