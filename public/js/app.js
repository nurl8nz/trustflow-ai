import { api } from './api.js';
import { html, toast, toastError, openDialog, lines } from './ui.js';
import { sidebar, composeView, agreementView, agentPanel } from './views.js';
import { mountPayPalButton } from './paypal.js';

const ROLE_KEY = 'trustflow.role';

const state = {
  config: null,
  role: readRole(),
  list: [],
  route: { name: 'compose' },
  agreement: null,
  busy: new Set(),
  expanded: new Set(),
  funding: null,
  answers: {},
  draftText: '',
  agentDraft: '',
};

function readRole() {
  try { return localStorage.getItem(ROLE_KEY) === 'freelancer' ? 'freelancer' : 'client'; } catch { return 'client'; }
}

const $ = (selector) => document.querySelector(selector);

// ---------- Rendering ----------

function render() {
  $('#sidebar').innerHTML = sidebar(state).value;
  const main = $('#main');
  main.innerHTML = (state.route.name === 'agreement' ? agreementView(state) : composeView(state)).value;
  const agent = $('#agent');
  agent.hidden = state.route.name !== 'agreement' || !state.agreement;
  agent.innerHTML = agentPanel(state).value;
  document.querySelectorAll('[data-role]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.role === state.role)));
  document.body.dataset.view = state.route.name;
  if (state.funding) mountFunding(state.funding);
}

async function withBusy(key, fn) {
  if (state.busy.has(key)) return undefined;
  state.busy.add(key);
  render();
  try {
    return await fn();
  } catch (error) {
    toastError(error);
    return undefined;
  } finally {
    state.busy.delete(key);
    render();
  }
}

function setAgreement(agreement) {
  state.agreement = agreement;
  const item = state.list.find((x) => x.id === agreement.id);
  const summary = { id: agreement.id, title: agreement.title, status: agreement.status, total: agreement.totals.total, clarity: agreement.clarity.score, updatedAt: agreement.updatedAt };
  if (item) Object.assign(item, summary);
  else state.list.unshift(summary);
}

async function refreshList() {
  try {
    state.list = (await api.list()).agreements;
  } catch {
    state.list = [];
  }
}

// ---------- Routing ----------

function parseHash() {
  const [path, query = ''] = location.hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(query);
  const match = path.match(/^\/a\/([\w-]+)/);
  return { route: match ? { name: 'agreement', id: match[1] } : { name: 'compose' }, params };
}

async function onRoute() {
  const { route, params } = parseHash();
  state.route = route;
  state.funding = null;
  closeSidebar();
  if (route.name === 'agreement') {
    if (state.agreement?.id !== route.id) {
      state.agreement = null;
      state.answers = {};
      state.expanded.clear();
      render();
    }
    try {
      setAgreement((await api.get(route.id, state.role)).agreement);
    } catch (error) {
      toastError(error);
      location.hash = '#/';
      return;
    }
  } else {
    state.agreement = null;
  }
  const paypal = params.get('paypal');
  if (paypal) {
    const messages = {
      funded: ['The milestone is funded. The money is on hold until you approve the work.', 'success'],
      failed: ['PayPal could not complete the hold. Try funding the milestone again.', 'error'],
      cancelled: ['You left PayPal before approving. Nothing was charged.', 'info'],
      unknown: ['That PayPal checkout does not belong to this browser.', 'error'],
    };
    const [text, kind] = messages[paypal] ?? messages.unknown;
    toast(text, kind);
    history.replaceState(null, '', location.pathname + location.hash.split('?')[0]);
  }
  render();
  if (route.name === 'agreement') $('#main').focus({ preventScroll: true });
}

// ---------- PayPal ----------

function mountFunding(milestoneId) {
  const container = document.getElementById(`fund-${milestoneId}`);
  if (!container || container.dataset.mounted) return;
  container.dataset.mounted = 'true';
  const a = state.agreement;
  mountPayPalButton(container, {
    paypalConfig: state.config.paypal,
    currency: a.currency,
    createOrder: (flow) => api.createOrder(a.id, milestoneId, flow),
    onApproved: async (orderId) => {
      container.innerHTML = '<p class="fund-loading">Placing the hold…</p>';
      try {
        setAgreement((await api.authorize(a.id, milestoneId, orderId)).agreement);
        state.funding = null;
        toast('Funded. The money is on hold in PayPal until you approve the work.', 'success');
      } catch (error) {
        toastError(error);
        state.funding = null;
      }
      render();
    },
    onCancel: () => toast('You closed PayPal before approving. Nothing was charged.'),
    onError: (error) => toastError(error instanceof Error ? error : new Error('PayPal reported an error. Try again.')),
  });
}

// ---------- Actions ----------

const milestoneOf = (mid) => state.agreement.milestones.find((m) => m.id === mid);

const actions = {
  async sample(el) {
    await withBusy('sample', async () => {
      const { agreement } = await api.sample(el.dataset.sample, state.role);
      setAgreement(agreement);
      location.hash = `#/a/${agreement.id}`;
    });
  },

  'focus-gap'(el) {
    const input = document.getElementById(`answer-${el.dataset.gap}`);
    const item = document.getElementById(`gap-${el.dataset.gap}`);
    item?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
    item?.classList.add('is-flash');
    setTimeout(() => item?.classList.remove('is-flash'), 1200);
    input?.focus({ preventScroll: true });
  },

  'use-suggestion'(el) {
    const gap = state.agreement.gaps.find((g) => g.id === el.dataset.gap);
    const input = document.getElementById(`answer-${gap.id}`);
    state.answers[gap.id] = gap.suggestedClause;
    input.value = gap.suggestedClause;
    input.focus();
  },

  async accept() {
    await withBusy('accept', async () => {
      const { agreement } = await api.accept(state.agreement.id, state.role);
      setAgreement(agreement);
      toast(agreement.status === 'active' ? 'Both sides accepted. The client can now fund milestones.' : `Accepted as the ${state.role}. Switch roles at the top to accept as the other side.`, 'success');
    });
  },

  'edit-milestone'(el) {
    const m = milestoneOf(el.dataset.mid);
    openDialog({
      title: `Edit milestone ${m.number}`,
      intro: 'Changing the terms resets both acceptances.',
      submitLabel: 'Save milestone',
      body: html`
        <label class="field"><span>Title</span><input name="title" required maxlength="80" value="${m.title}"></label>
        <label class="field"><span>Amount (${state.agreement.currency})</span><input name="amount" type="number" min="0.01" step="0.01" required value="${m.amountValue}"></label>
        <label class="field"><span>Delivered, one per line</span><textarea name="deliverables" rows="3">${m.deliverables.join('\n')}</textarea></label>
        <label class="field"><span>Done when, one check per line</span><textarea name="criteria" rows="4">${m.acceptanceCriteria.join('\n')}</textarea><small>Replace blanks like [number] with the real value.</small></label>`,
      onSubmit: async (data) => {
        const { agreement } = await api.editMilestone(state.agreement.id, m.id, state.role, {
          title: data.get('title'),
          amount: Number(data.get('amount')),
          deliverables: lines(data.get('deliverables')),
          acceptanceCriteria: lines(data.get('criteria')),
        });
        setAgreement(agreement);
        render();
        toast('Milestone saved.', 'success');
      },
    });
  },

  fund(el) {
    state.funding = el.dataset.mid;
    state.expanded.add(el.dataset.mid);
    render();
  },

  'cancel-fund'() {
    state.funding = null;
    render();
  },

  'submit-work'(el) {
    const m = milestoneOf(el.dataset.mid);
    openDialog({
      title: `Submit milestone ${m.number}`,
      intro: 'Describe what you delivered against each check. Links help the client verify it. The AI will compare your note with the checks.',
      submitLabel: 'Submit work',
      body: html`
        <div class="dialog-checks"><p>Done when:</p><ul>${m.acceptanceCriteria.map((c) => html`<li>${c}</li>`)}</ul></div>
        <label class="field"><span>Delivery note</span><textarea name="note" rows="5" required minlength="10" maxlength="2000"></textarea></label>
        <label class="field"><span>Links, one per line</span><textarea name="links" rows="2" placeholder="https://"></textarea></label>`,
      onSubmit: async (data) => {
        const { agreement } = await api.submit(state.agreement.id, m.id, data.get('note'), lines(data.get('links')));
        setAgreement(agreement);
        render();
        toast('Work submitted. The client has been asked to review it.', 'success');
      },
    });
  },

  async review(el) {
    await withBusy(`review:${el.dataset.mid}`, async () => {
      setAgreement((await api.review(state.agreement.id, el.dataset.mid, state.role)).agreement);
    });
  },

  async approve(el) {
    const m = milestoneOf(el.dataset.mid);
    await withBusy(`approve:${m.id}`, async () => {
      setAgreement((await api.approve(state.agreement.id, m.id)).agreement);
      toast(m.money === 'held' ? `Approved. ${m.amount} was released to the freelancer through PayPal.` : 'Approved. The freelancer can now send a PayPal invoice.', 'success');
    });
  },

  'request-changes'(el) {
    const m = milestoneOf(el.dataset.mid);
    openDialog({
      title: 'Ask for changes',
      intro: 'Point to the check that is not met yet. Any money on hold stays on hold.',
      submitLabel: 'Send request',
      body: html`<label class="field"><span>What needs to change</span><textarea name="note" rows="4" required minlength="5" maxlength="600"></textarea></label>`,
      onSubmit: async (data) => {
        setAgreement((await api.requestChanges(state.agreement.id, m.id, data.get('note'))).agreement);
        render();
        toast('Change request sent.', 'success');
      },
    });
  },

  cancel(el) {
    const m = milestoneOf(el.dataset.mid);
    openDialog({
      title: `Cancel milestone ${m.number}?`,
      intro: m.money === 'held' ? `The PayPal hold of ${m.amount} will be voided, so you are not charged. This cannot be undone.` : 'This cannot be undone.',
      submitLabel: 'Cancel milestone',
      danger: true,
      body: '',
      onSubmit: async () => {
        setAgreement((await api.cancel(state.agreement.id, m.id)).agreement);
        render();
        toast(m.money === 'held' ? 'Milestone cancelled and the hold voided.' : 'Milestone cancelled.', 'success');
      },
    });
  },

  invoice(el) {
    const m = milestoneOf(el.dataset.mid);
    const email = state.agreement.parties.clientEmail;
    openDialog({
      title: `Invoice milestone ${m.number}`,
      intro: email ? `PayPal emails the invoice for ${m.amount} to ${email}.` : `No client email is set, so PayPal issues the invoice and you get a link to share. Add the client’s email below the milestones to have PayPal send it.`,
      submitLabel: 'Send invoice',
      body: html`<label class="field"><span>Note on the invoice</span><textarea name="note" rows="3" maxlength="600">Thank you! This invoice covers milestone ${m.number}, ${m.title}, which you approved.</textarea></label>`,
      onSubmit: async (data) => {
        setAgreement((await api.invoice(state.agreement.id, m.id, data.get('note'))).agreement);
        render();
        toast('Invoice sent through PayPal.', 'success');
      },
    });
  },

  async sync(el) {
    await withBusy(`sync:${el.dataset.mid}`, async () => {
      setAgreement((await api.sync(state.agreement.id, el.dataset.mid, state.role)).agreement);
      toast('Updated from PayPal.');
    });
  },

  async ask(el) {
    await sendToAgent(el.dataset.text);
  },

  async approval(el) {
    const { approval: id, decision } = el.dataset;
    await withBusy(`approval:${id}`, async () => {
      setAgreement((await api.decide(state.agreement.id, id, decision, state.role)).agreement);
      toast(decision === 'approve' ? 'Done. PayPal processed the approved action.' : 'Declined. Nothing was changed in PayPal.', decision === 'approve' ? 'success' : 'info');
    });
  },

  delete() {
    const a = state.agreement;
    openDialog({
      title: 'Delete this agreement?',
      intro: `“${a.title}” and its history will be removed from this browser’s workspace. Payments already made in PayPal are not affected.`,
      submitLabel: 'Delete',
      danger: true,
      body: '',
      onSubmit: async () => {
        await api.remove(a.id);
        state.list = state.list.filter((x) => x.id !== a.id);
        location.hash = '#/';
      },
    });
  },
};

async function sendToAgent(message) {
  const text = message.trim();
  if (!text) return;
  state.agentDraft = '';
  await withBusy('agent', async () => {
    setAgreement((await api.agent(state.agreement.id, state.role, text)).agreement);
  });
  $('#agent-input')?.focus();
}

const forms = {
  async create(form) {
    const text = form.elements.text.value.trim();
    if (text.length < 30) {
      toast('Describe the deal in a sentence or two: what is delivered and for how much.', 'error');
      return;
    }
    const started = Date.now();
    const timer = setInterval(() => {
      const el = document.getElementById('analyzing-time');
      if (el) el.textContent = `Working for ${Math.round((Date.now() - started) / 1000)} seconds. This usually takes under a minute.`;
    }, 1000);
    try {
      await withBusy('create', async () => {
        const { agreement } = await api.create(text, state.role);
        state.draftText = '';
        setAgreement(agreement);
        location.hash = `#/a/${agreement.id}`;
      });
    } finally {
      clearInterval(timer);
    }
  },

  async clarify() {
    const answers = Object.entries(state.answers)
      .filter(([gapId, answer]) => answer.trim() && state.agreement.gaps.some((g) => g.id === gapId))
      .map(([gapId, answer]) => ({ gapId, answer }));
    if (!answers.length) {
      toast('Answer at least one question first.', 'error');
      return;
    }
    await withBusy('clarify', async () => {
      const before = state.agreement.clarity.score;
      const { agreement } = await api.clarify(state.agreement.id, state.role, answers);
      state.answers = {};
      setAgreement(agreement);
      toast(`Agreement updated. Clarity ${before} → ${agreement.clarity.score}.`, 'success');
    });
  },

  async 'client-email'(form) {
    await withBusy('email', async () => {
      setAgreement((await api.update(state.agreement.id, state.role, { clientEmail: form.elements.clientEmail.value.trim() })).agreement);
      toast('Email saved.', 'success');
    });
  },

  async agent(form) {
    await sendToAgent(form.elements.message.value);
  },
};

// ---------- Wiring ----------

function closeSidebar() {
  document.body.classList.remove('sidebar-open');
  $('#menu-button')?.setAttribute('aria-expanded', 'false');
}

function bindEvents() {
  document.addEventListener('click', (event) => {
    const el = event.target.closest('[data-action]');
    if (el && actions[el.dataset.action]) {
      event.preventDefault();
      actions[el.dataset.action](el);
      return;
    }
    const roleButton = event.target.closest('[data-role]');
    if (roleButton) {
      state.role = roleButton.dataset.role;
      try { localStorage.setItem(ROLE_KEY, state.role); } catch { /* storage unavailable */ }
      state.funding = null;
      if (state.agreement) {
        api.get(state.agreement.id, state.role).then(({ agreement }) => { setAgreement(agreement); render(); }).catch(toastError);
      }
      render();
      toast(`Now viewing as the ${state.role}.`);
    }
    if (event.target.closest('#menu-button')) {
      const open = document.body.classList.toggle('sidebar-open');
      $('#menu-button').setAttribute('aria-expanded', String(open));
    }
    if (event.target.closest('[data-nav]')) closeSidebar();
  });

  document.addEventListener('submit', (event) => {
    const form = event.target.closest('[data-form]');
    if (!form || !forms[form.dataset.form]) return;
    event.preventDefault();
    forms[form.dataset.form](form);
  });

  // Keep typed text across re-renders.
  document.addEventListener('input', (event) => {
    const el = event.target;
    if (el.dataset.draft === 'text') state.draftText = el.value;
    if (el.dataset.draft === 'agent') state.agentDraft = el.value;
    if (el.dataset.draft === 'answer') state.answers[el.dataset.gap] = el.value;
  });

  // Remember which milestone cards are open.
  document.addEventListener('toggle', (event) => {
    const card = event.target;
    if (!card.matches?.('.station-card')) return;
    if (card.open) state.expanded.add(card.dataset.mid);
    else state.expanded.delete(card.dataset.mid);
  }, true);

  window.addEventListener('hashchange', onRoute);
}

async function boot() {
  bindEvents();
  try {
    state.config = await api.config();
  } catch (error) {
    $('#main').innerHTML = `<p class="notice notice-warn">${error.message}</p>`;
    return;
  }
  $('#env-pill').textContent = state.config.paypal.env === 'live' ? 'PayPal live' : 'PayPal sandbox';
  await refreshList();
  await onRoute();
}

boot();