/**
 * Notifications éphémères non bloquantes (remplacent `alert()`).
 * La zone est (re)créée à la demande : compatible avec les View Transitions d'Astro.
 */
export type ToastTone = 'success' | 'error' | 'info';

function getOrCreateToastRegion(): HTMLElement {
  let region = document.getElementById('toast-region');
  if (!region) {
    region = document.createElement('div');
    region.id = 'toast-region';
    region.className = 'toast-region';
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
    document.body.appendChild(region);
  }
  return region;
}

export function toast(message: string, tone: ToastTone = 'success', duration = 3200): void {
  const region = getOrCreateToastRegion();

  const el = document.createElement('div');
  el.className = `toast toast--${tone}`;
  el.textContent = message;
  region.appendChild(el);

  window.setTimeout(() => {
    el.classList.add('is-leaving');
    window.setTimeout(() => el.remove(), 220);
  }, duration);
}

export interface ToastAlertOptions {
  title: string;
  body?: string;
  url?: string;
  actionLabel?: string;
  duration?: number;
}

/**
 * Carte d'alerte enrichie intégrée à l'interface (garantit l'affichage des rappels
 * sur tous les navigateurs, y compris iOS Safari hors PWA ou lorsque les notifications
 * système sont refusées).
 */
export function toastAlert(options: ToastAlertOptions): void {
  const region = getOrCreateToastRegion();
  const duration = options.duration ?? 9000;

  const el = document.createElement('div');
  el.className = 'toast toast--info toast--alert';

  const content = document.createElement('div');
  content.className = 'toast-alert-body';

  const titleEl = document.createElement('strong');
  titleEl.className = 'toast-alert-title';
  titleEl.textContent = options.title;
  content.appendChild(titleEl);

  if (options.body) {
    const descEl = document.createElement('p');
    descEl.className = 'toast-alert-desc';
    descEl.textContent = options.body;
    content.appendChild(descEl);
  }

  if (options.url) {
    const actionsEl = document.createElement('div');
    actionsEl.className = 'toast-alert-actions';

    const link = document.createElement('a');
    link.href = options.url;
    link.className = 'toast-alert-link';
    link.textContent = `${options.actionLabel || 'Consulter'} →`;
    actionsEl.appendChild(link);

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'toast-alert-dismiss';
    dismiss.textContent = 'Fermer';
    dismiss.addEventListener('click', () => {
      el.classList.add('is-leaving');
      window.setTimeout(() => el.remove(), 220);
    });
    actionsEl.appendChild(dismiss);

    content.appendChild(actionsEl);
  }

  el.appendChild(content);
  region.appendChild(el);

  window.setTimeout(() => {
    if (!el.isConnected) return;
    el.classList.add('is-leaving');
    window.setTimeout(() => el.remove(), 220);
  }, duration);
}
