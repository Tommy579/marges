import { createClient, type SupabaseClient, type User, type Session } from '@supabase/supabase-js';
import { STORAGE_KEYS, deleteCookie } from './persistence';

// Clés officielles du projet Supabase Marges
export const DEFAULT_SUPABASE_CONFIG = {
  URL: 'https://aejqzkoyxhzxavprgyxd.supabase.co',
  ANON_KEY: 'sb_publishable_64uddUzZQyNVozlAS7ZYAg_mwl9Hci-',
};

const STORAGE_KEY_URL = 'marges_supabase_url';
const STORAGE_KEY_ANON = 'marges_supabase_anon_key';

export function getSupabaseCredentials(): { url: string; anonKey: string; isConfigured: boolean } {
  if (typeof window === 'undefined') {
    return { url: DEFAULT_SUPABASE_CONFIG.URL, anonKey: DEFAULT_SUPABASE_CONFIG.ANON_KEY, isConfigured: true };
  }

  let storedUrl = localStorage.getItem(STORAGE_KEY_URL);
  let storedKey = localStorage.getItem(STORAGE_KEY_ANON);

  // Nettoyage automatique des valeurs factices ou obsolètes restées dans le navigateur
  if (storedUrl && (storedUrl.includes('xxxx.supabase.co') || storedUrl.includes('votre-projet') || !storedUrl.startsWith('http'))) {
    localStorage.removeItem(STORAGE_KEY_URL);
    storedUrl = null;
  }
  if (storedKey && (storedKey.includes('dummy') || storedKey.length < 15)) {
    localStorage.removeItem(STORAGE_KEY_ANON);
    storedKey = null;
  }

  const rawUrl =
    storedUrl ||
    (import.meta.env.PUBLIC_SUPABASE_URL as string) ||
    (import.meta.env.SUPABASE_URL as string) ||
    DEFAULT_SUPABASE_CONFIG.URL;
  const rawKey =
    storedKey ||
    (import.meta.env.PUBLIC_SUPABASE_ANON_KEY as string) ||
    (import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY as string) ||
    (import.meta.env.SUPABASE_PUBLISHABLE_KEY as string) ||
    (import.meta.env.SUPABASE_ANON_KEY as string) ||
    DEFAULT_SUPABASE_CONFIG.ANON_KEY;

  const url = (rawUrl || DEFAULT_SUPABASE_CONFIG.URL).trim().replace(/\/+$/, '');
  const anonKey = (rawKey || DEFAULT_SUPABASE_CONFIG.ANON_KEY).trim();

  const isConfigured = Boolean(
    url &&
    !url.includes('xxxx.supabase.co') &&
    !url.includes('votre-projet') &&
    anonKey &&
    !anonKey.includes('dummy')
  );

  return { url, anonKey, isConfigured };
}

export function saveSupabaseCredentials(url: string, anonKey: string): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEY_URL, url.trim().replace(/\/+$/, ''));
  localStorage.setItem(STORAGE_KEY_ANON, anonKey.trim());
  // Réinitialiser l'instance client
  supabaseInstance = null;
}

export function resetSupabaseCredentialsToDefault(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(STORAGE_KEY_URL);
  localStorage.removeItem(STORAGE_KEY_ANON);
  supabaseInstance = null;
}

/**
 * Traduit les erreurs réseau Supabase (CORS, adblocker, domaine injoignable)
 * en explications limpides pour l'utilisateur.
 */
export function formatSupabaseError(err: any): string {
  if (!err) return 'Erreur inconnue';
  const msg = err.message || String(err);
  if (
    msg.includes('Failed to fetch') ||
    msg.includes('NetworkError') ||
    msg.includes('Load failed') ||
    msg.includes('ERR_BLOCKED_BY_CLIENT') ||
    msg.includes('ERR_CONNECTION_REFUSED')
  ) {
    const creds = getSupabaseCredentials();
    return `Impossible de joindre le serveur Supabase (${creds.url}). Causes courantes : 1) Un bloqueur de publicité ou protection de navigation (Brave Shields, uBlock Origin, Privacy Badger) bloque les requêtes vers supabase.co : désactivez-le pour ce site ; 2) Connexion Internet interrompue ; 3) Anciens identifiants corrompus en mémoire locale.`;
  }
  return msg;
}

let supabaseInstance: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  const { url, anonKey } = getSupabaseCredentials();

  // Si l'instance existe déjà mais ciblait une mauvaise URL factice, on la recrée
  if (supabaseInstance) {
    // @ts-ignore
    const cur: string = supabaseInstance.supabaseUrl || '';
    if (cur.includes('xxxx.supabase.co') || (url && !cur.startsWith(url))) {
      supabaseInstance = null;
    }
  }

  if (supabaseInstance) return supabaseInstance;

  supabaseInstance = createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });

  return supabaseInstance;
}

export const TIMETABLE_SYNC_TITLE = '__USER_TIMETABLE_ICS__';
export const SYSTEM_TAG = '__system__';

/**
 * Nettoie toutes les données privées stockées localement sur la machine (EDT, rappels, cours custom)
 * pour éviter toute contamination entre comptes utilisateurs différents sur le même navigateur.
 */
