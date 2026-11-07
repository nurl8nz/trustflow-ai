import { generate, textOf } from './gemini.js';
import { agentPrompt, agentTools } from './prompts.js';
import { HttpError, newId, nowIso, clampText, formatMoney } from '../util.js';
import { getMilestone, presentAgreement } from '../domain/agreements.js';
import * as Payments from '../services/payments.js';

/*
 * The payment agent plans with Gemini function calling. Read-only tools run
 * immediately. Anything that moves money only creates an approval card; the
 * human approves it in the UI, which calls executeApproval below.
 */

const MAX_STEPS = 6;
const HISTORY_TURNS = 12;

function stateForModel(agreement, role) {
  const view = presentAgreement(agreement, role);
  return {
    title: view.title,
    status: view.status,
    currency: view.currency,
    totals: view.totals,
    client_email_for_invoices: view.parties.clientEmail || null,
    milestones: view.milestones.map((m) => ({
      number: m.number,
      title: m.title,
      amount: m.amount,
      work_status: m.work,
      payment_status: m.money,
      acceptance_criteria: m.acceptanceCriteria,
      delivery_note: m.submission?.note ?? null,
      ai_delivery_check: m.review && !m.review.error
        ? { overall: m.review.overall, unclear_or_missing: m.review.criteria.filter((c) => c.status !== 'met').map((c) => c.criterion) }
        : null,
      change_request: m.changeRequest?.note ?? null,
      hold_expires_at: m.money === 'held' ? m.funding?.expiresAt ?? null : null,
      invoice: m.invoice ? { status: m.invoice.status, number: m.invoice.number } : null,
      actions_available_to_you: m.actions,
    })),
    pending_approval_cards: agreement.agent.approvals.filter((a) => a.status === 'pending').map((a) => ({ action: a.action, milestone_number: a.milestoneNumber })),
  };
}

function addApproval(agreement, role, { action, milestone, rationale, invoiceId }) {
  const existing = agreement.agent.approvals.find((a) => a.status === 'pending' && a.action === action && a.milestoneId === milestone.id);
  if (existing) return existing;
  const approval = {
    id: newId('apv', 4),
    action,
    role,
    milestoneId: milestone.id,
    milestoneNumber: milestone.number,
    milestoneTitle: milestone.title,
    amount: formatMoney(milestone.amountMinor, agreement.currency),
    rationale: clampText(rationale, 300),
    invoiceId: invoiceId ?? null,
    status: 'pending',
    createdAt: nowIso(),
  };
  agreement.agent.approvals.push(approval);
  agreement.agent.approvals = agreement.agent.approvals.slice(-30);
  return approval;
}

async function runTool(name, args, ctx) {
  const { agreement, role, wsId } = ctx;
  const milestone = () => getMilestone(agreement, String(args.milestone_number));
  switch (name) {
    case 'get_agreement_state':
      return stateForModel(agreement, role);
    case 'check_paypal_status': {
      const m = milestone();
      if (!m.funding?.authorizationId && !m.invoice?.id) return { milestone_number: m.number, note: 'No PayPal hold or invoice exists for this milestone yet.' };
      const result = await Payments.syncMilestone(agreement, m);
      return { milestone_number: m.number, payment_status: m.money, paypal: result };
    }
    case 'prepare_invoice': {
      if (role !== 'freelancer') throw new HttpError(403, 'Only the freelancer can invoice.');
      const m = milestone();
      const invoice = await Payments.prepareInvoice(wsId, agreement, m, role, { note: clampText(args.note_to_client, 600) });
      const approval = addApproval(agreement, role, { action: 'send_invoice', milestone: m, rationale: args.note_to_client, invoiceId: invoice.id });
      return { prepared_invoice_id: invoice.id, approval_card: approval.id, sent: false, next: 'The freelancer must approve the card to send it.' };
    }
    case 'propose_release_payment':
    case 'propose_cancel_milestone': {
      if (role !== 'client') throw new HttpError(403, 'Only the client can do this.');
      const m = milestone();
      const action = name === 'propose_release_payment' ? 'release_payment' : 'cancel_milestone';
      if (action === 'release_payment' && m.work !== 'submitted') {
        return { error: `Milestone ${m.number} has no submitted work to approve (work status: ${m.work}).` };
      }
      if (action === 'cancel_milestone' && !['open', 'submitted', 'changes_requested'].includes(m.work)) {
        return { error: `Milestone ${m.number} cannot be cancelled (work status: ${m.work}).` };
      }
      const approval = addApproval(agreement, role, { action, milestone: m, rationale: args.rationale });
      return { approval_card: approval.id, executed: false, next: 'The client must approve the card in the app.' };
    }
    default:
      return { error: `Unknown tool ${name}.` };
  }
}

