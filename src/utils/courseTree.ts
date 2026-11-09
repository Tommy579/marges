import type { DbCourse } from './supabase';

/**
 * Construction de l'arborescence « matières → dossiers → documents » à partir des
 * lignes de la table `courses`.
 *
 * Cette logique vivait uniquement dans la page Cours. L'espace perso affichait de son
 * côté une liste plate, où les matières, les notes et les fichiers importés se
 * mélangeaient et où les PDF n'apparaissaient pas. Les deux pages partagent
 * désormais ce module.
 */

export interface CourseFile {
  /** Identifiant du cours Supabase qui porte ce document. */
  id?: string;
  title: string;
  /** Lien éventuel déclaré dans le markdown (`- [titre](url)`). */
  url?: string;
  /** Extension normalisée : « pdf », « docx », « note »… */
  ext: string;
  /** Ligne de cours d'origine, utile pour retrouver le contenu ou les tags. */
  rawCourse: DbCourse;
  /** Contenu Markdown ou data URL associé au document. */
  content?: string;
}

export interface CourseMarkdownSection {
  folderName: string;
  items: Array<{ title: string; url?: string; ext: string; content?: string }>;
}

export interface CourseSubject {
  subject: string;
  folders: Map<string, CourseFile[]>;
}

/** Ordre d'affichage des dossiers : CM, TD, TP, fiches, programme, documents. */
export function getFolderSortScore(name: string): number {
  const low = name.toLowerCase();
  if (low === 'cm' || low.includes('cours')) return 10;
  if (low === 'td' || low.includes('dirigé')) return 20;
  if (low === 'tp' || low.includes('pratique')) return 30;
  if (low.includes('fiche') || low.includes('revision') || low.includes('révision')) return 40;
  if (low.includes('programme') || low.includes('notion') || low.includes('clé')) return 50;
  if (low.includes('document') || low.includes('général') || low.includes('racine')) return 60;
  return 70;
}

/** Lit les sous-dossiers `### Nom` et leurs listes `- fichier.ext`. */
export function parseMarkdownSections(body_md: string): CourseMarkdownSection[] {
  if (!body_md) return [];
  const sections: CourseMarkdownSection[] = [];
  const lines = body_md.split('\n');
  let currentFolder = '';
  let currentItems: CourseMarkdownSection['items'] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('### ')) {
      if (currentFolder && currentItems.length > 0) {
        sections.push({ folderName: currentFolder, items: currentItems });
      }
      currentFolder = trimmed.replace(/^###\s+/, '').trim();
      currentItems = [];
    } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      const raw = trimmed.replace(/^[-*]\s+/, '').trim();
      const linkMatch = raw.match(/^\[([^\]]+)\]\(([^)]+)\)/);
      let title = raw;
      let fileUrl = '';
      if (linkMatch) {
        title = linkMatch[1];
        fileUrl = linkMatch[2];
      }
      let ext = 'note';
      const extMatch = title.match(/\.([a-zA-Z0-9]+)(\s|$|\))/);
      if (extMatch) {
        ext = extMatch[1].toLowerCase();
      } else if (fileUrl && fileUrl.endsWith('.pdf')) {
        ext = 'pdf';
      }
      currentItems.push({ title, url: fileUrl, ext, content: raw });
    }
  }

  if (currentFolder && currentItems.length > 0) {
    sections.push({ folderName: currentFolder, items: currentItems });
  }

  if (sections.length === 0 && currentItems.length > 0) {
    sections.push({ folderName: 'Programme & Notions-clés', items: currentItems });
  }

  return sections;
}

const IGNORED_SUBJECT_TAGS = new Set([
  'Université',
  'Dossier importé',
  'Matière',
  'Supports de cours',
  'note',
  'Sans matière',
  'Notes libres',
  'Fiches de révisions',
  'CM',
  'TD',
  'Documents racines',
]);

/** Une note sans matière réelle est rangée à la racine, sous « Notes ». */
export function isRootNote(tags?: string[]): boolean {
  if (!tags || !tags.includes('note')) return false;
  return !tags.some((t) => !t.startsWith('icon:') && !IGNORED_SUBJECT_TAGS.has(t));
}

function resolveSubject(course: DbCourse): string {
  if (isRootNote(course.tags)) return 'Notes';

  const tags = course.tags || [];
  const cleanTags = tags.filter((t) => !t.startsWith('icon:') && !IGNORED_SUBJECT_TAGS.has(t));
  if (cleanTags.length > 0) return cleanTags[0].trim();

  if (tags.includes('Matière') && course.title) return course.title.trim();
  return '';
}

