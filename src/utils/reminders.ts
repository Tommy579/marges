import {
  STORAGE_KEYS,
  savePersistentJSON,
  loadPersistentJSON,
  type ReminderScheduleConfig,
  type NotificationLogItem,
} from './persistence';
import {
  getCurrentSession,
  fetchUserReminders,
  createUserReminder,
  deleteUserReminder,
  getUserCoursesImmediate,
  type DbReminder,
} from './supabase';
import { toastAlert } from './toast';

export const DEFAULT_REMINDERS_CONFIG: ReminderScheduleConfig = {
  enabled: true,
  frequency: 'daily',
  times: ['09:00'],
  weekday: 1,
  contentType: 'all',
};

const FIRED_SLOTS_STORAGE_KEY = 'marges_fired_reminder_slots_v1';
const DAY_NAMES = ['', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];

function getBasePath(): string {
  const raw = (typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL) || '/marges/';
  return raw.replace(/\/$/, '');
}

export function formatFrequencyLabel(config: ReminderScheduleConfig): string {
  if (!config.enabled) return 'Désactivé';
  if (config.frequency === 'daily') return 'Quotidienne (chaque jour)';
  if (config.frequency === 'twice_daily') return 'Deux fois par jour (Matin & Soir)';
  if (config.frequency === 'weekly') {
    const day = DAY_NAMES[config.weekday || 1] || 'Lundi';
    return `Hebdomadaire (Chaque ${day})`;
  }
  return 'Quotidienne';
}

export function formatTimesLabel(config: ReminderScheduleConfig): string {
  if (!config.enabled) return 'Aucun horaire';
  if (config.times && config.times.length > 0) {
    return config.times.join(' & ');
  }
  return '09:00';
}

export function formatContentLabel(config: ReminderScheduleConfig): string {
  if (config.contentType === 'philo') return 'Textes de philosophie uniquement';
  if (config.contentType === 'cours') return 'Supports de cours uniquement';
  return 'Aléatoire (Textes philo & Cours)';
}

/**
 * Formatage déterministe HH:MM indépendant de la locale du système ou du navigateur.
 */
export function formatDeterministicHHMM(date: Date): string {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * Clé de date locale YYYY-MM-DD.
 */
export function getLocalDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function loadFiredSlotsForDay(dateKey: string): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(FIRED_SLOTS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.date === dateKey && parsed.slots) {
      return parsed.slots;
    }
  } catch {}
  return {};
}

function markSlotFiredForDay(dateKey: string, slotId: string): void {
  try {
    const current = loadFiredSlotsForDay(dateKey);
    current[slotId] = true;
    localStorage.setItem(
      FIRED_SLOTS_STORAGE_KEY,
      JSON.stringify({ date: dateKey, slots: current })
    );
  } catch {}
}

/**
 * Détection multi-appareils / multi-navigateurs (iOS, iPadOS, PWA, Android, Desktop).
 */
export function isIosDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const isIOS = /iPad|iPhone|iPod/.test(ua);
  const isIPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return isIOS || isIPadOS;
}

export function isStandalonePwa(): boolean {
  if (typeof window === 'undefined') return false;
  const mqStandalone = window.matchMedia?.('(display-mode: standalone)')?.matches;
  const navStandalone = (navigator as any).standalone === true;
  return Boolean(mqStandalone || navStandalone);
}

export function isIosNonStandalone(): boolean {
  return isIosDevice() && !isStandalonePwa();
}

export function isNotificationSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window && typeof Notification.permission === 'string';
}

export type CrossPlatformPermissionState =
  | 'granted'
  | 'denied'
  | 'default'
  | 'ios-pwa-required'
  | 'unsupported';

export function getNotificationPermissionState(): CrossPlatformPermissionState {
  if (typeof window === 'undefined') return 'unsupported';
  if (!isNotificationSupported()) {
    if (isIosNonStandalone()) return 'ios-pwa-required';
    return 'unsupported';
  }
  return Notification.permission as CrossPlatformPermissionState;
}

