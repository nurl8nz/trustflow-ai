import {
  HttpError, newId, nowIso, clampText, cleanList, toMinor, fromMinor, formatMoney, PAYPAL_CURRENCIES,
} from '../util.js';

/*
 * An agreement has two independent tracks per milestone:
 *
 *   work:  open -> submitted -> approved
 *               \-> changes_requested -> submitted ...
 *          (any unapproved state) -> cancelled
 *
 *   money: unfunded -> held (PayPal authorization) -> released (capture)
 *          held -> returned (void, when a milestone is cancelled)
 *          unfunded -> invoiced (PayPal invoice) -> paid
 *
 * Every transition is validated here, so the UI and the AI agent go through
 * exactly the same rules.
 */

export const ROLES = ['client', 'freelancer'];
const capitalize = (text) => text.charAt(0).toLocaleUpperCase() + text.slice(1);
const OPEN_WORK = ['open', 'submitted', 'changes_requested'];
const SEVERITY_PENALTY = { high: 16, medium: 8, low: 3 };

export function assertRole(role) {
  if (!ROLES.includes(role)) throw new HttpError(400, 'role must be "client" or "freelancer".', { code: 'BAD_ROLE' });
  return role;
}

const otherRole = (role) => (role === 'client' ? 'freelancer' : 'client');

/** Validates and cleans the AI's JSON so nothing downstream trusts raw model output. */
export function normalizeAnalysis(raw, sourceText) {
  const code = String(raw?.currency || 'USD').trim().toUpperCase();
  const currency = PAYPAL_CURRENCIES.has(code) ? code : 'USD';

  const milestones = (Array.isArray(raw?.milestones) ? raw.milestones : [])
    .slice(0, 8)
    .map((m) => ({
      title: clampText(m?.title, 80) || 'Milestone',
      description: clampText(m?.description, 400),
      deliverables: cleanList(m?.deliverables, 8, 200),
      acceptanceCriteria: cleanList(m?.acceptance_criteria, 8, 240),
      amountMinor: Math.max(0, toMinor(m?.amount, currency)),
      amountSource: m?.amount_source === 'suggested' ? 'suggested' : 'stated',
      dueHint: clampText(m?.due_hint, 80) || null,
    }))
    .filter((m) => m.amountMinor > 0);

  if (!milestones.length) {
    throw new HttpError(422, 'No payable milestones were found. Mention the price and what it pays for, then try again.', { code: 'NO_MILESTONES' });
  }

  const haystack = sourceText.toLowerCase();
  const gaps = (Array.isArray(raw?.gaps) ? raw.gaps : [])
    .slice(0, 8)
    .map((g, i) => {
      const quote = clampText(g?.quote, 120);
      const at = quote ? haystack.indexOf(quote.toLowerCase()) : -1;
      return {
        id: `g${i + 1}`,
        severity: ['high', 'medium', 'low'].includes(g?.severity) ? g.severity : 'medium',
        topic: capitalize(clampText(g?.topic, 60)) || 'Detail',
        issue: clampText(g?.issue, 320),
        risk: clampText(g?.risk, 320),
        question: clampText(g?.question, 240),
        suggestedClause: clampText(g?.suggested_clause, 320),
        // Only keep a highlight if the quote really exists in the user's text.
        span: at === -1 ? null : { start: at, end: at + quote.length },
      };
    })
    .filter((g) => g.question);

  const stated = Number(raw?.stated_total);
  return {
    title: clampText(raw?.title, 70) || 'Untitled agreement',
    summary: clampText(raw?.summary, 600),
    currency,
    statedTotalMinor: Number.isFinite(stated) && stated > 0 ? toMinor(stated, currency) : null,
    clientLabel: clampText(raw?.client_label, 40) || 'Client',
    freelancerLabel: clampText(raw?.freelancer_label, 40) || 'Freelancer',
    milestones,
    gaps,
  };
}