export function clearLocalUserData(): void {
  if (typeof window === 'undefined') return;
  const keysToRemove = [
    STORAGE_KEYS.TIMETABLE_ICS,
    STORAGE_KEYS.TIMETABLE_URL,
    STORAGE_KEYS.REMINDERS,
    STORAGE_KEYS.REMINDERS_CONFIG,
    STORAGE_KEYS.NOTIFICATIONS_HISTORY,
    'marges_custom_schedule_events',
    'marges_custom_subjects',
    'marges_custom_courses',
  ];
  keysToRemove.forEach((k) => {
    try {
      localStorage.removeItem(k);
      deleteCookie(k);
    } catch {}
  });

  // Nettoyage de sécurité de tous les jetons d'authentification Supabase locaux
  // et des caches de cours par compte utilisateur
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && (k.startsWith('sb-') || k.includes('-auth-token') || k.startsWith('marges_user_courses_'))) {
        localStorage.removeItem(k);
      }
    }
  } catch {}
}

// -------------------------------------------------------------
// Fonctions d'authentification
// -------------------------------------------------------------

export async function loginWithPassword(email: string, password: string): Promise<User> {
  clearLocalUserData();
  const sb = getSupabase();
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  if (!data.user) throw new Error('Aucun utilisateur renvoyé par Supabase.');

  // Appliquer immédiatement la couleur d'ambiance associée à ce compte Supabase
  const accountAmbiance = normalizeAmbianceColor(data.user.user_metadata?.ambiance_color);
  applyAmbianceToDOM(accountAmbiance);

  // Si l'utilisateur avait une ancienne sauvegarde volumineuse dans ses métadonnées, on la purge pour alléger le JWT
  if (data.user.user_metadata?.timetable_ics) {
    sb.auth.updateUser({ data: { timetable_ics: null } }).catch(() => {});
  }

  return data.user;
}

export async function logoutUser(): Promise<void> {
  clearLocalUserData();
  applyAmbianceToDOM('default');
  try {
    const sb = getSupabase();
    await sb.auth.signOut();
  } catch (err) {
    console.warn('[Supabase Logout] signOut réseau ignoré (session locale déjà vidée):', err);
  }
  supabaseInstance = null;
}

export async function getCurrentUser(): Promise<User | null> {
  const sb = getSupabase();
  try {
    const { data: { user }, error } = await sb.auth.getUser();
    if (user && !error) return user;
  } catch (err) {
    console.warn('[Supabase Auth] getUser réseau:', err);
  }

  // Si getUser a échoué (ex: token expiré ou coupure réseau), tenter un rafraîchissement
  try {
    const { data: { session }, error: refreshErr } = await sb.auth.refreshSession();
    if (session?.user && !refreshErr) return session.user;
  } catch (err) {
    console.warn('[Supabase Auth] refreshSession:', err);
  }

  // Repli transparent sur la session active persistée localement
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (session?.user) return session.user;
  } catch {}

  return null;
}

export async function getCurrentSession(): Promise<Session | null> {
  const sb = getSupabase();
  const { data: { session } } = await sb.auth.getSession();
  return session;
}

export async function updatePassword(newPassword: string): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb.auth.updateUser({ password: newPassword });
  if (error) throw error;
}

export async function updateUserProfile(metadata: { full_name?: string }): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb.auth.updateUser({ data: metadata });
  if (error) throw error;
}

// -------------------------------------------------------------
// Modèles de données Supabase (Courses, Events, Reminders)
// -------------------------------------------------------------

export interface DbCourse {
  id?: string;
  user_id?: string;
  title: string;
  body_md: string;
  tags?: string[];
  created_at?: string;
  updated_at?: string;
}

export interface DbScheduleEvent {
  id?: string;
  user_id?: string;
  title: string;
  day_of_week: number; // 1 = Lundi, 7 = Dimanche
  start_time: string;  // "08:00:00"
  end_time: string;    // "10:00:00"
  location?: string;
  notes?: string;
  created_at?: string;
}

export interface DbReminder {
  id?: string;
  user_id?: string;
  kind: 'cours' | 'texte' | 'libre';
  label?: string;
  target_slug?: string;
  time_of_day: string;
  days_of_week?: number[];
  enabled: boolean;
  created_at?: string;
}

// -------------------------------------------------------------
// Opérations CRUD sécurisées par RLS avec cache résilient par compte
// -------------------------------------------------------------

function getUserCoursesStorageKey(userId: string): string {
  return `marges_user_courses_${userId}`;
}

export function getLocalUserCourses(userId: string): DbCourse[] {
  if (typeof window === 'undefined' || !userId) return [];
  try {
    const raw = localStorage.getItem(getUserCoursesStorageKey(userId));
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export function saveLocalUserCourses(userId: string, courses: DbCourse[]): void {
  if (typeof window === 'undefined' || !userId) return;
  try {
    localStorage.setItem(getUserCoursesStorageKey(userId), JSON.stringify(courses));
  } catch (err) {
    console.warn('[Courses Cache] Erreur sauvegarde locale:', err);
    // Le cache local sert à l'affichage immédiat : s'il ne peut plus être écrit,
    // l'utilisateur voit des données périmées sans explication. On le signale
    // plutôt que de laisser un console.warn muet.
    try {
      window.dispatchEvent(new CustomEvent('marges:cache-full', { detail: { userId } }));
    } catch {}
  }
}

export function getCurrentUserCached(): User | null {
  if (typeof window === 'undefined') return null;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith('sb-') && k.endsWith('-auth-token'))) {
        const raw = localStorage.getItem(k);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed?.user?.id) return parsed.user;
          if (parsed?.currentSession?.user?.id) return parsed.currentSession.user;
        }
      }
    }
  } catch {}
  return null;
}

