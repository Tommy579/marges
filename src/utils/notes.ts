import {
  getCurrentUserCached,
  fetchUserCourses,
  upsertUserCourse,
  deleteUserCourse,
  getLocalUserCourses,
  isValidUuid,
  type DbCourse,
} from './supabase';
import { deleteCookie } from './persistence';

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

const LEGACY_KEYS = [
  'marges_notes_cache',
  'marges_notes_cache_meta',
  'marges_guest_notes',
  'marges_guest_notes_meta',
  'marges_user_courses_guest',
];

function purgeLegacyLocalNoteCaches(): void {
  if (typeof window === 'undefined') return;
  try {
    LEGACY_KEYS.forEach((k) => {
      localStorage.removeItem(k);
      deleteCookie(k);
    });
  } catch {}
}

export function generateNoteId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
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
    id: c.id && isValidUuid(c.id) ? c.id : generateNoteId(),
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
    id: isValidUuid(note.id) ? note.id : generateNoteId(),
    title: note.title.trim() || 'Sans titre',
    body_md: note.body_md || '',
    tags,
    created_at: note.created_at,
    updated_at: note.updated_at,
  };
}

/**
 * Récupère les notes du compte actuellement connecté depuis son cache isolé.
 */
export function getLocalNotes(): NoteItem[] {
  if (typeof window === 'undefined') return [];
  purgeLegacyLocalNoteCaches();

  const user = getCurrentUserCached();
  if (!user?.id) return [];

  return getLocalUserCourses(user.id)
    .filter(isCourseNote)
    .map(dbCourseToNote)
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
}

/**
 * Récupère les notes du compte actif depuis Supabase.
 */
export async function fetchUnifiedNotes(): Promise<NoteItem[]> {
  purgeLegacyLocalNoteCaches();
  try {
    const remoteCourses = await fetchUserCourses();
    return (remoteCourses || [])
      .filter(isCourseNote)
      .map(dbCourseToNote)
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
  } catch (err) {
    console.warn('[Notes] Synchronisation distante impossible, repli local du compte:', err);
    return getLocalNotes();
  }
}

/**
 * Sauvegarde une note dans le compte Supabase actif (et son cache local isolé par user_id).
 */
export async function saveUnifiedNote(note: NoteItem): Promise<NoteItem> {
  purgeLegacyLocalNoteCaches();
  const now = new Date().toISOString();
  const updatedNote: NoteItem = {
    ...note,
    id: isValidUuid(note.id) ? note.id : generateNoteId(),
    updated_at: now,
    created_at: note.created_at || now,
  };

  const dbCourse = noteToDbCourse(updatedNote);
  const saved = await upsertUserCourse(dbCourse);
  if (saved.id && isValidUuid(saved.id)) {
    updatedNote.id = saved.id;
  }
  return updatedNote;
}

/**
 * Supprime une note du compte Supabase actif.
 */
export async function deleteUnifiedNote(id: string): Promise<void> {
  purgeLegacyLocalNoteCaches();
  await deleteUserCourse(id);
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