export function formatPermissionStatusLabel(): {
  state: CrossPlatformPermissionState;
  label: string;
  canRequest: boolean;
} {
  const state = getNotificationPermissionState();
  switch (state) {
    case 'granted':
      return {
        state,
        label: 'Notifications système actives (et alertes intégrées activées)',
        canRequest: false,
      };
    case 'denied':
      return {
        state,
        label: 'Notifications système bloquées dans le navigateur (alertes intégrées actives sur le site)',
        canRequest: false,
      };
    case 'ios-pwa-required':
      return {
        state,
        label:
          'Sur iPhone et iPad, ajoutez Marges sur l’écran d’accueil (Partager → Sur l’écran d’accueil) pour les notifications iOS. Les alertes intégrées restent actives.',
        canRequest: false,
      };
    case 'unsupported':
      return {
        state,
        label: 'Notifications système non disponibles sur ce navigateur (alertes intégrées actives sur le site)',
        canRequest: false,
      };
    default:
      return {
        state: 'default',
        label: 'En attente d’autorisation (alertes intégrées déjà actives)',
        canRequest: true,
      };
  }
}

let swRegistrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;

/**
 * Enregistre le Service Worker requis par Android (Chrome, Firefox, Samsung, Brave)
 * et iOS/iPadOS Web App pour afficher des notifications système.
 */
export function registerNotificationServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return Promise.resolve(null);
  }
  if (!swRegistrationPromise) {
    const base = getBasePath();
    const swUrl = `${base}/sw.js`;
    const scope = `${base}/`;
    swRegistrationPromise = navigator.serviceWorker
      .register(swUrl, { scope })
      .catch((err) => {
        console.warn('[RemindersSW] Échec enregistrement Service Worker:', err);
        return null;
      });
  }
  return swRegistrationPromise;
}

/**
 * Demande la permission de notification en supportant à la fois l'API Promise moderne
 * et l'ancienne API à callback de Safari/WebKit.
 */
export async function requestNotificationPermission(): Promise<CrossPlatformPermissionState> {
  if (!isNotificationSupported()) {
    return getNotificationPermissionState();
  }

  try {
    let result: NotificationPermission = 'default';
    const req = Notification.requestPermission as unknown as (
      cb?: (perm: NotificationPermission) => void
    ) => Promise<NotificationPermission> | undefined;

    if (req.length > 0) {
      result = await new Promise<NotificationPermission>((resolve) => {
        const maybePromise = req((perm) => resolve(perm));
        if (maybePromise && typeof maybePromise.then === 'function') {
          maybePromise.then(resolve).catch(() => resolve(Notification.permission));
        }
      });
    } else {
      const maybePromise = req();
      if (maybePromise && typeof maybePromise.then === 'function') {
        result = await maybePromise;
      } else {
        result = Notification.permission;
      }
    }

    if (result === 'granted') {
      await registerNotificationServiceWorker();
    }
  } catch (err) {
    console.warn('[Reminders] Erreur demande permission:', err);
  }

  return getNotificationPermissionState();
}

export interface SendNotificationPayload {
  title: string;
  body: string;
  url: string;
  type: 'philo' | 'cours';
  historyTitle?: string;
  tag?: string;
}

/**
 * Envoie une notification sur tous les appareils et navigateurs :
 * 1. Enregistre dans l'historique persistant et notifie l'UI en direct.
 * 2. Affiche une carte d'alerte interactive dans l'interface (garantit 100 % de réception quand l'application est ouverte, même sur iOS Safari ou sans permission OS).
 * 3. Déclenche une notification système via le Service Worker (requis sur Android et PWA mobile) avec repli sur `new Notification()` pour les navigateurs desktop.
 */