/** Deterministic, explainable score. The AI finds issues; the score is plain arithmetic. */
export function computeClarity(agreement) {
  const factors = [];
  let score = 100;
  for (const gap of agreement.gaps) {
    score -= SEVERITY_PENALTY[gap.severity];
    factors.push({ label: `${gap.topic} (${gap.severity})`, points: -SEVERITY_PENALTY[gap.severity] });
  }
  if (!agreement.amountCheck.consistent) {
    score -= 12;
    factors.push({ label: 'Milestones do not add up to the stated total', points: -12 });
  }
  const placeholders = agreement.milestones
    .flatMap((m) => m.acceptanceCriteria)
    .filter((c) => /\[[^\]]+\]/.test(c)).length;
  if (placeholders) {
    const points = Math.min(placeholders * 2, 12);
    score -= points;
    factors.push({ label: `${placeholders} acceptance check${placeholders > 1 ? 's' : ''} with blanks to fill`, points: -points });
  }
  const noCriteria = agreement.milestones.filter((m) => !m.acceptanceCriteria.length).length;
  if (noCriteria) {
    score -= noCriteria * 6;
    factors.push({ label: `${noCriteria} milestone${noCriteria > 1 ? 's' : ''} without a way to check it is done`, points: -noCriteria * 6 });
  }
  score = Math.max(5, Math.min(100, score));
  const label = score >= 80 ? 'Clear to start' : score >= 55 ? 'A few answers needed' : 'Likely to cause disputes';
  return { score, label, factors };
}

function computeAmountCheck(agreement) {
  const sumMinor = agreement.milestones.reduce((total, m) => total + m.amountMinor, 0);
  const statedMinor = agreement.statedTotalMinor;
  return { sumMinor, statedMinor, consistent: statedMinor == null || statedMinor === sumMinor };
}

export function recompute(agreement) {
  agreement.milestones.forEach((m, i) => { m.number = i + 1; });
  agreement.amountCheck = computeAmountCheck(agreement);
  agreement.totalMinor = agreement.amountCheck.sumMinor;
  agreement.clarity = computeClarity(agreement);
  agreement.updatedAt = nowIso();
}

export function log(agreement, actor, text, extra = {}) {
  agreement.activity.unshift({ id: newId('ev', 4), at: nowIso(), actor, text, ...extra });
  agreement.activity.length = Math.min(agreement.activity.length, 100);
}

function freshMilestone(m) {
  return {
    id: newId('ms', 4),
    ...m,
    work: 'open',
    money: 'unfunded',
    funding: null,
    invoice: null,
    submission: null,
    review: null,
    changeRequest: null,
  };
}

export function applyAnalysis(agreement, analysis) {
  const { milestones, ...fields } = analysis;
  Object.assign(agreement, {
    title: fields.title,
    summary: fields.summary,
    currency: fields.currency,
    statedTotalMinor: fields.statedTotalMinor,
    gaps: fields.gaps,
  });
  agreement.parties.clientLabel = fields.clientLabel;
  agreement.parties.freelancerLabel = fields.freelancerLabel;
  agreement.milestones = milestones.map(freshMilestone);
  recompute(agreement);
}

export function createAgreement(analysis, { sourceText, origin, model, clientEmail = '' }) {
  const agreement = {
    id: newId('agr', 5),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    origin,
    model,
    sourceText,
    clarifications: [],
    status: 'draft',
    acceptance: { client: null, freelancer: null },
    parties: { clientEmail },
    activity: [],
    agent: { messages: [], approvals: [] },
  };
  applyAnalysis(agreement, analysis);
  log(agreement, 'ai', `Turned the description into ${agreement.milestones.length} milestones and found ${agreement.gaps.length} open questions.`);
  return agreement;
}

export function getMilestone(agreement, milestoneId) {
  const milestone = agreement.milestones.find((m) => m.id === milestoneId || String(m.number) === String(milestoneId));
  if (!milestone) throw new HttpError(404, 'Milestone not found.', { code: 'MILESTONE_NOT_FOUND' });
  return milestone;
}

function conflict(message, code = 'INVALID_STATE') {
  return new HttpError(409, message, { code });
}

function requireRole(role, expected, what) {
  if (role !== expected) throw new HttpError(403, `Only the ${expected} can ${what}. Switch roles at the top of the page.`, { code: 'WRONG_ROLE' });
}

export function assertDraft(agreement) {
  if (agreement.status !== 'draft') throw conflict('The agreement is already accepted, so its terms are locked.', 'LOCKED');
}

export function assertActive(agreement) {
  if (agreement.status === 'draft') throw conflict('Both sides need to accept the agreement first.', 'NOT_ACTIVE');
  if (agreement.status === 'completed') throw conflict('This agreement is already completed.', 'COMPLETED');
}

