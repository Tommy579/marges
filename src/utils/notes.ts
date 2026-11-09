import {
  getCurrentUserCached,
  getUserCoursesImmediate,
  fetchUserCourses,
  createUserCourse,
  updateUserCourse,
  deleteUserCourse,
  saveLocalUserCourses,
  getLocalUserCourses,
  notifyCoursesChanged,
  type DbCourse,
} from './supabase';
import { loadPersistentJSON, savePersistentJSON } from './persistence';

export interface NoteItem {
  id: string;
  title: string;
  body_md: string;
  subject: string;
  category: string;
  icon?: string;
  /** Police de la note : suit la note d'une page à l'autre (éditeur, lecteur). */
  font?: 'serif' | 'sans';
  created_at: string;
  updated_at: string;
}

const GUEST_STORAGE_KEY = 'marges_guest_notes';
const NOTES_CACHE_KEY = 'marges_notes_cache';

function generateId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'note_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function isCourseNote(c: DbCourse): boolean {
  if (!c) return false;
  // Ne pas considérer les conteneurs de matière ou synchronisations de planning comme des notes
  if (c.title === '__timetable_sync__') return false;
  if (c.tags && (c.tags.includes('Matière') || c.tags.includes('Dossier importé'))) return false;
  if (c.body_md && (c.body_md.startsWith('## Matière :') || c.body_md.startsWith('# Dossier importé :'))) return false;

  const isBinaryFile = /\.(pdf|docx?|odt|xlsx?|zip|tar|gz|png|jpe?g)$/i.test(c.title || '');
  if (isBinaryFile && (!c.tags || !c.tags.includes('note'))) return false;
  return true;
}

const STANDARD_CATEGORIES = new Set(['Fiches de révisions', 'CM', 'TD', 'Documents racines']);

export function dbCourseToNote(c: DbCourse): NoteItem {
  let subject = '';
  let category = 'Fiches de révisions';
  let icon = 'file';

  if (c.tags && Array.isArray(c.tags)) {
    const cleanTags = c.tags.filter(
      (t) =>
        !t.startsWith('icon:') &&
        !t.startsWith('font:') &&
        t !== 'note' &&
        t !== 'Université' &&
        t !== 'Dossier importé' &&
        t !== 'Matière' &&
        t !== 'Supports de cours' &&
        t !== 'Sans matière' &&
        t !== 'Notes libres'
    );
    if (cleanTags.length > 0) {
      if (STANDARD_CATEGORIES.has(cleanTags[0])) {
        category = cleanTags[0];
      } else {
        subject = cleanTags[0];
        if (cleanTags.length > 1) category = cleanTags[1];
      }
    }

    const iconTag = c.tags.find((t) => t.startsWith('icon:'));
    if (iconTag) icon = iconTag.replace('icon:', '');
  }

  const fontTag = (c.tags || []).find((t) => t.startsWith('font:'));
  const font = fontTag ? (fontTag.slice('font:'.length) === 'serif' ? 'serif' : 'sans') : undefined;

  return {
    id: c.id || generateId(),
    title: c.title || 'Sans titre',
    body_md: c.body_md || '',
    subject,
    category,
    icon,
    font,
    created_at: c.created_at || new Date().toISOString(),
    updated_at: c.updated_at || new Date().toISOString(),
  };
}

export function noteToDbCourse(note: NoteItem): DbCourse {
  const tags: string[] = [];
  const cleanSubject = (note.subject || '').trim();
  if (cleanSubject && cleanSubject !== 'Sans matière' && cleanSubject !== 'Notes libres') {
    tags.push(cleanSubject);
  }
  if (note.category && note.category.trim()) {
    tags.push(note.category.trim());
  } else {
    tags.push('Fiches de révisions');
  }
  tags.push('note');
  if (note.icon) {
    tags.push(`icon:${note.icon}`);
  }
  if (note.font) {
    tags.push(`font:${note.font}`);
  }
  return {
    id: note.id,
    title: note.title.trim() || 'Sans titre',
    body_md: note.body_md || '',
    tags,
    created_at: note.created_at,
    updated_at: note.updated_at,
  };
}

/**
 * Récupère les notes unifiées depuis le cache local (immédiat).
 */