export async function sendCrossPlatformNotification(payload: SendNotificationPayload): Promise<void> {
  const base = getBasePath();
  const normalizedUrl = payload.url.startsWith('/') && !payload.url.startsWith(base + '/')
    ? `${base}${payload.url}`
    : payload.url;

  const entry: NotificationLogItem = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: Date.now(),
    title: payload.historyTitle || payload.title,
    type: payload.type,
    url: normalizedUrl,
  };

  const history = loadPersistentJSON<NotificationLogItem[]>(STORAGE_KEYS.NOTIFICATIONS_HISTORY, []);
  history.unshift(entry);
  savePersistentJSON(STORAGE_KEYS.NOTIFICATIONS_HISTORY, history.slice(0, 50));

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('marges:notification-sent', { detail: entry }));
  }

  // Alerte visuelle interactive dans l'application
  toastAlert({
    title: payload.title,
    body: payload.body,
    url: normalizedUrl,
    actionLabel: 'Consulter',
  });

  // Notification système OS (Desktop, Android, iOS PWA)
  if (!isNotificationSupported() || Notification.permission !== 'granted') {
    return;
  }

  const iconUrl = `${base}/icon-192.png`;
  const badgeUrl = `${base}/favicon-32x32.png`;
  const tag = payload.tag || `marges-reminder-${Date.now()}`;

  let deliveredViaSw = false;

  if ('serviceWorker' in navigator) {
    try {
      const reg = (await registerNotificationServiceWorker()) || (await navigator.serviceWorker.getRegistration());
      if (reg && typeof reg.showNotification === 'function') {
        await reg.showNotification(payload.title, {
          body: payload.body,
          icon: iconUrl,
          badge: badgeUrl,
          tag,
          data: { url: normalizedUrl },
        });
        deliveredViaSw = true;
      }
    } catch (swErr) {
      console.warn('[Reminders] Repli sur Notification directe après erreur SW:', swErr);
    }
  }

  if (!deliveredViaSw) {
    try {
      const notif = new Notification(payload.title, {
        body: payload.body,
        icon: iconUrl,
        tag,
      });
      notif.onclick = () => {
        window.focus();
        window.location.href = normalizedUrl;
      };
    } catch (directErr) {
      console.warn('[Reminders] Constructeur Notification direct non supporté sur cet appareil:', directErr);
    }
  }
}

/**
 * Récupère la configuration synchronisée (Supabase + localStorage).
 */
export async function getUnifiedReminderConfig(): Promise<ReminderScheduleConfig> {
  let localConfig = loadPersistentJSON<ReminderScheduleConfig>(
    STORAGE_KEYS.REMINDERS_CONFIG,
    DEFAULT_REMINDERS_CONFIG
  );

  // Normalisation des champs historiques
  if (localConfig.contentPreference && !localConfig.contentType) {
    localConfig.contentType = localConfig.contentPreference === 'random' ? 'all' : localConfig.contentPreference;
  }
  if (localConfig.weekDay && !localConfig.weekday) {
    localConfig.weekday = localConfig.weekDay;
  }

  try {
    const session = await getCurrentSession();
    if (session && session.user) {
      const dbReminders = await fetchUserReminders();
      const autoReminders = dbReminders.filter((r) => r.label?.startsWith('[Auto]'));
      if (autoReminders.length > 0) {
        const enabled = autoReminders.some((r) => r.enabled);
        const sorted = [...autoReminders].sort((a, b) => a.time_of_day.localeCompare(b.time_of_day));
        const times = sorted.map((r) => r.time_of_day.slice(0, 5));
        const first = sorted[0];

        let frequency: 'daily' | 'twice_daily' | 'weekly' = 'daily';
        let weekday = 1;

        if (sorted.length >= 2) {
          frequency = 'twice_daily';
        } else if (first.days_of_week && first.days_of_week.length === 1) {
          frequency = 'weekly';
          weekday = first.days_of_week[0];
        }

        let contentType: 'all' | 'philo' | 'cours' = 'all';
        if (first.kind === 'texte') contentType = 'philo';
        else if (first.kind === 'cours') contentType = 'cours';

        localConfig = {
          enabled,
          frequency,
          times: times.length > 0 ? times : ['09:00'],
          weekday,
          contentType,
        };
        savePersistentJSON(STORAGE_KEYS.REMINDERS_CONFIG, localConfig);
      }
    }
  } catch (err) {
    console.warn('[RemindersSync] Erreur chargement Supabase:', err);
  }

  return localConfig;
}

/**
 * Sauvegarde la configuration dans localStorage ET synchronise dans Supabase.
 */
