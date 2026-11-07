// Safe templating: every interpolated value is escaped unless wrapped in raw().
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

class Raw {
  constructor(value) { this.value = value; }
  toString() { return this.value; }
}
export const raw = (value) => new Raw(value);

function render(value) {
  if (value == null || value === false) return '';
  if (value instanceof Raw) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  return esc(value);
}

export function html(strings, ...values) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) out += render(values[i]);
  });
  return raw(out);
}

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
export const shortDate = (iso) => (iso ? dateFmt.format(new Date(iso)) : '');

export function when(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  const minutes = Math.round((Date.now() - date) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (date.toDateString() === new Date().toDateString()) return `today, ${timeFmt.format(date)}`;
  return `${dateFmt.format(date)}, ${timeFmt.format(date)}`;
}

// ---------- Toasts ----------

export function toast(message, kind = 'info', { detail } = {}) {
  const host = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.innerHTML = `<p>${esc(message)}</p>${detail ? `<p class="toast-detail">${esc(detail)}</p>` : ''}<button type="button" class="toast-close" aria-label="Dismiss">×</button>`;
  el.querySelector('button').addEventListener('click', () => el.remove());
  host.append(el);
  while (host.children.length > 3) host.firstElementChild.remove();
  setTimeout(() => el.remove(), kind === 'error' ? 9000 : 5000);
}

export function toastError(error) {
  toast(error.message || 'Something went wrong.', 'error', { detail: error.debugId ? `PayPal debug id: ${error.debugId}` : undefined });
}

// ---------- Dialogs ----------

/**
 * Opens the shared <dialog> with a form. onSubmit receives FormData and may
 * throw; the error is shown inside the dialog and it stays open.
 */
export function openDialog({ title, intro, body, submitLabel, danger = false, onSubmit }) {
  const dialog = document.getElementById('dialog');
  dialog.innerHTML = html`
    <form class="dialog-form" method="dialog" novalidate>
      <header class="dialog-head">
        <h2 id="dialog-title">${title}</h2>
        <button type="button" class="icon-button" data-close aria-label="Close">×</button>
      </header>
      ${intro ? html`<p class="dialog-intro">${intro}</p>` : ''}
      <div class="dialog-body">${body}</div>
      <p class="dialog-error" role="alert" hidden></p>
      <footer class="dialog-foot">
        <button type="button" class="button button-quiet" data-close>Cancel</button>
        <button type="submit" class="button ${danger ? 'button-danger' : 'button-primary'}">${submitLabel}</button>
      </footer>
    </form>`.value;
  dialog.setAttribute('aria-labelledby', 'dialog-title');
  const form = dialog.querySelector('form');
  const error = dialog.querySelector('.dialog-error');
  const submit = form.querySelector('[type="submit"]');
  dialog.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dialog.close()));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.hidden = true;
    submit.disabled = true;
    submit.dataset.busy = 'true';
    try {
      await onSubmit(new FormData(form));
      dialog.close();
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    } finally {
      submit.disabled = false;
      delete submit.dataset.busy;
    }
  });
  dialog.showModal();
  dialog.querySelector('input, textarea')?.focus();
}

export const lines = (text) => String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
