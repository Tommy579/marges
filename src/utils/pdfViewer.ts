import { renderAsync } from 'docx-preview';
import {
  findDocumentBlob,
  fetchAndCacheDocumentBlob,
  saveDocumentFile,
  dataUrlToBlob,
} from './fileStorage';
import {
  getCurrentUserCached,
  getCurrentUser,
  getUserCoursesImmediate,
  createUserCourse,
  type DbCourse,
} from './supabase';
import { renderNotionMarkdown } from './notes';
import { esc } from './escape';
import { detectDocumentKind } from './documentKind';

export interface OpenPdfOptions {
  title: string;
  subject?: string;
  folder?: string;
  fileUrl?: string;
  rawCourse?: DbCourse;
  content?: string;
  /**
   * Extension réelle du document quand l'appelant la connaît déjà (par exemple
   * « note » pour une fiche Markdown saisie dans l'application). Sans elle, le
   * lecteur la déduit du titre, ce qui échoue sur les documents sans extension.
   */
  ext?: string;
}

export type OpenDocumentOptions = OpenPdfOptions;

let activeBlobUrl: string | null = null;
let currentDocContext: OpenPdfOptions | null = null;

export function setupPdfViewerModal(): void {
  if (typeof window === 'undefined') return;

  const modal = document.getElementById('modal-pdf-viewer') as HTMLDialogElement | null;
  const btnClose = document.getElementById('btn-close-pdf-viewer');
  const dropBox = document.getElementById('pdf-drop-box');
  const fileInput = document.getElementById('input-pdf-missing') as HTMLInputElement | null;
  const btnCopyText = document.getElementById('btn-copy-doc-text');
  const btnCopyLabel = document.getElementById('btn-copy-doc-label');

  btnClose?.addEventListener('click', () => {
    if (modal) {
      if (typeof modal.close === 'function') modal.close();
      else modal.style.display = 'none';
    }
    const frame = document.getElementById('pdf-viewer-frame') as HTMLIFrameElement | null;
    if (frame) frame.src = '';
  });

  btnCopyText?.addEventListener('click', () => {
    const codeEl = document.getElementById('code-viewer-content');
    const mdEl = document.getElementById('markdown-viewer-content');
    const textToCopy = (codeEl?.textContent || mdEl?.textContent || '').trim();
    if (textToCopy) {
      navigator.clipboard.writeText(textToCopy).then(() => {
        if (btnCopyLabel) {
          const original = btnCopyLabel.textContent;
          btnCopyLabel.textContent = 'Copié !';
          setTimeout(() => {
            if (btnCopyLabel) btnCopyLabel.textContent = original;
          }, 2000);
        }
      }).catch(() => {});
    }
  });

  // Gestion du glisser-déposer sur la zone de fichier manquant
  dropBox?.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropBox.classList.add('drag-over');
  });

  dropBox?.addEventListener('dragleave', () => {
    dropBox.classList.remove('drag-over');
  });

  dropBox?.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropBox.classList.remove('drag-over');
    if (e.dataTransfer?.files && e.dataTransfer.files[0]) {
      await handleAttachedDocumentFile(e.dataTransfer.files[0]);
    }
  });

  fileInput?.addEventListener('change', async () => {
    if (fileInput.files && fileInput.files[0]) {
      await handleAttachedDocumentFile(fileInput.files[0]);
      fileInput.value = '';
    }
  });
}

async function handleAttachedDocumentFile(file: File): Promise<void> {
  if (!currentDocContext) return;
  const user = getCurrentUserCached() || (await getCurrentUser().catch(() => null));
  const userId = user?.id || '';
  const title = currentDocContext.title;
  const subject = currentDocContext.subject || '';
  const folder = currentDocContext.folder || '';

  // 1. Sauvegarde dans IndexedDB (local immédiat) et téléversement transparent vers Supabase Storage
  await saveDocumentFile(file, {
    userId,
    subject,
    folder,
    fileName: title,
  });

  // 2. Si le fichier fait moins de 2 Mo et qu'aucun cours individuel ne contient encore sa DataURL,
  // sauvegarder également une copie base64 dans la table courses pour garantir la synchronisation multi-appareils
  // même si le bucket Supabase Storage n'est pas configuré.
  if (file.size <= 2 * 1024 * 1024 && userId) {
    try {
      const existing = getUserCoursesImmediate().find(
        (c) => c.title.trim().toLowerCase() === title.trim().toLowerCase() && c.body_md?.startsWith('data:')
      );
      if (!existing) {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          if (dataUrl) {
            createUserCourse({
              title,
              tags: [subject || 'Cours', folder || 'Documents'],
              body_md: dataUrl,
            }).catch(() => {});
          }
        };
        reader.readAsDataURL(file);
      }
    } catch {}
  }

  // Réaffichage immédiat
  await openDocumentViewer(currentDocContext);
}