export async function saveUnifiedReminderConfig(config: ReminderScheduleConfig): Promise<void> {
  savePersistentJSON(STORAGE_KEYS.REMINDERS_CONFIG, config);

  // Marquer les créneaux déjà passés aujourd'hui pour éviter un déclenchement rétroactif immédiat lors d'un changement de réglage
  const now = new Date();
  const todayKey = getLocalDateKey(now);
  const currentHHMM = formatDeterministicHHMM(now);
  for (const t of config.times || []) {
    if (t < currentHHMM) {
      markSlotFiredForDay(todayKey, `auto:${t}`);
    }
  }

  try {
    const session = await getCurrentSession();
    if (!session || !session.user) return;

    const existing = await fetchUserReminders();
    const autoExisting = existing.filter((r) => r.label?.startsWith('[Auto]'));
    for (const r of autoExisting) {
      if (r.id) await deleteUserReminder(r.id);
    }

    if (!config.enabled) return;

    const kind = config.contentType === 'philo' ? 'texte' : (config.contentType === 'cours' ? 'cours' : 'libre');
    const daysOfWeek = config.frequency === 'weekly' ? [config.weekday || 1] : [1, 2, 3, 4, 5, 6, 7];

    if (config.frequency === 'twice_daily') {
      const t1 = config.times[0] || '09:00';
      const t2 = config.times[1] || '18:30';
      await createUserReminder({
        kind,
        label: '[Auto] Rappel quotidien (matin)',
        time_of_day: t1.length === 5 ? `${t1}:00` : t1,
        days_of_week: daysOfWeek,
        enabled: true,
      });
      await createUserReminder({
        kind,
        label: '[Auto] Rappel quotidien (soir)',
        time_of_day: t2.length === 5 ? `${t2}:00` : t2,
        days_of_week: daysOfWeek,
        enabled: true,
      });
    } else {
      const t1 = config.times[0] || '09:00';
      await createUserReminder({
        kind,
        label: config.frequency === 'weekly' ? '[Auto] Rappel hebdomadaire' : '[Auto] Rappel quotidien',
        time_of_day: t1.length === 5 ? `${t1}:00` : t1,
        days_of_week: daysOfWeek,
        enabled: true,
      });
    }
  } catch (err) {
    console.warn('[RemindersSync] Erreur sauvegarde Supabase:', err);
  }
}

/**
 * Sélectionne un contenu de révision ou de lecture pour un rappel automatique
 * même lorsque l'utilisateur navigue sur une autre page que /rappels/.
 */
function pickFallbackContent(contentType: 'all' | 'philo' | 'cours' = 'all'): {
  type: 'philo' | 'cours';
  title: string;
  body: string;
  historyTitle: string;
  url: string;
} {
  const base = getBasePath();
  const userCourses = getUserCoursesImmediate();

  const pickPhilo =
    contentType === 'philo'
      ? true
      : contentType === 'cours'
        ? false
        : userCourses.length > 0
          ? Math.random() < 0.5
          : true;

  if (!pickPhilo && userCourses.length > 0) {
    const c = userCourses[Math.floor(Math.random() * userCourses.length)];
    let subject = c.title;
    if (c.tags && c.tags.length > 0) {
      const clean = c.tags.filter((t) => t !== 'Université' && t !== 'Dossier importé' && t !== 'Matière');
      if (clean.length > 0) subject = clean[0];
    }
    const slugId = subject
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    return {
      type: 'cours',
      title: `Révision de cours : ${c.title}`,
      body: `Matière : ${subject}`,
      historyTitle: c.title,
      url: `${base}/cours/#folder-${slugId}`,
    };
  }

  if (contentType === 'cours') {
    return {
      type: 'cours',
      title: 'Révision de cours programmée',
      body: 'Ouvrez votre bibliothèque de cours et fiches de révision.',
      historyTitle: 'Bibliothèque de cours',
      url: `${base}/cours/`,
    };
  }

  return {
    type: 'philo',
    title: 'Lecture philosophique programmée',
    body: 'Prenez quelques minutes pour lire un essai ou un fragment dans Marges.',
    historyTitle: 'Lecture philosophique',
    url: `${base}/textes/`,
  };
}

let watcherInitialized = false;
let cachedManualReminders: DbReminder[] = [];
let lastManualFetchAt = 0;

async function refreshManualRemindersCache(): Promise<void> {
  const nowMs = Date.now();
  if (nowMs - lastManualFetchAt < 60_000) return;
  lastManualFetchAt = nowMs;
  try {
    const session = await getCurrentSession();
    if (session && session.user) {
      const all = await fetchUserReminders();
      cachedManualReminders = all.filter((r) => r.enabled && !r.label?.startsWith('[Auto]'));
    }
  } catch {}
}

/**
 * Vérifie les rappels dus (programme unifié + rappels individuels Supabase).
 * Supporte le rattrapage dans une fenêtre de 2 heures si l'onglet était en veille
 * ou ralenti en arrière-plan par le navigateur mobile/desktop.
 */