export function getLocalNotes(): NoteItem[] {
  if (typeof window === 'undefined') return [];
  const noteMap = new Map<string, NoteItem>();

  // 1. Cache dédié aux notes (garantie locale immédiate à 100%)
  const dedicatedNotes = loadPersistentJSON<NoteItem[]>(NOTES_CACHE_KEY, []);
  dedicatedNotes.forEach((n) => {
    if (n && n.id) noteMap.set(n.id, n);
  });

  // 2. Cache cours utilisateur
  const courses = getUserCoursesImmediate();
  const notesFromCourses = courses.filter(isCourseNote).map(dbCourseToNote);
  notesFromCourses.forEach((n) => {
    if (!n || !n.id) return;
    const existing = noteMap.get(n.id);
    if (!existing) {
      noteMap.set(n.id, n);
      return;
    }
    // La police de la note n'est connue que par la ligne de cours (tag « font: ») :
    // on la reporte pour qu'elle s'applique à la réouverture.
    if (!existing.font && n.font) existing.font = n.font;
  });

  // 3. Stockage invité persistant
  const guestNotes = loadPersistentJSON<NoteItem[]>(GUEST_STORAGE_KEY, []);
  guestNotes.forEach((n) => {
    if (n && n.id && !noteMap.has(n.id)) noteMap.set(n.id, n);
  });

  return Array.from(noteMap.values()).sort(
    (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
  );
}

/**
 * Récupère les notes avec synchronisation Supabase en arrière-plan.
 */
export async function fetchUnifiedNotes(): Promise<NoteItem[]> {
  const immediate = getLocalNotes();
  try {
    const remoteCourses = await fetchUserCourses();
    if (remoteCourses && remoteCourses.length > 0) {
      const remoteNotes = remoteCourses.filter(isCourseNote).map(dbCourseToNote);
      const noteMap = new Map<string, NoteItem>();
      remoteNotes.forEach((n) => {
        if (n && n.id) noteMap.set(n.id, n);
      });
      immediate.forEach((n) => {
        if (n && n.id && !noteMap.has(n.id)) noteMap.set(n.id, n);
      });
      const unified = Array.from(noteMap.values()).sort(
        (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
      );
      // Mettre à jour le cache dédié pour les futurs accès instantanés
      savePersistentJSON(NOTES_CACHE_KEY, unified);
      return unified;
    }
  } catch (err) {
    console.warn('[Notes] Synchronisation distante impossible, repli local:', err);
  }
  return immediate;
}

/**
 * Sauvegarde une note de façon optimiste et bidirectionnelle.
 */
export async function saveUnifiedNote(note: NoteItem): Promise<NoteItem> {
  const now = new Date().toISOString();
  const updatedNote: NoteItem = {
    ...note,
    id: note.id || generateId(),
    updated_at: now,
    created_at: note.created_at || now,
  };

  // 1. Sauvegarde systématique et immédiate dans le cache dédié aux notes
  const dedicatedNotes = loadPersistentJSON<NoteItem[]>(NOTES_CACHE_KEY, []);
  const dIdx = dedicatedNotes.findIndex((n) => n.id === updatedNote.id);
  if (dIdx !== -1) {
    dedicatedNotes[dIdx] = updatedNote;
  } else {
    dedicatedNotes.unshift(updatedNote);
  }
  savePersistentJSON(NOTES_CACHE_KEY, dedicatedNotes);

  const user = getCurrentUserCached();
  const dbCourse = noteToDbCourse(updatedNote);

  if (user?.id) {
    // 2. Utilisateur connecté : sauvegarde locale cours (0 ms)
    const local = getLocalUserCourses(user.id);
    const existingIndex = local.findIndex((c) => c.id === updatedNote.id);

    if (existingIndex !== -1) {
      local[existingIndex] = dbCourse;
    } else {
      local.unshift(dbCourse);
    }
    saveLocalUserCourses(user.id, local);
    notifyCoursesChanged(existingIndex !== -1 ? 'update' : 'create', dbCourse);

    // Synchronisation distante Supabase en tâche de fond (non bloquante)
    if (existingIndex !== -1 && local[existingIndex].id) {
      updateUserCourse(local[existingIndex].id!, {
        title: dbCourse.title,
        body_md: dbCourse.body_md,
        tags: dbCourse.tags,
      }).catch((e) => console.warn('[Notes] Update distant différé:', e));
    } else {
      createUserCourse(dbCourse).catch((e) => console.warn('[Notes] Create distant différé:', e));
    }
  } else {
    // 3. Utilisateur invité ou hors-ligne : sauvegarde persistante locale
    const guestList = loadPersistentJSON<NoteItem[]>(GUEST_STORAGE_KEY, []);
    const idx = guestList.findIndex((n) => n.id === updatedNote.id);
    if (idx !== -1) {
      guestList[idx] = updatedNote;
    } else {
      guestList.unshift(updatedNote);
    }
    savePersistentJSON(GUEST_STORAGE_KEY, guestList);

    // Mettre aussi à jour le cache de cours pour que la page /cours/ affiche la note
    const localCourses = getUserCoursesImmediate();
    const courseIdx = localCourses.findIndex((c) => c.id === updatedNote.id);
    if (courseIdx !== -1) {
      localCourses[courseIdx] = dbCourse;
    } else {
      localCourses.unshift(dbCourse);
    }
    saveLocalUserCourses('guest', localCourses);
    notifyCoursesChanged('update', dbCourse);
  }

  return updatedNote;
}

/**
 * Supprime une note du stockage unifié.
 */
export async function deleteUnifiedNote(id: string): Promise<void> {
  // Nettoyage dans le cache dédié
  const dedicatedNotes = loadPersistentJSON<NoteItem[]>(NOTES_CACHE_KEY, []);
  savePersistentJSON(
    NOTES_CACHE_KEY,
    dedicatedNotes.filter((n) => n.id !== id)
  );

  const user = getCurrentUserCached();
  if (user?.id) {
    await deleteUserCourse(id);
  }

  // Nettoyage dans le stockage invité
  const guestList = loadPersistentJSON<NoteItem[]>(GUEST_STORAGE_KEY, []);
  const filtered = guestList.filter((n) => n.id !== id);
  savePersistentJSON(GUEST_STORAGE_KEY, filtered);

  // Nettoyage cache local cours
  const localCourses = getUserCoursesImmediate();
  const remaining = localCourses.filter((c) => c.id !== id);
  saveLocalUserCourses(user?.id || 'guest', remaining);
  notifyCoursesChanged('delete', { id });
}

/**
 * Rendu Markdown élégant et sécurisé avec support Notion :
 * - Titres, sous-titres
 * - Listes à puces, ordonnées
 * - Cases à cocher interactives
 * - Encadrés / Callouts
 * - Blocs de code
 * - Citations
 * - Tableaux simples
 */
export function renderNotionMarkdown(md: string): string {
  if (!md || !md.trim()) {
    return '<p class="notion-empty-placeholder">Commencez à rédiger vos notes ici, ou tapez <code>/</code> pour insérer un bloc.</p>';
  }

  // 1. Extraire les blocs de code ```lang ... ``` avant toute transformation ligne par ligne
  const codeBlocks: string[] = [];
  const withPlaceholders = md.replace(/```([a-z0-9_-]*)\n([\s\S]*?)```/gim, (_, lang, code) => {
    const escapedCode = String(code)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .trim();
    const blockHtml = `<div class="notion-code-block"><div class="notion-code-header"><span class="notion-code-lang">${lang || 'code'}</span></div><pre><code>${escapedCode}</code></pre></div>`;
    const idx = codeBlocks.push(blockHtml) - 1;
    return `@@NOTION_CODE_BLOCK_${idx}@@`;
  });

  // 2. Échappement anti-XSS préliminaire sur le reste du texte
  let html = withPlaceholders
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // 3. Callouts Notion : > [!NOTE], > [!TIP], > [!IMPORTANT], > [!WARNING], > [!CAUTION]
  html = html.replace(/^&gt;\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*$)/gim, (_, type, text) => {
    const t = type.toLowerCase();
    return `<div class="notion-callout notion-callout--${t}"><span class="notion-callout-icon" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v4h1"/></svg></span><div class="notion-callout-text">${text}</div></div>`;
  });

  // 4. Titres (h1 à h4)
  html = html.replace(/^#### (.*$)/gim, '<h4 class="notion-h4">$1</h4>');
  html = html.replace(/^### (.*$)/gim, '<h3 class="notion-h3">$1</h3>');
  html = html.replace(/^## (.*$)/gim, '<h2 class="notion-h2">$1</h2>');
  html = html.replace(/^# (.*$)/gim, '<h1 class="notion-h1">$1</h1>');

  // 5. Tableaux simples Markdown
  html = html.replace(
    /^(\|.+\|)\r?\n\|(?:\s*:?-+:?\s*\|)+\r?\n((?:\|.+\|(?:\r?\n|$))+)/gm,
    (_, headerLine: string, bodyLines: string) => {
      const parseCells = (row: string) =>
        row
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => c.trim());
      const headers = parseCells(headerLine);
      const rows = bodyLines
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map(parseCells);
      const thead = `<thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>`;
      const tbody = `<tbody>${rows
        .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
        .join('')}</tbody>`;
      return `<div class="notion-table-wrap"><table class="notion-table">${thead}${tbody}</table></div>`;
    }
  );

  // 6. Séparateurs
  html = html.replace(/^(?:---|\*\*\*|___)$/gim, '<hr class="notion-divider" />');

  // 7. Checkboxes Notion : - [ ] ou - [x]
  let checkboxCounter = 0;
  html = html.replace(/^-\s*\[([ xX])\]\s*(.*$)/gim, (_, state, label) => {
    const checked = state.toLowerCase() === 'x';
    const idx = checkboxCounter++;
    return `<div class="notion-todo-item ${checked ? 'completed' : ''}" data-todo-index="${idx}"><input type="checkbox" class="notion-todo-cb" ${checked ? 'checked' : ''} data-index="${idx}" /><span class="notion-todo-label">${label}</span></div>`;
  });

  // 8. Citations
  html = html.replace(/^&gt;\s*(.*$)/gim, '<blockquote class="notion-quote"><p>$1</p></blockquote>');

  // 9. Listes à puces (- ou *)
  html = html.replace(/^(?:-|\*)\s+(.*$)/gim, '<li class="notion-bullet-item">$1</li>');

  // 10. Listes numérotées
  html = html.replace(/^(\d+)\.\s+(.*$)/gim, '<li class="notion-numbered-item" value="$1">$2</li>');

  // 11. Mise en valeur inline
  html = html.replace(/\*\*(.*?)\*\*/gim, '<strong>$1</strong>');
  html = html.replace(/\*(.*?)\*/gim, '<em>$1</em>');
  html = html.replace(/~~(.*?)~~/gim, '<del>$1</del>');
  html = html.replace(/==(.*?)==/gim, '<mark class="notion-highlight">$1</mark>');
  html = html.replace(/`([^`]+)`/gim, '<code class="notion-inline-code">$1</code>');

  // 12. Liens markdown [texte](url) sécurisés (https://, http://, mailto:, /, #)
  html = html.replace(
    /\[([^\]]+)\]\(((?:https?:\/\/|mailto:|\/|#)[^)\s"]+)\)/gim,
    '<a href="$2" target="_blank" rel="noopener noreferrer" class="notion-link">$1</a>'
  );

  // 13. Paragraphes et retours à la ligne (sans <br /> parasite après les blocs)
  html = html.replace(/\n\n+/g, '</p><p class="notion-p">');
  html = html.replace(/\n/g, '<br />');
  html = html.replace(/(<\/(?:h[1-4]|div|blockquote|li|table)>|<hr[^>]*>)(?:<br\s*\/?>)+/gi, '$1');

  // 14. Réinjecter les blocs de code intacts
  html = html.replace(/@@NOTION_CODE_BLOCK_(\d+)@@(?:<br\s*\/?>)*/g, (_, idxStr) => {
    return codeBlocks[Number(idxStr)] || '';
  });

  return `<div class="notion-rendered-flow"><p class="notion-p">${html}</p></div>`;
}

export const renderMarkdown = renderNotionMarkdown;

/**
 * Calcul du temps de lecture estimé et du nombre de mots.
 */
export function computeNoteStats(text: string): { words: number; readMinutes: number } {
  if (!text) return { words: 0, readMinutes: 1 };
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const readMinutes = Math.max(1, Math.ceil(words / 200));
  return { words, readMinutes };
}