const DELETED_COURSES_KEY = 'marges_deleted_courses_tombstones';

export function getDeletedCourseTombstones(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(DELETED_COURSES_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.map((s: string) => String(s).toLowerCase().trim()) : []);
  } catch {
    return new Set();
  }
}

export function addDeletedCourseTombstone(idOrTitle: string): void {
  if (typeof window === 'undefined' || !idOrTitle) return;
  try {
    const set = getDeletedCourseTombstones();
    set.add(String(idOrTitle).toLowerCase().trim());
    localStorage.setItem(DELETED_COURSES_KEY, JSON.stringify(Array.from(set).slice(-500)));
  } catch {}
}

export function clearCourseTombstone(idOrTitle: string): void {
  if (typeof window === 'undefined' || !idOrTitle) return;
  try {
    const set = getDeletedCourseTombstones();
    set.delete(String(idOrTitle).toLowerCase().trim());
    localStorage.setItem(DELETED_COURSES_KEY, JSON.stringify(Array.from(set)));
  } catch {}
}

export function notifyCoursesChanged(action: 'create' | 'update' | 'delete' | 'clear', payload?: any): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(
      new CustomEvent('marges:courses-changed', {
        detail: { action, payload, timestamp: Date.now() },
      })
    );
  } catch {}
}

export async function cleanupCourseFiles(course: DbCourse, userId?: string): Promise<void> {
  if (typeof window === 'undefined' || !course) return;
  const user = getCurrentUserCached();
  const activeId = userId || user?.id || '';
  try {
    const { deleteDocumentFile } = await import('./fileStorage');

    // 1. Si le titre correspond à un fichier (ex: document.pdf, TD1.docx)
    if (course.title && course.title.includes('.')) {
      const subject = course.tags?.[0];
      const folder = course.tags?.[1];
      await deleteDocumentFile(course.title, { userId: activeId, subject, folder }).catch(() => {});
    }

    // 2. Si le corps markdown référence des fichiers dans des sous-dossiers
    if (course.body_md) {
      const lines = course.body_md.split('\n');
      let currentFolder = 'Documents';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('### ')) {
          currentFolder = trimmed.replace(/^###\s+/, '').trim();
        } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
          const raw = trimmed.replace(/^[-*]\s+/, '').trim();
          const linkMatch = raw.match(/^\[([^\]]+)\]/);
          const fileName = (linkMatch ? linkMatch[1] : raw).trim();
          if (fileName && fileName.includes('.')) {
            await deleteDocumentFile(fileName, {
              userId: activeId,
              subject: course.title,
              folder: currentFolder,
            }).catch(() => {});
          }
        }
      }
    }
  } catch (err) {
    console.warn('[Course Cleanup] Erreur suppression fichiers associés:', err);
  }
}

export function getUserCoursesImmediate(): DbCourse[] {
  if (typeof window === 'undefined') return [];
  const user = getCurrentUserCached();
  if (user?.id) {
    return getLocalUserCourses(user.id);
  }
  // Si pas de session explicite, récupérer le dernier cache de cours utilisateur valide
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith('marges_user_courses_')) {
      try {
        const raw = localStorage.getItem(k);
        if (raw) {
          const list = JSON.parse(raw);
          if (Array.isArray(list) && list.length > 0) return list;
        }
      } catch {}
    }
  }
  return [];
}