export async function checkDueRemindersNow(): Promise<void> {
  if (typeof window === 'undefined') return;

  const now = new Date();
  const todayKey = getLocalDateKey(now);
  const currentHHMM = formatDeterministicHHMM(now);
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const isoDay = now.getDay() === 0 ? 7 : now.getDay();
  const firedSlots = loadFiredSlotsForDay(todayKey);

  function isSlotDue(slotTimeHHMM: string, slotId: string): boolean {
    if (firedSlots[slotId]) return false;
    const parts = slotTimeHHMM.split(':');
    if (parts.length < 2) return false;
    const slotMin = parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
    if (Number.isNaN(slotMin)) return false;
    // Déclenche à l'heure exacte ou rattrape jusqu'à 120 minutes après si l'appareil était en veille
    return currentMinutes >= slotMin && currentMinutes - slotMin <= 120;
  }

  // 1. Programme récurrent unifié
  const config = loadPersistentJSON<ReminderScheduleConfig>(
    STORAGE_KEYS.REMINDERS_CONFIG,
    DEFAULT_REMINDERS_CONFIG
  );

  if (config.enabled) {
    const dayMatches = config.frequency !== 'weekly' || (config.weekday || 1) === isoDay;
    if (dayMatches && Array.isArray(config.times)) {
      for (const rawTime of config.times) {
        const slotTime = rawTime.slice(0, 5);
        const slotId = `auto:${slotTime}`;
        if (isSlotDue(slotTime, slotId)) {
          markSlotFiredForDay(todayKey, slotId);
          // Si la page /rappels/ est ouverte avec son propre sélecteur enrichi, elle écoute l'événement
          const customHandled = !window.dispatchEvent(
            new CustomEvent('marges:trigger-scheduled-reminder', { cancelable: true })
          );
          if (!customHandled) {
            const item = pickFallbackContent(config.contentType || 'all');
            await sendCrossPlatformNotification({
              title: item.title,
              body: item.body,
              historyTitle: item.historyTitle,
              type: item.type,
              url: item.url,
              tag: `marges-${todayKey}-${slotId}`,
            });
          }
        }
      }
    }
  }

  // 2. Rappels individuels enregistrés dans Supabase (hors [Auto])
  await refreshManualRemindersCache();
  const base = getBasePath();

  for (const rem of cachedManualReminders) {
    if (!rem.enabled) continue;
    if (Array.isArray(rem.days_of_week) && rem.days_of_week.length > 0 && !rem.days_of_week.includes(isoDay)) {
      continue;
    }
    const slotTime = (rem.time_of_day || '').slice(0, 5);
    const slotId = `db:${rem.id || rem.label}:${slotTime}`;
    if (isSlotDue(slotTime, slotId)) {
      markSlotFiredForDay(todayKey, slotId);
      const isCours = rem.kind === 'cours';
      const targetUrl = rem.target_path
        ? (rem.target_path.startsWith('http') ? rem.target_path : `${base}/${rem.target_path.replace(/^\/+/, '')}`)
        : (isCours ? `${base}/cours/` : `${base}/textes/`);
      await sendCrossPlatformNotification({
        title: rem.label || (isCours ? 'Rappel de cours' : 'Rappel de lecture'),
        body: `Rappel programmé à ${slotTime}`,
        historyTitle: rem.label || 'Rappel programmé',
        type: isCours ? 'cours' : 'philo',
        url: targetUrl,
        tag: `marges-${todayKey}-${slotId}`,
      });
    }
  }
}

/**
 * Démarre la surveillance globale des rappels sur toutes les pages du site.
 */
export function startGlobalReminderWatcher(): void {
  if (typeof window === 'undefined' || watcherInitialized) return;
  watcherInitialized = true;

  // Enregistre le Service Worker dès l'ouverture si les notifications sont supportées
  registerNotificationServiceWorker().catch(() => {});

  // Synchronise la configuration depuis Supabase en tâche de fond puis vérifie
  getUnifiedReminderConfig()
    .then(() => checkDueRemindersNow())
    .catch(() => checkDueRemindersNow());

  // Vérification périodique toutes les 20 secondes
  window.setInterval(() => {
    checkDueRemindersNow().catch(() => {});
  }, 20_000);

  // Rattrapage immédiat à la sortie de veille ou au retour sur l'onglet (mobile & desktop)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      checkDueRemindersNow().catch(() => {});
    }
  });

  window.addEventListener('focus', () => {
    checkDueRemindersNow().catch(() => {});
  });

  window.addEventListener('pageshow', () => {
    checkDueRemindersNow().catch(() => {});
  });
}