export async function openDocumentViewer(options: OpenPdfOptions): Promise<void> {
  currentDocContext = options;
  const modal = document.getElementById('modal-pdf-viewer') as HTMLDialogElement | null;
  if (!modal) return;

  const badgeEl = document.getElementById('pdf-viewer-badge');
  const titleEl = document.getElementById('pdf-viewer-title');
  const breadcrumbEl = document.getElementById('pdf-viewer-breadcrumb');
  const btnNewTab = document.getElementById('btn-pdf-new-tab') as HTMLButtonElement | null;
  const btnDownload = document.getElementById('btn-pdf-download') as HTMLAnchorElement | null;
  const btnFullscreenText = document.getElementById('btn-pdf-fullscreen-text');

  // Conteneurs
  const frameWrapper = document.getElementById('pdf-frame-wrapper');
  const frame = document.getElementById('pdf-viewer-frame') as HTMLIFrameElement | null;
  const docxWrapper = document.getElementById('docx-frame-wrapper');
  const docxContainer = document.getElementById('docx-viewer-container');
  const textWrapper = document.getElementById('text-frame-wrapper');
  const textInfo = document.getElementById('text-frame-info');
  const mdContent = document.getElementById('markdown-viewer-content');
  const codePre = document.getElementById('code-viewer-pre');
  const codeContent = document.getElementById('code-viewer-content');

  // Zone chargement Cloud
  const loadingZone = document.getElementById('doc-loading-zone');
  const loadingTitle = document.getElementById('doc-loading-title');
  const loadingDesc = document.getElementById('doc-loading-desc');

  // Zone manquant
  const missingZone = document.getElementById('pdf-missing-zone');
  const missingFilename = document.getElementById('pdf-missing-filename');
  const dropHighlight = document.getElementById('doc-drop-highlight');

  const docTitle = options.title.trim();
  const docSubject = options.subject || 'Cours';
  const docFolder = options.folder || 'Document';

  // Détection de l'extension et de la catégorie
  const { ext, kind } = detectDocumentKind({
    ext: options.ext,
    title: docTitle,
    fileUrl: options.fileUrl,
    content: options.content,
  });
  const isPdf = kind === 'pdf';
  const isDocx = kind === 'docx';
  const isMd = kind === 'markdown';
  const isText = kind === 'markdown' || kind === 'code';
  // Un contenu texte déjà en mémoire (note, fiche) ne doit jamais être cherché
  // sur le serveur statique : c'est ce détour qui menait à « fichier introuvable ».
  const preferInMemoryContent = Boolean(options.content) && (isMd || isText);

  if (titleEl) titleEl.textContent = docTitle;
  if (breadcrumbEl) breadcrumbEl.textContent = `${docSubject} / ${docFolder}`;
  if (missingFilename) missingFilename.textContent = docTitle;
  if (dropHighlight) dropHighlight.textContent = (ext ? ext.toUpperCase() : 'DOCUMENT');

  // Mise à jour visuelle du badge
  if (badgeEl) {
    badgeEl.textContent = (ext ? ext.toUpperCase() : 'DOC').slice(0, 4);
    badgeEl.className = `file-badge file-badge--${isPdf ? 'pdf' : isDocx ? 'doc' : isText ? 'code' : 'doc'}`;
  }

  // Nettoyage de l'ancien URL Blob
  if (activeBlobUrl && activeBlobUrl.startsWith('blob:')) {
    try {
      URL.revokeObjectURL(activeBlobUrl);
    } catch {}
    activeBlobUrl = null;
  }

  // Affichage immédiat de la modale
  if (typeof modal.showModal === 'function') {
    if (!modal.open) modal.showModal();
  } else {
    modal.style.display = 'flex';
  }

  // Masquage initial de tous les conteneurs
  if (frameWrapper) frameWrapper.style.display = 'none';
  if (docxWrapper) docxWrapper.style.display = 'none';
  if (textWrapper) textWrapper.style.display = 'none';
  if (missingZone) missingZone.style.display = 'none';
  if (loadingZone) loadingZone.style.display = 'none';

  let finalBlob: Blob | null = null;
  let finalUrl: string | null = null;

  // 1. URL fournie directement
  if (options.fileUrl && (options.fileUrl.startsWith('http') || options.fileUrl.startsWith('/') || options.fileUrl.startsWith('blob:'))) {
    finalUrl = options.fileUrl;
  }

  // 2. Data URL embarquée dans le cours (ou dans un cours associé portant le même nom de fichier)
  if (!finalUrl) {
    let dataUrlSource =
      options.rawCourse?.body_md && options.rawCourse.body_md.startsWith('data:')
        ? options.rawCourse.body_md
        : null;

    if (!dataUrlSource) {
      try {
        const allCourses = getUserCoursesImmediate();
        const matchingCourse = allCourses.find(
          (c) => c.title.trim().toLowerCase() === docTitle.toLowerCase() && c.body_md && c.body_md.startsWith('data:')
        );
        if (matchingCourse) {
          dataUrlSource = matchingCourse.body_md;
        }
      } catch {}
    }

    if (dataUrlSource) {
      try {
        finalBlob = dataUrlToBlob(dataUrlSource);
        activeBlobUrl = URL.createObjectURL(finalBlob);
        finalUrl = activeBlobUrl;
      } catch (e) {
        console.warn('[DocViewer] Erreur conversion dataUrl:', e);
      }
    }
  }

  // 2 bis. Contenu texte déjà disponible dans l'application (notes, fiches) :
  // on l'affiche directement, sans interroger IndexedDB, Supabase Storage ni le
  // serveur statique. C'est ce détour qui produisait « fichier introuvable ».
  if (!finalBlob && !finalUrl && preferInMemoryContent && options.content) {
    finalBlob = new Blob([options.content], { type: 'text/plain;charset=utf-8' });
    activeBlobUrl = URL.createObjectURL(finalBlob);
    finalUrl = activeBlobUrl;
  }

  // 3. Recherche locale immédiate dans IndexedDB (0ms hors-ligne)
  let userId: string | undefined;
  if (!finalBlob && !finalUrl) {
    const user = getCurrentUserCached() || (await getCurrentUser().catch(() => null));
    userId = user?.id;
    const localBlob = await findDocumentBlob(userId, docSubject, docFolder, docTitle);
    if (localBlob) {
      finalBlob = localBlob;
      activeBlobUrl = URL.createObjectURL(localBlob);
      finalUrl = activeBlobUrl;
    }
  }

  // 4. Si absent en local et utilisateur connecté : téléchargement transparent depuis Supabase Storage
  if (!finalBlob && !finalUrl && userId) {
    if (loadingZone) {
      if (loadingTitle) loadingTitle.textContent = `Téléchargement de ${docTitle}...`;
      if (loadingDesc) loadingDesc.textContent = 'Récupération sécurisée depuis votre stockage cloud Supabase...';
      loadingZone.style.display = 'flex';
    }

    try {
      const cloudBlob = await fetchAndCacheDocumentBlob(userId, docSubject, docFolder, docTitle);
      if (cloudBlob) {
        finalBlob = cloudBlob;
        activeBlobUrl = URL.createObjectURL(cloudBlob);
        finalUrl = activeBlobUrl;
      }
    } catch (err) {
      console.warn('[DocViewer] Erreur téléchargement cloud:', err);
    } finally {
      if (loadingZone) loadingZone.style.display = 'none';
    }
  }

  // 5. Si introuvable mais présent sur le serveur statique (/cours-files/...)
  if (!finalBlob && !finalUrl) {
    const basePath = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
    const candidateStaticUrls = [
      `${basePath}/cours-files/${encodeURI(docSubject)}/${encodeURI(docFolder)}/${encodeURI(docTitle)}`,
      `${basePath}/cours-files/${encodeURI(docSubject)}/${encodeURI(docTitle)}`,
      `/cours-files/${encodeURI(docSubject)}/${encodeURI(docFolder)}/${encodeURI(docTitle)}`,
    ];
    for (const staticUrl of Array.from(new Set(candidateStaticUrls))) {
      try {
        const headCheck = await fetch(staticUrl, { method: 'HEAD' });
        if (headCheck.ok) {
          finalUrl = staticUrl;
          break;
        }
      } catch {}
    }
  }

  // 6. Contenu textuel direct fourni (uniquement pour les fichiers texte / notes, jamais pour un binaire .docx/.pdf)
  if (!finalBlob && !finalUrl && !isDocx && !isPdf && options.content && options.content !== docTitle) {
    finalBlob = new Blob([options.content], { type: 'text/plain;charset=utf-8' });
    activeBlobUrl = URL.createObjectURL(finalBlob);
    finalUrl = activeBlobUrl;
  }

  // Si on a finalUrl mais pas encore finalBlob (et qu'on doit lire le contenu en JS pour docx ou text)
  if (finalUrl && !finalBlob && (isDocx || isText)) {
    try {
      const res = await fetch(finalUrl);
      if (res.ok) {
        finalBlob = await res.blob();
      }
    } catch (e) {
      console.warn('[DocViewer] Échec fetch blob depuis finalUrl:', e);
    }
  }

  if (finalUrl || finalBlob) {
    // 1. Gestion affichage PDF
    if (isPdf && frameWrapper && frame) {
      frameWrapper.style.display = 'flex';
      frame.src = (finalUrl || activeBlobUrl || '') + '#view=FitH';
    }
    // 2. Gestion affichage Word DOCX
    else if (isDocx && docxWrapper && docxContainer) {
      docxWrapper.style.display = 'flex';
      docxContainer.innerHTML = '<div style="padding: 2.5rem; text-align: center; color: var(--muted, #666);">Chargement et mise en page du document Word...</div>';

      try {
        let buffer: ArrayBuffer | null = null;
        if (finalBlob) {
          buffer = await finalBlob.arrayBuffer();
        } else if (finalUrl) {
          const resp = await fetch(finalUrl);
          buffer = await resp.arrayBuffer();
        }

        if (buffer) {
          docxContainer.innerHTML = '';
          await renderAsync(buffer, docxContainer, undefined, {
            inWrapper: false,
            ignoreWidth: false,
            ignoreHeight: false,
            breakPages: true,
            renderHeaders: true,
            renderFooters: true,
          });
        } else {
          throw new Error('Données du document Word inaccessibles.');
        }
      } catch (err: any) {
        console.warn('[DocViewer] docx-preview a échoué:', err);
        docxContainer.innerHTML = `
          <div style="padding: 3rem 1.5rem; text-align: center; max-width: 500px; margin: 0 auto;">
            <div style="font-size: 2.5rem; margin-bottom: 1rem;">📄</div>
            <h3 style="margin-bottom: 0.5rem;">Aperçu direct non disponible</h3>
            <p style="color: var(--muted); font-size: 0.92rem; line-height: 1.6; margin-bottom: 1.5rem;">
              Ce document Word (${esc(docTitle)}) ne peut pas être converti directement dans le navigateur (format binaire .doc ancien ou fichier protégé).
            </p>
            <a href="${esc(finalUrl)}" download="${esc(docTitle)}" class="btn btn--primary" style="display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.6rem 1.2rem; text-decoration: none;">
              📥 Télécharger le fichier Word
            </a>
          </div>
        `;
      }
    }
    // 3. Gestion affichage Texte / Code / Markdown
    else if (textWrapper) {
      textWrapper.style.display = 'flex';
      let rawText = '';
      if (finalBlob) {
        rawText = await finalBlob.text();
      } else if (options.content) {
        rawText = options.content;
      } else if (finalUrl) {
        try {
          const resp = await fetch(finalUrl);
          rawText = await resp.text();
        } catch {
          rawText = options.content || '';
        }
      }

      if (textInfo) {
        textInfo.textContent = `${ext.toUpperCase()} · ${rawText.split('\n').length} lignes`;
      }

      if (isMd && mdContent) {
        mdContent.style.display = 'block';
        if (codePre) codePre.style.display = 'none';
        mdContent.innerHTML = renderNotionMarkdown(rawText);
      } else {
        if (mdContent) mdContent.style.display = 'none';
        if (codePre && codeContent) {
          codePre.style.display = 'block';
          codeContent.textContent = rawText;
        }
      }
    }

    // Configuration des actions
    if (btnNewTab) {
      btnNewTab.style.display = 'inline-flex';
      if (btnFullscreenText) {
        btnFullscreenText.textContent = isPdf ? 'Nouvel onglet' : 'Plein écran';
      }
      btnNewTab.onclick = () => {
        if (isPdf && finalUrl) {
          window.open(finalUrl, '_blank');
        } else {
          if (!document.fullscreenElement) {
            modal.requestFullscreen().catch(() => {
              if (finalUrl) window.open(finalUrl, '_blank');
            });
          } else {
            document.exitFullscreen().catch(() => {});
          }
        }
      };
    }

    if (btnDownload) {
      btnDownload.style.display = 'inline-flex';
      btnDownload.href = finalUrl || '#';
      btnDownload.download = docTitle;
      btnDownload.onclick = (e) => {
        if (!finalUrl && finalBlob) {
          e.preventDefault();
          const u = URL.createObjectURL(finalBlob);
          const a = document.createElement('a');
          a.href = u;
          a.download = docTitle;
          a.click();
          setTimeout(() => URL.revokeObjectURL(u), 1000);
        }
      };
    }
  } else {
    // Document non trouvé en cache local
    if (missingZone) missingZone.style.display = 'flex';
    if (btnNewTab) btnNewTab.style.display = 'none';
    if (btnDownload) btnDownload.style.display = 'none';
  }
}

// Rétrocompatibilité : openPdfViewer redirige vers le visualiseur universel
export const openPdfViewer = openDocumentViewer;
