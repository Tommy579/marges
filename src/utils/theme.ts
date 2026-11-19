/**
 * Gestion centralisée du thème (automatique selon le système, clair ou sombre).
 * Par défaut (aucune valeur enregistrée), le site suit `prefers-color-scheme`.
 */

export type ThemePreference = 'auto' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'theme';
export const THEME_CHANGE_EVENT = 'marges:theme-change';

const darkMedia = () =>
  typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null;

export function normalizeThemePreference(raw: string | null | undefined): ThemePreference {
  return raw === 'light' || raw === 'dark' ? raw : 'auto';
}

export function getThemePreference(): ThemePreference {
  if (typeof window === 'undefined') return 'auto';
  try {
    const local = localStorage.getItem(STORAGE_KEY);
    if (local === 'light' || local === 'dark') return local;
  } catch {}
  try {
    const match = document.cookie.match(/(?:^|; )theme=([^;]*)/);
    if (match) {
      return normalizeThemePreference(decodeURIComponent(match[1]));
    }
  } catch {}
  return 'auto';
}

export function getSystemTheme(): ResolvedTheme {
  return darkMedia()?.matches ? 'dark' : 'light';
}

export function getResolvedTheme(pref: ThemePreference = getThemePreference()): ResolvedTheme {
  return pref === 'auto' ? getSystemTheme() : pref;
}

export function nextThemePreference(current: ThemePreference): ThemePreference {
  if (current === 'auto') return 'light';
  if (current === 'light') return 'dark';
  return 'auto';
}

export function syncThemeToDocument(doc: Document, pref: ThemePreference): void {
  if (pref === 'auto') {
    delete doc.documentElement.dataset.theme;
  } else {
    doc.documentElement.dataset.theme = pref;
  }
  const meta = doc.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
  if (meta) {
    meta.content = pref === 'auto' ? 'light dark' : pref;
  }
}

export function applyThemePreference(pref: ThemePreference, persist = true): void {
  const normalized = normalizeThemePreference(pref);
  syncThemeToDocument(document, normalized);

  if (persist) {
    try {
      if (normalized === 'auto') {
        localStorage.removeItem(STORAGE_KEY);
      } else {
        localStorage.setItem(STORAGE_KEY, normalized);
      }
    } catch {}
    try {
      if (normalized === 'auto') {
        document.cookie = 'theme=; path=/; max-age=0; SameSite=Lax';
      } else {
        document.cookie = `theme=${encodeURIComponent(normalized)}; path=/; max-age=31536000; SameSite=Lax`;
      }
    } catch {}
  }

  window.dispatchEvent(new CustomEvent<ThemePreference>(THEME_CHANGE_EVENT, { detail: normalized }));
}

let storageSyncInstalled = false;

export function installThemeStorageSync(): void {
  if (storageSyncInstalled || typeof window === 'undefined') return;
  storageSyncInstalled = true;

  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    applyThemePreference(normalizeThemePreference(event.newValue), false);
  });
}