function detectExtension(course: DbCourse): string {
  const isDataUrl = Boolean(course.body_md && course.body_md.startsWith('data:'));
  let ext = isDataUrl ? 'doc' : 'note';
  const extMatch = course.title?.match(/\.([a-zA-Z0-9]+)$/);
  if (extMatch) ext = extMatch[1].toLowerCase();
  return ext;
}

/**
 * Matière de rattachement d'une ligne de cours (vide si la ligne ne peut pas être
 * classée). Utilisée notamment pour supprimer toutes les lignes d'une matière.
 */
export function courseSubject(course: DbCourse): string {
  return resolveSubject(course);
}

/**
 * Regroupe les cours par matière puis par dossier, en dépliant le markdown
 * d'arborescence produit par l'import de dossier (`### CM`, `- cours1.pdf`…).
 */
export function groupCoursesBySubject(courses: DbCourse[]): Map<string, CourseSubject> {
  const subjectsMap = new Map<string, CourseSubject>();

  (courses || []).forEach((course) => {
    const subject = resolveSubject(course);
    if (!subject) return;

    if (!subjectsMap.has(subject)) {
      subjectsMap.set(subject, { subject, folders: new Map() });
    }
    const sData = subjectsMap.get(subject)!;

    if (isRootNote(course.tags)) {
      const folder = 'Notes libres';
      if (!sData.folders.has(folder)) sData.folders.set(folder, []);
      sData.folders.get(folder)!.push({
        id: course.id,
        title: course.title || 'Sans titre',
        ext: 'note',
        rawCourse: course,
        content: course.body_md,
      });
      return;
    }

    const sections = parseMarkdownSections(course.body_md);
    if (sections.length > 0) {
      sections.forEach((section) => {
        if (!sData.folders.has(section.folderName)) {
          sData.folders.set(section.folderName, []);
        }
        const list = sData.folders.get(section.folderName)!;
        section.items.forEach((item) => {
          const exists = list.some((f) => f.title.toLowerCase() === item.title.toLowerCase());
          if (!exists) {
            list.push({
              id: course.id,
              title: item.title,
              url: item.url,
              ext: item.ext,
              rawCourse: course,
              content: item.content,
            });
          }
        });
      });
      return;
    }

    // Conteneur « Matière » sans arborescence : rien à afficher.
    if (course.tags?.includes('Matière')) return;

    let folder = 'Fiches & Notes';
    if (course.tags && course.tags.length > 1) {
      const cleanTags = course.tags.filter(
        (t) => t !== 'Université' && t !== 'Dossier importé' && t !== 'Matière' && t !== subject
      );
      if (cleanTags.length > 0) folder = cleanTags[0];
    }
    if (!sData.folders.has(folder)) sData.folders.set(folder, []);

    const list = sData.folders.get(folder)!;
    const exitSans = list.findIndex((f) => f.title.toLowerCase() === (course.title || '').toLowerCase());
    const entry: CourseFile = {
      id: course.id,
      title: course.title,
      ext: detectExtension(course),
      rawCourse: course,
      content: course.body_md,
    };

    if (exitSans !== -1) {
      const previous = list[exitSans];
      const previousIsDataUrl = Boolean(previous.rawCourse?.body_md?.startsWith('data:'));
      const thisIsDataUrl = Boolean(course.body_md?.startsWith('data:'));
      if (thisIsDataUrl || !previousIsDataUrl) {
        list[exitSans] = entry;
      }
    } else {
      list.push(entry);
    }
  });

  return subjectsMap;
}

/** Matières triées : « Notes » d'abord, puis ordre alphabétique français. */
export function sortSubjects(subjects: Iterable<CourseSubject>): CourseSubject[] {
  return Array.from(subjects).sort((a, b) => {
    if (a.subject === 'Notes') return -1;
    if (b.subject === 'Notes') return 1;
    return a.subject.localeCompare(b.subject, 'fr');
  });
}

/** Dossiers triés selon leur nature (CM, TD, TP…) puis alphabétiquement. */
export function sortFolders(subjects: CourseSubject): string[] {
  return Array.from(subjects.folders.keys()).sort((a, b) => {
    const diff = getFolderSortScore(a) - getFolderSortScore(b);
    return diff !== 0 ? diff : a.localeCompare(b);
  });
}