function resetAcceptance(agreement, reason) {
  if (agreement.acceptance.client || agreement.acceptance.freelancer) {
    agreement.acceptance = { client: null, freelancer: null };
    log(agreement, 'system', `${reason} Both sides need to accept again.`);
  }
}

// ---------- Draft editing ----------

export function updateMilestone(agreement, milestone, patch, role) {
  assertDraft(agreement);
  if (patch.title !== undefined) milestone.title = clampText(patch.title, 80) || milestone.title;
  if (patch.description !== undefined) milestone.description = clampText(patch.description, 400);
  if (patch.deliverables !== undefined) milestone.deliverables = cleanList(patch.deliverables, 8, 200);
  if (patch.acceptanceCriteria !== undefined) milestone.acceptanceCriteria = cleanList(patch.acceptanceCriteria, 8, 240);
  if (patch.amount !== undefined) {
    const minor = toMinor(patch.amount, agreement.currency);
    if (!(minor > 0)) throw new HttpError(400, 'Amount must be greater than zero.', { code: 'BAD_AMOUNT' });
    milestone.amountMinor = minor;
    milestone.amountSource = 'stated';
  }
  recompute(agreement);
  log(agreement, role, `Edited milestone ${milestone.number}, “${milestone.title}”.`);
  resetAcceptance(agreement, 'The terms changed.');
}

export function addClarifications(agreement, answers, role) {
  assertDraft(agreement);
  const byId = new Map(agreement.gaps.map((g) => [g.id, g]));
  const added = answers
    .map(({ gapId, answer }) => ({ gap: byId.get(gapId), answer: clampText(answer, 400) }))
    .filter((x) => x.gap && x.answer)
    .map(({ gap, answer }) => ({ topic: gap.topic, question: gap.question, answer, by: role, at: nowIso() }));
  if (!added.length) throw new HttpError(400, 'Answer at least one question first.', { code: 'NO_ANSWERS' });
  agreement.clarifications.push(...added);
  agreement.clarifications = agreement.clarifications.slice(-24);
  return added;
}

export function reanalyze(agreement, analysis, answeredCount) {
  const before = agreement.clarity.score;
  applyAnalysis(agreement, analysis);
  log(agreement, 'ai', `Applied ${answeredCount} answer${answeredCount > 1 ? 's' : ''}. Clarity went from ${before} to ${agreement.clarity.score}.`);
  resetAcceptance(agreement, 'The terms changed.');
}

export function setClientEmail(agreement, email, role) {
  agreement.parties.clientEmail = email;
  log(agreement, role, email ? 'Set the client’s PayPal email for invoices.' : 'Cleared the client’s PayPal email.');
}

export function accept(agreement, role) {
  assertDraft(agreement);
  if (agreement.acceptance[role]) throw conflict(`You already accepted as the ${role}.`, 'ALREADY_ACCEPTED');
  agreement.acceptance[role] = nowIso();
  log(agreement, role, `Accepted the agreement as the ${role}.`);
  if (agreement.acceptance[otherRole(role)]) {
    agreement.status = 'active';
    agreement.activatedAt = nowIso();
    log(agreement, 'system', 'Agreement is active. The client can now fund milestones with PayPal.');
  }
}

// ---------- Active agreement transitions ----------

export function assertCanFund(agreement, milestone, role) {
  assertActive(agreement);
  requireRole(role, 'client', 'fund a milestone');
  if (milestone.money !== 'unfunded') throw conflict('This milestone already has a payment attached.');
  if (!OPEN_WORK.includes(milestone.work)) throw conflict('This milestone can no longer be funded.');
}

export function markFunded(agreement, milestone, funding) {
  milestone.money = 'held';
  milestone.funding = funding;
  log(agreement, 'paypal', `${formatMoney(funding.amountMinor, agreement.currency)} is on hold for milestone ${milestone.number}. It moves only when the client approves the work.`, { ref: funding.authorizationId });
}

export function assertCanSubmit(agreement, milestone, role) {
  assertActive(agreement);
  requireRole(role, 'freelancer', 'submit work');
  if (!['open', 'changes_requested'].includes(milestone.work)) throw conflict('Work for this milestone was already submitted.');
}

