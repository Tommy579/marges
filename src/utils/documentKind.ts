/**
 * Détermination du type d'un document à ouvrir dans le lecteur.
 *
 * Le bug d'origine : le lecteur se basait uniquement sur l'extension déduite du
 * *titre*. Une note intitulée « Fiche Kant » n'a pas d'extension, retombait donc sur
 * « doc » (Word), son contenu Markdown était ignoré et la modale affichait la zone
 * « glissez-déposez votre fichier ».
 *
 * Règle : une extension explicite (fournie par l'appelant) gagne toujours, puis le
 * titre, puis l'URL de fichier, puis la présence de contenu texte.
 */

export type DocumentKind = 'pdf' | 'docx' | 'markdown' | 'code';

export interface DocumentKindInput {
  /** Extension connue de l'appelant, sans point. Ex. « note », « docx ». */
  ext?: string;
  title?: string;
  fileUrl?: string;
  content?: string;
}

export interface DocumentKindResult {
  /** Extension normalisée retenue (sert à l'affichage du badge). */
  ext: string;
  kind: DocumentKind;
}

const CODE_EXTS = new Set([
  'txt', 'text', 'c', 'h', 'cpp', 'java', 'py', 'js', 'ts', 'sh',
  'sci', 'sce', 'm', 'json', 'csv', 'log', 'xml', 'sql', 'html', 'css',
]);

const MARKDOWN_EXTS = new Set(['md', 'mdx', 'note']);
const DOCX_EXTS = new Set(['doc', 'docx', 'odt', 'rtf']);

function normalizeExt(raw?: string): string {
  if (!raw) return '';
  const cleaned = raw.replace(/[?#].*$/, '').trim().replace(/^\./, '').toLowerCase();
  return /^[a-z0-9]{1,5}$/.test(cleaned) ? cleaned : '';
}

function extFromPath(path?: string): string {
  if (!path) return '';
  const match = path.match(/\.([a-zA-Z0-9]{1,5})$/);
  return match ? normalizeExt(match[1]) : '';
}

export function detectDocumentKind(input: DocumentKindInput): DocumentKindResult {
  const explicit = normalizeExt(input.ext);
  const fromTitle = extFromPath(input.title);
  const fromUrl = extFromPath(input.fileUrl?.split('/').pop());

  const ext = explicit || fromTitle || fromUrl || (input.content ? 'md' : 'doc');

  if (ext === 'pdf') return { ext, kind: 'pdf' };
  if (DOCX_EXTS.has(ext)) return { ext, kind: 'docx' };
  if (MARKDOWN_EXTS.has(ext)) return { ext, kind: 'markdown' };
  if (CODE_EXTS.has(ext)) return { ext, kind: 'code' };
  if (input.content) return { ext, kind: 'markdown' };

  // Extension inconnue sans contenu : on tente le rendu Word, comme avant.
  return { ext, kind: 'docx' };
}