const TRACE_LABELS = {
  get_agreement_state: () => 'Read the agreement',
  check_paypal_status: (a) => `Checked PayPal status for milestone ${a.milestone_number}`,
  prepare_invoice: (a) => `Prepared a draft PayPal invoice for milestone ${a.milestone_number}`,
  propose_release_payment: (a) => `Proposed releasing payment for milestone ${a.milestone_number}`,
  propose_cancel_milestone: (a) => `Proposed cancelling milestone ${a.milestone_number}`,
};

export async function runAgent({ wsId, agreement, role, message }) {
  const history = agreement.agent.messages
    .filter((m) => m.role === role || (m.role === 'agent' && m.for === role))
    .slice(-HISTORY_TURNS)
    .map((m) => ({ role: m.role === 'agent' ? 'model' : 'user', parts: [{ text: m.text }] }));
  const contents = [...history, { role: 'user', parts: [{ text: message }] }];
  const tools = agentTools(role);
  const trace = [];
  let reply = '';

  for (let step = 0; step < MAX_STEPS; step += 1) {
    const { content, parts } = await generate({ system: agentPrompt(role, agreement), contents, tools });
    contents.push(content);
    const calls = parts.filter((p) => p.functionCall);
    if (!calls.length) {
      reply = textOf(parts);
      break;
    }
    const responses = [];
    for (const { functionCall } of calls) {
      const args = functionCall.args ?? {};
      let result;
      try {
        result = await runTool(functionCall.name, args, { agreement, role, wsId });
        trace.push({ label: (TRACE_LABELS[functionCall.name] ?? (() => functionCall.name))(args), ok: !result?.error });
      } catch (error) {
        result = { error: error.message };
        trace.push({ label: (TRACE_LABELS[functionCall.name] ?? (() => functionCall.name))(args), ok: false });
      }
      const fnResponse = { name: functionCall.name, response: { result } };
      if (functionCall.id) fnResponse.id = functionCall.id;
      responses.push({ functionResponse: fnResponse });
    }
    contents.push({ role: 'user', parts: responses });
  }

  if (!reply) reply = 'I ran out of steps for this request. Check the approval cards below, or ask again more specifically.';
  const at = nowIso();
  agreement.agent.messages.push(
    { id: newId('msg', 4), role, text: message, at },
    { id: newId('msg', 4), role: 'agent', for: role, text: reply, trace, at },
  );
  agreement.agent.messages = agreement.agent.messages.slice(-60);
  return { reply, trace };
}

/** Runs an approved card through the same payment service the buttons use. */
export async function executeApproval({ agreement, approval, role }) {
  if (approval.status !== 'pending') throw new HttpError(409, 'This card was already handled.', { code: 'HANDLED' });
  if (approval.role !== role) throw new HttpError(403, `Only the ${approval.role} can approve this card.`, { code: 'WRONG_ROLE' });
  const milestone = getMilestone(agreement, approval.milestoneId);
  try {
    if (approval.action === 'send_invoice') await Payments.sendPreparedInvoice(agreement, milestone, role);
    else if (approval.action === 'release_payment') await Payments.approveAndRelease(agreement, milestone, role);
    else if (approval.action === 'cancel_milestone') await Payments.cancelMilestone(agreement, milestone, role);
    else throw new HttpError(400, 'Unknown action.');
    approval.status = 'approved';
  } catch (error) {
    approval.status = 'failed';
    approval.error = error.message;
    throw error;
  } finally {
    approval.resolvedAt = nowIso();
  }
}

export async function declineApproval({ agreement, approval, role }) {
  if (approval.status !== 'pending') throw new HttpError(409, 'This card was already handled.', { code: 'HANDLED' });
  if (approval.role !== role) throw new HttpError(403, `Only the ${approval.role} can decline this card.`, { code: 'WRONG_ROLE' });
  approval.status = 'declined';
  approval.resolvedAt = nowIso();
  if (approval.action === 'send_invoice') {
    await Payments.discardDraftInvoice(agreement, getMilestone(agreement, approval.milestoneId));
  }
}