export function markSubmitted(agreement, milestone, submission) {
  milestone.work = 'submitted';
  milestone.submission = submission;
  milestone.review = null;
  log(agreement, 'freelancer', `Submitted work for milestone ${milestone.number}, “${milestone.title}”.`);
}

export function setReview(agreement, milestone, review) {
  milestone.review = review;
  if (!review.error) {
    const met = review.criteria.filter((c) => c.status === 'met').length;
    log(agreement, 'ai', `Checked the submission for milestone ${milestone.number}: ${met} of ${review.criteria.length} checks have clear evidence. The client decides.`);
  }
}

export function assertCanReview(agreement, milestone, role) {
  assertActive(agreement);
  requireRole(role, 'client', 'approve work or ask for changes');
  if (milestone.work !== 'submitted') throw conflict('There is no submitted work to review for this milestone.');
}

export function markChangesRequested(agreement, milestone, note) {
  milestone.work = 'changes_requested';
  milestone.changeRequest = { note, at: nowIso() };
  log(agreement, 'client', `Asked for changes on milestone ${milestone.number}: “${note}”`);
}

export function markApproved(agreement, milestone, capture) {
  milestone.work = 'approved';
  milestone.approvedAt = nowIso();
  if (capture) {
    milestone.money = 'released';
    milestone.funding = { ...milestone.funding, ...capture, status: 'CAPTURED' };
    log(agreement, 'paypal', `Released ${formatMoney(milestone.amountMinor, agreement.currency)} to the freelancer for milestone ${milestone.number}.`, { ref: capture.captureId });
  } else {
    log(agreement, 'client', `Approved milestone ${milestone.number}. No payment was on hold, so the freelancer can send a PayPal invoice.`);
  }
  completeIfDone(agreement);
}

export function assertCanCancel(agreement, milestone, role) {
  assertActive(agreement);
  requireRole(role, 'client', 'cancel a milestone');
  if (!OPEN_WORK.includes(milestone.work)) throw conflict('Only milestones that are not approved yet can be cancelled.');
  if (milestone.money === 'invoiced') throw conflict('Cancel the open invoice in PayPal first.');
}

export function markCancelled(agreement, milestone, voided) {
  milestone.work = 'cancelled';
  if (voided) {
    milestone.money = 'returned';
    milestone.funding = { ...milestone.funding, status: 'VOIDED', voidedAt: nowIso() };
    log(agreement, 'paypal', `Cancelled milestone ${milestone.number}. The hold was voided, so the client was not charged.`);
  } else {
    log(agreement, 'client', `Cancelled milestone ${milestone.number}.`);
  }
  completeIfDone(agreement);
}

export function assertCanInvoice(agreement, milestone, role) {
  if (agreement.status === 'draft') throw conflict('Both sides need to accept the agreement first.', 'NOT_ACTIVE');
  requireRole(role, 'freelancer', 'send an invoice');
  if (milestone.work !== 'approved') throw conflict('Invoices can be sent once the client approves the milestone.');
  if (milestone.money !== 'unfunded') throw conflict('This milestone is already paid or invoiced.');
}

export function markInvoiced(agreement, milestone, invoice) {
  milestone.money = 'invoiced';
  milestone.invoice = invoice;
  log(agreement, 'paypal', `Sent PayPal invoice ${invoice.number || invoice.id} for ${formatMoney(milestone.amountMinor, agreement.currency)}.`, { ref: invoice.id });
}

export function applyPayPalStatus(agreement, milestone, { authorizationStatus, invoiceStatus }) {
  let changed = false;
  if (authorizationStatus && milestone.funding) {
    milestone.funding.status = authorizationStatus;
    if (milestone.money === 'held' && ['VOIDED', 'EXPIRED'].includes(authorizationStatus)) {
      milestone.money = 'unfunded';
      log(agreement, 'paypal', `The hold for milestone ${milestone.number} is ${authorizationStatus.toLowerCase()}. The client can fund it again.`);
      milestone.funding = null;
      changed = true;
    }
    if (milestone.money === 'held' && authorizationStatus === 'CAPTURED') {
      milestone.money = 'released';
      log(agreement, 'paypal', `PayPal reports the payment for milestone ${milestone.number} as captured.`);
      changed = true;
    }
  }
  if (invoiceStatus && milestone.invoice) {
    milestone.invoice.status = invoiceStatus;
    if (milestone.money === 'invoiced' && ['PAID', 'MARKED_AS_PAID'].includes(invoiceStatus)) {
      milestone.money = 'paid';
      milestone.invoice.paidAt = nowIso();
      log(agreement, 'paypal', `Invoice for milestone ${milestone.number} is paid.`, { ref: milestone.invoice.id });
      changed = true;
    }
    if (milestone.money === 'invoiced' && invoiceStatus === 'CANCELLED') {
      milestone.money = 'unfunded';
      log(agreement, 'paypal', `Invoice for milestone ${milestone.number} was cancelled.`);
      milestone.invoice = null;
      changed = true;
    }
  }
  if (changed) completeIfDone(agreement);
  return changed;
}