export function isValidUuid(str: any): boolean {
  return typeof str === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

export async function fetchUserCourses(): Promise<DbCourse[]> {
  const cachedUser = getCurrentUserCached();
  const user = cachedUser || (await getCurrentUser().catch(() => null));
  const activeId = user?.id;
  const localCourses = activeId ? getLocalUserCourses(activeId) : getUserCoursesImmediate();

  const remoteFetch = async (): Promise<DbCourse[]> => {
    const sb = getSupabase();
    const query = sb
      .from('courses')
      .select('*')
      .neq('title', TIMETABLE_SYNC_TITLE)
      .order('updated_at', { ascending: false });

    if (activeId) {
      query.eq('user_id', activeId);
    }

    const { data, error } = await query;
    if (error) throw error;

    const tombstones = getDeletedCourseTombstones();

    const remoteFiltered = (data || []).filter(
      (c) =>
        c.title !== TIMETABLE_SYNC_TITLE &&
        (!c.tags || !c.tags.includes(SYSTEM_TAG)) &&
        !tombstones.has((c.id || '').toLowerCase().trim()) &&
        !tombstones.has(c.title.toLowerCase().trim())
    );

    // Supprimer silencieusement sur Supabase les éléments qui étaient dans les tombstones
    (data || []).forEach((c) => {
      const isDead =
        tombstones.has((c.id || '').toLowerCase().trim()) ||
        tombstones.has(c.title.toLowerCase().trim());
      if (isDead && c.id && isValidUuid(c.id)) {
        Promise.resolve(sb.from('courses').delete().eq('id', c.id)).catch(() => {});
      }
    });

    // Synchronisation bidirectionnelle intelligente :
    if (activeId) {
      if (remoteFiltered.length > 0) {
        // La base Supabase contient des cours.
        // Vérifier si des cours créés localement (ex: hors-ligne) ne sont pas encore dans Supabase
        const remoteTitles = new Set(remoteFiltered.map((r) => r.title.toLowerCase().trim()));
        const missingRemotely = localCourses.filter(
          (l) =>
            (!l.id || !isValidUuid(l.id)) &&
            !remoteTitles.has(l.title.toLowerCase().trim()) &&
            !tombstones.has((l.id || '').toLowerCase().trim()) &&
            !tombstones.has(l.title.toLowerCase().trim())
        );

        if (missingRemotely.length > 0) {
          // Pousser les cours locaux orphelins vers Supabase en tâche de fond
          createBatchUserCourses(missingRemotely).catch((e) =>
            console.warn('[Supabase Sync] Téléversement des cours locaux non synchronisés:', e)
          );
        }

        saveLocalUserCourses(activeId, remoteFiltered);
        return remoteFiltered;
      } else {
        // Supabase est vide ou tous les cours distants ont été supprimés
        // Ne pousser les cours locaux que s'il ne s'agit pas de tombstones et que des cours existent
        const validLocal = localCourses.filter(
          (l) =>
            !tombstones.has((l.id || '').toLowerCase().trim()) &&
            !tombstones.has(l.title.toLowerCase().trim())
        );
        if (validLocal.length > 0 && tombstones.size === 0) {
          try {
            const pushed = await createBatchUserCourses(validLocal);
            if (pushed && pushed.length > 0) {
              saveLocalUserCourses(activeId, pushed);
              return pushed;
            }
          } catch (pushErr) {
            console.warn('[Supabase Sync] Échec téléversement initial des cours:', pushErr);
          }
          return validLocal;
        } else {
          saveLocalUserCourses(activeId, []);
          return [];
        }
      }
    }

    return remoteFiltered;
  };

  // Timeout généreux (8s) pour réseaux mobiles lents
  const timeout = new Promise<DbCourse[]>((_, reject) => {
    setTimeout(() => reject(new Error('Supabase network timeout')), 8000);
  });

  try {
    return await Promise.race([remoteFetch(), timeout]);
  } catch (err) {
    console.warn('[Supabase Courses] Requête réseau expirée ou indisponible, utilisation du cache immédiat:', err);
    return localCourses;
  }
}

export async function createUserCourse(course: Omit<DbCourse, 'id' | 'user_id' | 'created_at' | 'updated_at'>): Promise<DbCourse> {
  const user = getCurrentUserCached() || (await getCurrentUser().catch(() => null));
  if (!user) {
    throw new Error('Vous devez être connecté à votre compte pour enregistrer un cours.');
  }

  const now = new Date().toISOString();
  const rawId = (course as any).id;
  const hasValidId = isValidUuid(rawId);

  const newCourse: DbCourse = {
    ...course,
    id: hasValidId ? rawId : (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : undefined),
    user_id: user.id,
    created_at: now,
    updated_at: now,
  };

  clearCourseTombstone(newCourse.title);
  if (newCourse.id) clearCourseTombstone(newCourse.id);

  // Sauvegarde optimiste locale dédiée à ce compte
  const localList = getLocalUserCourses(user.id);
  const updatedList = [newCourse, ...localList.filter((c) => (newCourse.id && c.id !== newCourse.id) || c.title !== newCourse.title)];
  saveLocalUserCourses(user.id, updatedList);
  notifyCoursesChanged('create', newCourse);

  // Synchronisation distante Supabase
  try {
    const sb = getSupabase();
    const payload: any = {
      user_id: user.id,
      title: newCourse.title,
      body_md: newCourse.body_md || '',
      tags: Array.isArray(newCourse.tags) ? newCourse.tags : [],
    };
    if (newCourse.id && isValidUuid(newCourse.id)) {
      payload.id = newCourse.id;
    }

    const { data, error } = await sb
      .from('courses')
      .insert([payload])
      .select()
      .single();

    if (error) {
      console.warn('[Supabase Course] Insert distant échoué:', error);
      // Nouvelle tentative sans imposer l'UUID pour laisser Postgres gen_random_uuid()
      if (payload.id) {
        delete payload.id;
        const retry = await sb.from('courses').insert([payload]).select().single();
        if (retry.data) {
          const idx = updatedList.findIndex((c) => c.title === newCourse.title);
          if (idx !== -1) updatedList[idx] = retry.data;
          else updatedList.unshift(retry.data);
          saveLocalUserCourses(user.id, updatedList);
          notifyCoursesChanged('create', retry.data);
          return retry.data;
        }
      }
    } else if (data) {
      const idx = updatedList.findIndex((c) => c.title === newCourse.title || (newCourse.id && c.id === newCourse.id));
      if (idx !== -1) updatedList[idx] = data;
      else updatedList.unshift(data);
      saveLocalUserCourses(user.id, updatedList);
      notifyCoursesChanged('create', data);
      return data;
    }
  } catch (netErr) {
    console.warn('[Supabase Course] Erreur réseau distant (cours conservé localement):', netErr);
  }

  return newCourse;
}

export async function createBatchUserCourses(courses: Array<Omit<DbCourse, 'id' | 'user_id' | 'created_at' | 'updated_at'>>): Promise<DbCourse[]> {
  if (!courses || courses.length === 0) return [];
  const user = getCurrentUserCached() || (await getCurrentUser().catch(() => null));
  if (!user) {
    throw new Error('Vous devez être connecté à votre compte pour importer des cours.');
  }

  const now = new Date().toISOString();
  const coursesWithUser: DbCourse[] = courses.map((c) => {
    const rawId = (c as any).id;
    const hasValidId = isValidUuid(rawId);
    return {
      ...c,
      id: hasValidId ? rawId : (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : undefined),
      user_id: user.id,
      created_at: now,
      updated_at: now,
    };
  });

  coursesWithUser.forEach((c) => {
    clearCourseTombstone(c.title);
    if (c.id) clearCourseTombstone(c.id);
  });

  // Sauvegarde optimiste immédiate dans le stockage local du compte
  const currentLocal = getLocalUserCourses(user.id);
  const existingIds = new Set(currentLocal.map((c) => c.id).filter(Boolean));
  const existingTitles = new Set(currentLocal.map((c) => c.title.toLowerCase().trim()));

  const toAddLocally = coursesWithUser.filter(
    (c) => (c.id && !existingIds.has(c.id)) || (!c.id && !existingTitles.has(c.title.toLowerCase().trim()))
  );
  const merged = [...toAddLocally, ...currentLocal];
  saveLocalUserCourses(user.id, merged);
  notifyCoursesChanged('create', coursesWithUser);

  // Synchronisation distante Supabase
  try {
    const sb = getSupabase();
    const rowsToInsert = coursesWithUser.map((c) => {
      const row: any = {
        user_id: user.id,
        title: c.title,
        body_md: c.body_md || '',
        tags: Array.isArray(c.tags) ? c.tags : [],
      };
      if (c.id && isValidUuid(c.id)) {
        row.id = c.id;
      }
      return row;
    });

    const { data, error } = await sb
      .from('courses')
      .insert(rowsToInsert)
      .select();

    if (error) {
      console.warn('[Supabase Courses] Batch insert distant échoué:', error);
      // Tentative de secours sans IDs forcés
      const fallbackRows = rowsToInsert.map(({ id, ...rest }) => rest);
      const retry = await sb.from('courses').insert(fallbackRows).select();
      if (retry.data && retry.data.length > 0) {
        const updated = [...retry.data, ...currentLocal.filter((c) => !retry.data.some((d) => d.title.toLowerCase() === c.title.toLowerCase()))];
        saveLocalUserCourses(user.id, updated);
        notifyCoursesChanged('create', retry.data);
        return retry.data;
      }
    } else if (data && data.length > 0) {
      const updated = [...data, ...currentLocal.filter((c) => !data.some((d) => d.id === c.id || d.title.toLowerCase() === c.title.toLowerCase()))];
      saveLocalUserCourses(user.id, updated);
      notifyCoursesChanged('create', data);
      return data;
    }
  } catch (netErr) {
    console.warn('[Supabase Courses] Erreur réseau distant (cours conservés localement):', netErr);
  }

  return coursesWithUser;
}

export async function updateUserCourse(id: string, updates: Partial<Omit<DbCourse, 'id' | 'user_id' | 'created_at'>>): Promise<DbCourse> {
  const user = getCurrentUserCached() || (await getCurrentUser().catch(() => null));
  const now = new Date().toISOString();
  let updatedCourse: DbCourse = {
    id,
    title: updates.title || '',
    body_md: updates.body_md || '',
    tags: updates.tags,
    updated_at: now,
  };

  if (user) {
    const local = getLocalUserCourses(user.id);
    const idx = local.findIndex((c) => c.id === id);
    if (idx !== -1) {
      updatedCourse = { ...local[idx], ...updates, updated_at: now };
      local[idx] = updatedCourse;
      saveLocalUserCourses(user.id, local);
      notifyCoursesChanged('update', updatedCourse);
    }
  }

  if (isValidUuid(id)) {
    try {
      const sb = getSupabase();
      const { data, error } = await sb
        .from('courses')
        .update({ ...updates, updated_at: now })
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;
      if (data && user) {
        const local = getLocalUserCourses(user.id);
        const idx = local.findIndex((c) => c.id === id);
        if (idx !== -1) {
          local[idx] = data;
          saveLocalUserCourses(user.id, local);
          notifyCoursesChanged('update', data);
        }
        return data;
      }
    } catch (err) {
      console.warn('[Supabase Course] Échec mise à jour distante (conservé localement):', err);
    }
  }

  return updatedCourse;
}

export async function deleteUserCourse(id: string): Promise<void> {
  const user = getCurrentUserCached() || (await getCurrentUser().catch(() => null));
  const activeId = user?.id;

  addDeletedCourseTombstone(id);

  if (activeId) {
    const local = getLocalUserCourses(activeId);
    const targetCourse = local.find(
      (c) => (c.id && c.id === id) || c.title.toLowerCase().trim() === id.toLowerCase().trim()
    );
    if (targetCourse) {
      addDeletedCourseTombstone(targetCourse.title);
      if (targetCourse.id) addDeletedCourseTombstone(targetCourse.id);
      cleanupCourseFiles(targetCourse, activeId).catch(() => {});
    }

    const updated = local.filter(
      (c) => !(c.id && c.id === id) && c.title.toLowerCase().trim() !== id.toLowerCase().trim()
    );
    saveLocalUserCourses(activeId, updated);
  }

  notifyCoursesChanged('delete', id);

  try {
    const sb = getSupabase();
    if (isValidUuid(id)) {
      await sb.from('courses').delete().eq('id', id);
    } else if (activeId) {
      await sb.from('courses').delete().eq('user_id', activeId).eq('title', id);
    }
  } catch (err) {
    console.warn('[Supabase Course] Échec suppression distante (supprimé localement):', err);
  }
}

export async function deleteBatchUserCourses(ids: string[]): Promise<void> {
  if (!ids || ids.length === 0) return;
  const user = getCurrentUserCached() || (await getCurrentUser().catch(() => null));
  const activeId = user?.id;

  ids.forEach((id) => addDeletedCourseTombstone(id));

  if (activeId) {
    const toDel = new Set(ids.map((i) => i.toLowerCase().trim()));
    const local = getLocalUserCourses(activeId);
    const targetCourses = local.filter(
      (c) => (c.id && toDel.has(c.id.toLowerCase().trim())) || toDel.has(c.title.toLowerCase().trim())
    );
    targetCourses.forEach((tc) => {
      addDeletedCourseTombstone(tc.title);
      if (tc.id) addDeletedCourseTombstone(tc.id);
      cleanupCourseFiles(tc, activeId).catch(() => {});
    });

    const remaining = local.filter(
      (c) => !(c.id && toDel.has(c.id.toLowerCase().trim())) && !toDel.has(c.title.toLowerCase().trim())
    );
    saveLocalUserCourses(activeId, remaining);
  }

  notifyCoursesChanged('delete', ids);

  const validIds = ids.filter((id) => isValidUuid(id));
  if (validIds.length > 0) {
    try {
      const sb = getSupabase();
      await sb.from('courses').delete().in('id', validIds);
    } catch (err) {
      console.warn('[Supabase Courses] Échec suppression batch distante (supprimé localement):', err);
    }
  }
}

export async function clearUserCourses(): Promise<void> {
  const user = getCurrentUserCached() || (await getCurrentUser().catch(() => null));
  const activeId = user?.id;

  if (activeId) {
    const local = getLocalUserCourses(activeId);
    local.forEach((c) => {
      if (c.id) addDeletedCourseTombstone(c.id);
      addDeletedCourseTombstone(c.title);
      cleanupCourseFiles(c, activeId).catch(() => {});
    });
    saveLocalUserCourses(activeId, []);
  }

  notifyCoursesChanged('clear');

  if (activeId) {
    try {
      const sb = getSupabase();
      await sb
        .from('courses')
        .delete()
        .eq('user_id', activeId)
        .neq('title', TIMETABLE_SYNC_TITLE);
    } catch (err) {
      console.warn('[Supabase Courses] Échec purge distante:', err);
    }
  }

  if (typeof window !== 'undefined') {
    try {
      localStorage.removeItem('marges_custom_courses');
      localStorage.removeItem('marges_custom_subjects');
    } catch {}
  }
}


export async function fetchUserScheduleEvents(): Promise<DbScheduleEvent[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('schedule_events')
    .select('*')
    .order('day_of_week')
    .order('start_time');
  if (error) throw error;
  return data || [];
}

export async function createUserScheduleEvent(event: Omit<DbScheduleEvent, 'id' | 'user_id' | 'created_at'>): Promise<DbScheduleEvent> {
  const user = await getCurrentUser();
  if (!user) {
    throw new Error('Vous devez être connecté à votre compte pour enregistrer un créneau.');
  }
  const sb = getSupabase();
  const { data, error } = await sb
    .from('schedule_events')
    .insert([{ ...event, user_id: user.id }])
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateUserScheduleEvent(id: string, updates: Partial<Omit<DbScheduleEvent, 'id' | 'user_id' | 'created_at'>>): Promise<DbScheduleEvent> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('schedule_events')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteUserScheduleEvent(id: string): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb.from('schedule_events').delete().eq('id', id);
  if (error) throw error;
}

export async function createBatchUserScheduleEvents(
  events: Array<Omit<DbScheduleEvent, 'id' | 'user_id' | 'created_at'>>
): Promise<DbScheduleEvent[]> {
  if (!events || events.length === 0) return [];
  const user = await getCurrentUser();
  if (!user) {
    throw new Error('Vous devez être connecté à votre compte pour enregistrer des créneaux.');
  }
  const sb = getSupabase();
  const { data, error } = await sb
    .from('schedule_events')
    .insert(events.map((e) => ({ ...e, user_id: user.id })))
    .select();
  if (error) throw error;
  return data || [];
}

export async function clearUserScheduleEvents(): Promise<void> {
  const sb = getSupabase();
  const user = await getCurrentUser();
  if (!user) return;
  const { error } = await sb
    .from('schedule_events')
    .delete()
    .eq('user_id', user.id);
  if (error) throw error;
}

export async function syncTimetableToSupabase(data: {
  icsContent?: string;
  icsUrl?: string;
}): Promise<void> {
  const sb = getSupabase();
  const user = await getCurrentUser();
  if (!user) return;

  const currentMeta = user.user_metadata || {};
  const metaUpdates: Record<string, any> = {
    ...currentMeta,
    timetable_updated_at: new Date().toISOString(),
    // On s'assure impérativement que timetable_ics ne reste JAMAIS dans user_metadata
    // pour éviter de saturer la taille des en-têtes HTTP du JWT
    timetable_ics: null,
  };

  if (data.icsUrl !== undefined) {
    metaUpdates.timetable_url = data.icsUrl;
  }

  // 1. Mettre à jour les métadonnées légères dans auth
  try {
    await sb.auth.updateUser({ data: metaUpdates });
  } catch (metaErr) {
    console.warn('[Supabase Sync] Note updateUser metadata:', metaErr);
  }

  // 2. Si un contenu ICS est fourni, on le persiste dans la table courses (avec RLS)
  if (data.icsContent !== undefined) {
    try {
      const { data: existing } = await sb
        .from('courses')
        .select('id')
        .eq('title', TIMETABLE_SYNC_TITLE)
        .maybeSingle();

      if (existing && existing.id) {
        if (!data.icsContent) {
          await sb.from('courses').delete().eq('id', existing.id);
        } else {
          await sb.from('courses').update({
            body_md: data.icsContent,
            tags: [SYSTEM_TAG, 'timetable'],
            updated_at: new Date().toISOString(),
          }).eq('id', existing.id);
        }
      } else if (data.icsContent) {
        await sb.from('courses').insert([{
          user_id: user.id,
          title: TIMETABLE_SYNC_TITLE,
          body_md: data.icsContent,
          tags: [SYSTEM_TAG, 'timetable'],
        }]);
      }
    } catch (dbErr) {
      console.warn('[Supabase Sync] Échec sauvegarde calendrier table courses:', dbErr);
      throw dbErr;
    }
  }
}

export async function fetchTimetableFromSupabase(): Promise<{
  icsContent?: string;
  icsUrl?: string;
  updatedAt?: string;
} | null> {
  try {
    const sb = getSupabase();
    const user = await getCurrentUser();
    if (!user) return null;

    // 1. Lire d'abord depuis la table courses (stockage robuste)
    let icsFromDb: string | undefined;
    let updatedAtFromDb: string | undefined;

    try {
      const { data: row } = await sb
        .from('courses')
        .select('body_md, updated_at')
        .eq('title', TIMETABLE_SYNC_TITLE)
        .maybeSingle();

      if (row && row.body_md) {
        icsFromDb = row.body_md;
        updatedAtFromDb = row.updated_at;
      }
    } catch (e) {
      console.warn('[Supabase Sync] Lecture courses échouée:', e);
    }

    const meta = user.user_metadata || {};
    const legacyIcs = typeof meta.timetable_ics === 'string' ? meta.timetable_ics : undefined;

    // Si un ancien contenu ICS résidait dans user_metadata, on le purge pour alléger le JWT
    if (legacyIcs) {
      sb.auth.updateUser({ data: { timetable_ics: null } }).catch(() => {});
    }

    return {
      icsContent: icsFromDb || legacyIcs,
      icsUrl: typeof meta.timetable_url === 'string' ? meta.timetable_url : undefined,
      updatedAt: updatedAtFromDb || (typeof meta.timetable_updated_at === 'string' ? meta.timetable_updated_at : undefined),
    };
  } catch {
    return null;
  }
}


export async function fetchUserReminders(): Promise<DbReminder[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('reminders')
    .select('*')
    .order('time_of_day');
  if (error) throw error;
  return data || [];
}

export async function createUserReminder(reminder: Omit<DbReminder, 'id' | 'user_id' | 'created_at'>): Promise<DbReminder> {
  const user = await getCurrentUser();
  if (!user) {
    throw new Error('Vous devez être connecté à votre compte pour enregistrer un rappel.');
  }
  const sb = getSupabase();
  const { data, error } = await sb
    .from('reminders')
    .insert([{ ...reminder, user_id: user.id }])
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function toggleUserReminder(id: string, enabled: boolean): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb.from('reminders').update({ enabled }).eq('id', id);
  if (error) throw error;
}

export async function deleteUserReminder(id: string): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb.from('reminders').delete().eq('id', id);
  if (error) throw error;
}

// -------------------------------------------------------------
// Couleur d'ambiance associée au compte Supabase
// -------------------------------------------------------------

export type AmbianceColorId =
  | 'default'
  | 'rose'
  | 'vert'
  | 'bleu'
  | 'lavande'
  | 'peche'
  | 'citron'
  | 'menthe';

export interface AmbianceOption {
  id: AmbianceColorId;
  label: string;
  subtitle: string;
  lightBg: string;
  lightSurface: string;
  lightSoft: string;
  lightAccent: string;
  darkBg: string;
  darkSurface: string;
  darkSoft: string;
  darkAccent: string;
}

export const AMBIANCE_OPTIONS: AmbianceOption[] = [
  {
    id: 'default',
    label: 'Crème & Terracotta',
    subtitle: 'Papier ivoire & ocre brûlé',
    lightBg: '#faf6f0',
    lightSurface: '#fffdf9',
    lightSoft: '#ede4d7',
    lightAccent: '#c8553d',
    darkBg: '#121110',
    darkSurface: '#1a1816',
    darkSoft: '#24211e',
    darkAccent: '#e06d53',
  },
  {
    id: 'rose',
    label: 'Rose poudré',
    subtitle: 'Pastel floral & nuit carmin',
    lightBg: '#fceef2',
    lightSurface: '#fff6f8',
    lightSoft: '#f5dde4',
    lightAccent: '#b83b66',
    darkBg: '#170d11',
    darkSurface: '#211318',
    darkSoft: '#2c1a21',
    darkAccent: '#f288ad',
  },
  {
    id: 'vert',
    label: 'Vert sauge',
    subtitle: 'Pastel céladon & forêt sombre',
    lightBg: '#eaf5ee',
    lightSurface: '#f5fbf7',
    lightSoft: '#d9ecdf',
    lightAccent: '#216d43',
    darkBg: '#0b150f',
    darkSurface: '#112017',
    darkSoft: '#192c21',
    darkAccent: '#68d496',
  },
  {
    id: 'bleu',
    label: 'Bleu brume',
    subtitle: 'Pastel azur & ardoise nocturne',
    lightBg: '#eaf3fb',
    lightSurface: '#f4f9fe',
    lightSoft: '#d8e8f6',
    lightAccent: '#235da2',
    darkBg: '#0a121a',
    darkSurface: '#101b27',
    darkSoft: '#172636',
    darkAccent: '#76b2f5',
  },
  {
    id: 'lavande',
    label: 'Lavande douce',
    subtitle: 'Pastel mauve & prune profonde',
    lightBg: '#f1eefb',
    lightSurface: '#f8f6fe',
    lightSoft: '#e3ddf5',
    lightAccent: '#5b3fad',
    darkBg: '#110d1a',
    darkSurface: '#191426',
    darkSoft: '#231c35',
    darkAccent: '#b095f8',
  },
  {
    id: 'peche',
    label: 'Pêche ambrée',
    subtitle: 'Pastel abricot & terre d’ombre',
    lightBg: '#fceede',
    lightSurface: '#fff7ef',
    lightSoft: '#f5dfca',
    lightAccent: '#b5501e',
    darkBg: '#17100a',
    darkSurface: '#22170f',
    darkSoft: '#2e2015',
    darkAccent: '#f29663',
  },
  {
    id: 'citron',
    label: 'Jaune vanille',
    subtitle: 'Pastel blé & bronze nocturne',
    lightBg: '#faf5df',
    lightSurface: '#fffcf0',
    lightSoft: '#efe7c6',
    lightAccent: '#8c6610',
    darkBg: '#141209',
    darkSurface: '#1e1b0e',
    darkSoft: '#292514',
    darkAccent: '#e3bf59',
  },
  {
    id: 'menthe',
    label: 'Menthe d’eau',
    subtitle: 'Pastel turquoise & abysse boréal',
    lightBg: '#e8f6f6',
    lightSurface: '#f4fcfc',
    lightSoft: '#d5eced',
    lightAccent: '#196f75',
    darkBg: '#091516',
    darkSurface: '#0f2022',
    darkSoft: '#162c2f',
    darkAccent: '#5ecbd2',
  },
];