function completeIfDone(agreement) {
  const settled = (m) => m.work === 'cancelled' || (m.work === 'approved' && ['released', 'paid'].includes(m.money));
  if (agreement.status === 'active' && agreement.milestones.every(settled)) {
    agreement.status = 'completed';
    agreement.completedAt = nowIso();
    log(agreement, 'system', 'Every milestone is settled. Agreement completed.');
  }
  agreement.updatedAt = nowIso();
}

// ---------- View model ----------

function milestoneActions(agreement, m, role) {
  const actions = [];
  if (agreement.status === 'draft') return ['edit'];
  if (role === 'client') {
    if (agreement.status === 'active' && m.money === 'unfunded' && OPEN_WORK.includes(m.work)) actions.push('fund');
    if (m.work === 'submitted') actions.push('approve', 'request_changes');
    if (agreement.status === 'active' && OPEN_WORK.includes(m.work) && m.money !== 'invoiced') actions.push('cancel');
    if (m.money === 'invoiced' && m.invoice?.payerUrl) actions.push('pay_invoice');
  } else {
    if (agreement.status === 'active' && ['open', 'changes_requested'].includes(m.work)) actions.push('submit');
    if (m.work === 'approved' && m.money === 'unfunded') actions.push('invoice');
  }
  if (m.funding?.authorizationId || m.invoice?.id) actions.push('sync');
  return actions;
}

export function presentAgreement(agreement, role) {
  const money = (minor) => formatMoney(minor, agreement.currency);
  const sumWhere = (predicate) => agreement.milestones.filter(predicate).reduce((t, m) => t + m.amountMinor, 0);
  const totals = {
    total: money(agreement.totalMinor),
    held: money(sumWhere((m) => m.money === 'held')),
    paid: money(sumWhere((m) => ['released', 'paid'].includes(m.money))),
    open: money(sumWhere((m) => m.work !== 'cancelled' && ['unfunded', 'invoiced'].includes(m.money))),
  };
  return {
    id: agreement.id,
    title: agreement.title,
    summary: agreement.summary,
    status: agreement.status,
    origin: agreement.origin,
    createdAt: agreement.createdAt,
    updatedAt: agreement.updatedAt,
    sourceText: agreement.sourceText,
    currency: agreement.currency,
    parties: agreement.parties,
    acceptance: agreement.acceptance,
    clarity: agreement.clarity,
    gaps: agreement.gaps,
    clarifications: agreement.clarifications,
    amountCheck: {
      ...agreement.amountCheck,
      sum: money(agreement.amountCheck.sumMinor),
      stated: agreement.amountCheck.statedMinor == null ? null : money(agreement.amountCheck.statedMinor),
    },
    totals,
    milestones: agreement.milestones.map((m) => ({
      ...m,
      amount: money(m.amountMinor),
      amountValue: fromMinor(m.amountMinor, agreement.currency),
      actions: milestoneActions(agreement, m, role),
    })),
    activity: agreement.activity.slice(0, 40),
    agent: {
      messages: agreement.agent.messages.slice(-30),
      approvals: agreement.agent.approvals.slice(-20),
    },
    you: { role, canAccept: agreement.status === 'draft' && !agreement.acceptance[role] },
  };
}

export function summarizeAgreement(agreement) {
  return {
    id: agreement.id,
    title: agreement.title,
    status: agreement.status,
    total: formatMoney(agreement.totalMinor, agreement.currency),
    clarity: agreement.clarity.score,
    updatedAt: agreement.updatedAt,
  };
}