const VALID_AMBIANCE_IDS = new Set<string>(AMBIANCE_OPTIONS.map((o) => o.id));

export function normalizeAmbianceColor(raw: unknown): AmbianceColorId {
  if (typeof raw === 'string' && VALID_AMBIANCE_IDS.has(raw.trim().toLowerCase())) {
    return raw.trim().toLowerCase() as AmbianceColorId;
  }
  return 'default';
}

export function applyAmbianceToDOM(color: AmbianceColorId): void {
  if (typeof document === 'undefined') return;
  const normalized = normalizeAmbianceColor(color);
  if (normalized === 'default') {
    delete document.documentElement.dataset.ambiance;
  } else {
    document.documentElement.dataset.ambiance = normalized;
  }
}

export function getCachedAccountAmbianceColor(): AmbianceColorId {
  const cachedUser = getCurrentUserCached();
  if (!cachedUser) return 'default';
  return normalizeAmbianceColor(cachedUser.user_metadata?.ambiance_color);
}

/**
 * Récupère la couleur d'ambiance enregistrée sur le compte Supabase actif
 * et l'applique immédiatement au document.
 */
export async function fetchUserAmbianceColor(): Promise<AmbianceColorId> {
  const user = await getCurrentUser().catch(() => null);
  if (!user) {
    applyAmbianceToDOM('default');
    return 'default';
  }

  let colorFromProfile: string | undefined;
  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from('profiles')
      .select('ambiance_color')
      .eq('id', user.id)
      .maybeSingle();
    if (!error && data && typeof data.ambiance_color === 'string') {
      colorFromProfile = data.ambiance_color;
    }
  } catch {}

  const resolved = normalizeAmbianceColor(
    colorFromProfile || user.user_metadata?.ambiance_color
  );
  applyAmbianceToDOM(resolved);
  return resolved;
}

/**
 * Sauvegarde la couleur d'ambiance directement sur le compte Supabase de l'utilisateur
 * (user_metadata Auth + table profiles) sans utiliser de paramètre local indépendant.
 */
export async function saveUserAmbianceColor(color: AmbianceColorId): Promise<AmbianceColorId> {
  const normalized = normalizeAmbianceColor(color);
  const user = await getCurrentUser();
  if (!user) {
    throw new Error('Vous devez être connecté à votre compte Supabase pour enregistrer votre couleur d’ambiance.');
  }

  applyAmbianceToDOM(normalized);

  const sb = getSupabase();
  const currentMeta = user.user_metadata || {};
  const { error: authErr } = await sb.auth.updateUser({
    data: {
      ...currentMeta,
      ambiance_color: normalized,
      ambiance_updated_at: new Date().toISOString(),
    },
  });

  // Synchronisation complémentaire sur la table profiles (si la colonne est présente)
  try {
    await sb
      .from('profiles')
      .upsert({ id: user.id, ambiance_color: normalized }, { onConflict: 'id' });
  } catch {}

  if (authErr) {
    throw authErr;
  }

  return normalized;
}
