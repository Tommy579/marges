/**
 * Module de stockage de documents et fichiers de cours.
 * Combine un cache local persistant haute performance (IndexedDB - 0 ms)
 * avec une synchronisation automatique dans Supabase Storage (bucket privé 'course-files')
 * pour un accès multi-appareils (PC, mobile, tablettes).
 */

import { getSupabase, getCurrentUserCached, getUserCoursesImmediate } from './supabase';

const DB_NAME = 'marges_documents_db';
const DB_VERSION = 1;
const STORE_NAME = 'files';

export const COURSE_FILES_BUCKET = 'course-files';

function openDocDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !window.indexedDB) {
      return reject(new Error('IndexedDB non disponible'));
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Normalise un segment de chemin pour Supabase Storage (S3-compatible) :
 * supprime les accents, remplace les espaces et caractères spéciaux par des underscores,
 * préserve l'extension et évite les doubles séparateurs.
 */
export function sanitizeStorageSegment(segment: string): string {
  if (!segment) return '';
  return segment
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // suppression des diacritiques
    .replace(/[^a-zA-Z0-9._-]/g, '_') // caractères sûrs uniquement
    .replace(/_+/g, '_') // contraction des underscores consécutifs
    .replace(/^_+|_+$/g, ''); // retrait des underscores aux extrémités
}

/**
 * Construit un chemin déterministe dans le bucket 'course-files' sous la forme :
 * ${userId}/${cleanSubject}/${cleanFolder}/${cleanFileName} ou ${userId}/${cleanFileName}
 */
export function buildStoragePath(
  userId: string,
  subject?: string,
  folder?: string,
  fileName?: string
): string {
  if (!userId) return '';
  const cleanSubject = subject && subject !== 'Général' && subject !== 'Cours' ? sanitizeStorageSegment(subject) : '';
  const cleanFolder =
    folder &&
    folder !== 'Document' &&
    folder !== 'Documents' &&
    folder !== 'Documents généraux' &&
    folder !== 'Documents racines' &&
    folder !== 'Fiches & Notes'
      ? sanitizeStorageSegment(folder)
      : '';
  const cleanFile = fileName ? sanitizeStorageSegment(fileName) : '';

  const segments = [userId];
  if (cleanSubject) segments.push(cleanSubject);
  if (cleanFolder) segments.push(cleanFolder);
  if (cleanFile) segments.push(cleanFile);

  return segments.join('/');
}

/**
 * Retourne les différents chemins candidats possibles sur Supabase Storage pour un document donné.
 */
export function getCandidateStoragePaths(
  userId: string,
  subject?: string,
  folder?: string,
  fileName?: string
): string[] {
  if (!userId || !fileName) return [];
  const cleanFile = sanitizeStorageSegment(fileName);
  const cleanSubject = subject && subject !== 'Général' && subject !== 'Cours' ? sanitizeStorageSegment(subject) : '';
  const cleanFolder =
    folder &&
    folder !== 'Document' &&
    folder !== 'Documents' &&
    folder !== 'Documents généraux' &&
    folder !== 'Documents racines' &&
    folder !== 'Fiches & Notes'
      ? sanitizeStorageSegment(folder)
      : '';

  const paths: string[] = [];
  if (cleanSubject && cleanFolder) {
    paths.push(`${userId}/${cleanSubject}/${cleanFolder}/${cleanFile}`);
  }
  if (cleanSubject) {
    paths.push(`${userId}/${cleanSubject}/Documents_generaux/${cleanFile}`);
    paths.push(`${userId}/${cleanSubject}/Documents/${cleanFile}`);
    paths.push(`${userId}/${cleanSubject}/CM/${cleanFile}`);
    paths.push(`${userId}/${cleanSubject}/TD/${cleanFile}`);
    paths.push(`${userId}/${cleanSubject}/TP/${cleanFile}`);
    paths.push(`${userId}/${cleanSubject}/${cleanFile}`);
  }
  paths.push(`${userId}/${cleanFile}`);

  return Array.from(new Set(paths));
}

/**
 * Détermine le type MIME approprié pour l'en-tête HTTP du téléversement.
 */
export function getMimeType(fileName: string, fallback?: string): string {
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  switch (ext) {
    case 'pdf':
      return 'application/pdf';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'doc':
      return 'application/msword';
    case 'txt':
    case 'text':
    case 'md':
    case 'c':
    case 'h':
    case 'cpp':
    case 'java':
    case 'py':
    case 'js':
    case 'ts':
    case 'sh':
    case 'sci':
    case 'sce':
    case 'm':
      return 'text/plain;charset=utf-8';
    case 'json':
      return 'application/json';
    case 'csv':
      return 'text/csv;charset=utf-8';
    default:
      return fallback || 'application/octet-stream';
  }
}

/**
 * Extrait les métadonnées d'une clé IndexedDB textuelle (ex: "doc:userId:subject:folder:fileName").
 */
export function parseDocKey(key: string): {
  userId?: string;
  subject?: string;
  folder?: string;
  fileName: string;
} | null {
  if (!key) return null;
  const parts = key.split(':');
  if (parts[0] === 'doc') {
    if (parts.length === 5) {
      return { userId: parts[1], subject: parts[2], folder: parts[3], fileName: parts[4] };
    }
    if (parts.length === 4) {
      return { userId: parts[1], subject: parts[2], fileName: parts[3] };
    }
    if (parts.length === 3) {
      return { userId: parts[1], fileName: parts[2] };
    }
    if (parts.length === 2) {
      return { fileName: parts[1] };
    }
  }
  if (key.includes('/')) {
    const segments = key.split('/').filter(Boolean);
    if (segments.length >= 3) {
      return { subject: segments[0], folder: segments[1], fileName: segments.slice(2).join('/') };
    }
    if (segments.length === 2) {
      return { subject: segments[0], fileName: segments[1] };
    }
    return { fileName: segments[0] };
  }
  return { fileName: key };
}

// Suivi en mémoire pour éviter d'uploader le même fichier en doublon plusieurs fois d'affilée
const inFlightUploads = new Set<string>();

/**
 * Envoie un fichier/Blob vers le bucket 'course-files' de Supabase Storage.
 */
export async function uploadDocumentToSupabaseStorage(
  storagePath: string,
  blobOrFile: Blob | File
): Promise<boolean> {
  if (typeof window === 'undefined' || !storagePath) return false;
  if (inFlightUploads.has(storagePath)) return true;

  inFlightUploads.add(storagePath);
  try {
    const sb = getSupabase();
    const contentType = getMimeType(storagePath, blobOrFile.type);
    const { error } = await sb.storage
      .from(COURSE_FILES_BUCKET)
      .upload(storagePath, blobOrFile, {
        upsert: true,
        contentType,
      });

    if (error) {
      console.warn('[DocStorage] Erreur upload Supabase Storage:', storagePath, error);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[DocStorage] Exception upload Supabase Storage:', err);
    return false;
  } finally {
    setTimeout(() => inFlightUploads.delete(storagePath), 5000);
  }
}

/**
 * Télécharge un fichier depuis le bucket 'course-files' de Supabase Storage.
 */
export async function downloadDocumentFromSupabaseStorage(
  storagePath: string
): Promise<Blob | null> {
  if (typeof window === 'undefined' || !storagePath) return null;
  try {
    const sb = getSupabase();
    const { data, error } = await sb.storage
      .from(COURSE_FILES_BUCKET)
      .download(storagePath);

    if (error || !data) {
      return null;
    }
    return data;
  } catch (err) {
    console.warn('[DocStorage] Exception download Supabase Storage:', storagePath, err);
    return null;
  }
}

/**
 * Supprime un ou plusieurs fichiers du bucket 'course-files'.
 */
export async function deleteDocumentFromSupabaseStorage(
  storagePaths: string[]
): Promise<void> {
  if (typeof window === 'undefined' || !storagePaths.length) return;
  try {
    const sb = getSupabase();
    const validPaths = storagePaths.filter(Boolean);
    if (validPaths.length > 0) {
      await sb.storage.from(COURSE_FILES_BUCKET).remove(validPaths);
    }
  } catch (err) {
    console.warn('[DocStorage] Erreur delete Supabase Storage:', err);
  }
}

/**
 * Sauvegarde un Blob / File dans IndexedDB sous une ou plusieurs clés,
 * et déclenche automatiquement l'envoi en tâche de fond vers Supabase Storage si authentifié.
 */
export async function saveDocumentBlob(key: string, blob: Blob | File): Promise<void> {
  try {
    const db = await openDocDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(blob, key.toLowerCase());
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('[DocStorage] Erreur sauvegarde IndexedDB:', err);
  }

  // Si la clé contient les métadonnées de l'utilisateur, déclencher la synchronisation Cloud
  try {
    const user = getCurrentUserCached();
    const activeUserId = user?.id;
    if (activeUserId) {
      const parsed = parseDocKey(key);
      if (parsed && parsed.fileName && (parsed.userId === activeUserId || key.startsWith(`doc:${activeUserId}:`))) {
        const storagePath = buildStoragePath(activeUserId, parsed.subject, parsed.folder, parsed.fileName);
        if (storagePath) {
          uploadDocumentToSupabaseStorage(storagePath, blob).catch(() => {});
        }
      }
    }
  } catch {}
}

/**
 * Sauvegarde complète et unifiée d'un fichier :
 * 1) Enregistre localement dans IndexedDB sous toutes les variantes de clés usuelles (pour accès 0 ms immédiat).
 * 2) Téléverse de manière asynchrone dans le bucket Supabase Storage si un utilisateur est connecté.
 */
export async function saveDocumentFile(
  blobOrFile: Blob | File,
  options: {
    userId?: string;
    subject?: string;
    folder?: string;
    fileName: string;
  }
): Promise<void> {
  const user = getCurrentUserCached();
  const userId = options.userId || user?.id || '';
  const cleanSubject = (options.subject || '').trim();
  const cleanFolder = (options.folder || '').trim();
  const fileName = options.fileName.trim();

  // 1. Sauvegarde dans IndexedDB sous les clés canoniques et leurs alias
  const candidateKeys = [
    `doc:${userId}:${cleanSubject}:${cleanFolder}:${fileName}`,
    `doc:${userId}:${fileName}`,
    `doc:${cleanSubject}:${cleanFolder}:${fileName}`,
    `doc:${fileName}`,
    `${cleanSubject}/${cleanFolder}/${fileName}`,
    fileName,
  ];

  try {
    const db = await openDocDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      candidateKeys.forEach((k) => {
        store.put(blobOrFile, k.toLowerCase());
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('[DocStorage] Erreur saveDocumentFile dans IndexedDB:', err);
  }

  // 2. Synchronisation automatique vers Supabase Storage
  if (userId) {
    const storagePath = buildStoragePath(userId, cleanSubject, cleanFolder, fileName);
    if (storagePath) {
      uploadDocumentToSupabaseStorage(storagePath, blobOrFile).catch((e) =>
        console.warn('[DocStorage] Erreur synchronisation Cloud:', storagePath, e)
      );
    }
  }
}

/**
 * Récupère un Blob depuis IndexedDB sous une clé donnée.
 */
export async function getDocumentBlob(key: string): Promise<Blob | null> {
  try {
    const db = await openDocDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key.toLowerCase());
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

/**
 * Recherche un fichier dans le bucket Supabase Storage par son nom (insensible à la casse et aux accents)
 * en parcourant le dossier de la matière ou le dossier racine de l'utilisateur.
 */
async function findStoragePathInBucket(
  userId: string,
  subject: string,
  fileName: string
): Promise<string | null> {
  if (typeof window === 'undefined' || !userId || !fileName) return null;
  try {
    const sb = getSupabase();
    const targetSanitized = sanitizeStorageSegment(fileName).toLowerCase();
    const cleanSubject = subject && subject !== 'Général' && subject !== 'Cours' ? sanitizeStorageSegment(subject) : '';

    const foldersToScan = cleanSubject ? [`${userId}/${cleanSubject}`, userId] : [userId];

    for (const prefix of foldersToScan) {
      const { data: items, error } = await sb.storage.from(COURSE_FILES_BUCKET).list(prefix, { limit: 200 });
      if (error || !items) continue;

      const subdirs: string[] = [];
      for (const item of items) {
        if (!item.name) continue;
        // Un fichier possède un id ou metadata, un dossier n'a généralement pas d'id
        const itemSanitized = sanitizeStorageSegment(item.name).toLowerCase();
        if (item.name.toLowerCase() === fileName.toLowerCase() || itemSanitized === targetSanitized) {
          return `${prefix}/${item.name}`;
        }
        if (!item.id && !item.name.includes('.')) {
          subdirs.push(`${prefix}/${item.name}`);
        }
      }

      // Scanner un niveau de sous-dossiers (ex: CM, TD, Documents_generaux...)
      for (const sub of subdirs) {
        const { data: subItems } = await sb.storage.from(COURSE_FILES_BUCKET).list(sub, { limit: 200 });
        if (!subItems) continue;
        for (const subItem of subItems) {
          if (!subItem.name) continue;
          const subSanitized = sanitizeStorageSegment(subItem.name).toLowerCase();
          if (subItem.name.toLowerCase() === fileName.toLowerCase() || subSanitized === targetSanitized) {
            return `${sub}/${subItem.name}`;
          }
        }
      }
    }
  } catch (err) {
    console.warn('[DocStorage] Erreur recherche bucket:', err);
  }
  return null;
}

/**
 * Recherche intelligente d'un document localement dans IndexedDB selon plusieurs variantes de clé.
 */
export async function findDocumentBlob(
  userId: string | undefined,
  subject: string,
  folder: string,
  fileName: string
): Promise<Blob | null> {
  const cleanUser = userId || 'anon';
  const cleanSubject = subject.trim();
  const cleanFolder = folder.trim();
  const cleanFile = fileName.trim();
  const sanitizedFile = sanitizeStorageSegment(cleanFile);

  const candidateKeys = [
    `doc:${cleanUser}:${cleanSubject}:${cleanFolder}:${cleanFile}`,
    `doc:${cleanUser}:${cleanSubject}:${cleanFile}`,
    `doc:${cleanUser}:${cleanFile}`,
    `doc::${cleanSubject}:${cleanFolder}:${cleanFile}`,
    `doc::${cleanFile}`,
    `doc:${cleanSubject}:${cleanFolder}:${cleanFile}`,
    `doc:${cleanSubject}:${cleanFile}`,
    `doc:${cleanFile}`,
    `${cleanSubject}/${cleanFolder}/${cleanFile}`,
    `${cleanSubject}/${cleanFile}`,
    cleanFile,
    sanitizedFile,
  ];

  for (const k of candidateKeys) {
    const blob = await getDocumentBlob(k);
    if (blob) return blob;
  }

  // Fallback : parcourir les clés d'IndexedDB pour trouver toute clé se terminant par le nom du fichier
  try {
    const entries = await getAllLocalDocumentEntries();
    const targetLower = cleanFile.toLowerCase();
    const targetSanitizedLower = sanitizedFile.toLowerCase();
    for (const entry of entries) {
      const k = entry.key.toLowerCase();
      const blobName = ((entry.blob as any)?.name || '').toLowerCase();
      if (
        k === targetLower ||
        k.endsWith(`:${targetLower}`) ||
        k.endsWith(`/${targetLower}`) ||
        (targetSanitizedLower && (k.endsWith(`:${targetSanitizedLower}`) || k.endsWith(`/${targetSanitizedLower}`))) ||
        blobName === targetLower
      ) {
        return entry.blob;
      }
    }
  } catch {}

  return null;
}

/**
 * Recherche transparente avec repli Cloud :
 * 1. Vérifie d'abord l'IndexedDB locale (0 ms de latence).
 * 2. Vérifie si un cours local contient déjà une DataURL ou le contenu pour ce fichier.
 * 3. Si absent et utilisateur connecté, télécharge automatiquement depuis Supabase Storage.
 * 4. Enregistre le Blob téléchargé dans l'IndexedDB locale pour les prochaines consultations.
 */
export async function fetchAndCacheDocumentBlob(
  userId: string | undefined,
  subject: string,
  folder: string,
  fileName: string
): Promise<Blob | null> {
  // 1. Recherche locale instantanée
  const localBlob = await findDocumentBlob(userId, subject, folder, fileName);
  if (localBlob) return localBlob;

  // 2. Recherche dans les cours locaux (si un enregistrement individuel contient une data: URL)
  try {
    const courses = getUserCoursesImmediate();
    const targetLower = fileName.trim().toLowerCase();
    const matchCourse = courses.find(
      (c) => c.title.trim().toLowerCase() === targetLower && c.body_md && c.body_md.startsWith('data:')
    );
    if (matchCourse) {
      const blob = dataUrlToBlob(matchCourse.body_md);
      await saveDocumentFile(blob, { userId, subject, folder, fileName });
      return blob;
    }
  } catch {}

  // 3. Si absent mais utilisateur connecté, tentative de téléchargement depuis Supabase Storage
  const activeUser = userId || getCurrentUserCached()?.id;
  if (!activeUser) return null;

  const candidatePaths = getCandidateStoragePaths(activeUser, subject, folder, fileName);

  for (const path of candidatePaths) {
    const cloudBlob = await downloadDocumentFromSupabaseStorage(path);
    if (cloudBlob) {
      await saveDocumentFile(cloudBlob, {
        userId: activeUser,
        subject,
        folder,
        fileName,
      });
      return cloudBlob;
    }
  }

  // 4. Recherche dynamique par listage du bucket si le chemin exact différait
  const discoveredPath = await findStoragePathInBucket(activeUser, subject, fileName);
  if (discoveredPath && !candidatePaths.includes(discoveredPath)) {
    const cloudBlob = await downloadDocumentFromSupabaseStorage(discoveredPath);
    if (cloudBlob) {
      await saveDocumentFile(cloudBlob, {
        userId: activeUser,
        subject,
        folder,
        fileName,
      });
      return cloudBlob;
    }
  }

  return null;
}

/**
 * Supprime un document d'IndexedDB et du bucket Supabase Storage.
 */
export async function deleteDocumentBlob(
  key: string,
  options?: { userId?: string; subject?: string; folder?: string; fileName?: string }
): Promise<void> {
  try {
    const db = await openDocDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(key.toLowerCase());
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('[DocStorage] Erreur suppression locale:', err);
  }

  // Suppression sur Supabase Storage
  try {
    const user = getCurrentUserCached();
    const userId = options?.userId || user?.id;
    const parsed = parseDocKey(key);
    const fileName = options?.fileName || parsed?.fileName;
    if (userId && fileName) {
      const candidatePaths = getCandidateStoragePaths(
        userId,
        options?.subject || parsed?.subject,
        options?.folder || parsed?.folder,
        fileName
      );
      deleteDocumentFromSupabaseStorage(candidatePaths).catch(() => {});
    }
  } catch {}
}

/**
 * Supprime un document sous toutes ses clés locales et distantes.
 */
export async function deleteDocumentFile(
  fileName: string,
  options?: { userId?: string; subject?: string; folder?: string }
): Promise<void> {
  const user = getCurrentUserCached();
  const userId = options?.userId || user?.id || '';
  const cleanSubject = options?.subject || '';
  const cleanFolder = options?.folder || '';

  const candidateKeys = [
    `doc:${userId}:${cleanSubject}:${cleanFolder}:${fileName}`,
    `doc:${userId}:${fileName}`,
    `doc:${cleanSubject}:${cleanFolder}:${fileName}`,
    `doc:${fileName}`,
    `${cleanSubject}/${cleanFolder}/${fileName}`,
    fileName,
  ];

  try {
    const db = await openDocDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      candidateKeys.forEach((k) => store.delete(k.toLowerCase()));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('[DocStorage] Erreur suppression multiple IndexedDB:', err);
  }

  if (userId) {
    const candidatePaths = getCandidateStoragePaths(userId, cleanSubject, cleanFolder, fileName);
    deleteDocumentFromSupabaseStorage(candidatePaths).catch(() => {});
  }
}

/**
 * Récupère l'ensemble des entrées de documents enregistrées dans IndexedDB.
 */
export async function getAllLocalDocumentEntries(): Promise<Array<{ key: string; blob: Blob }>> {
  if (typeof window === 'undefined' || !window.indexedDB) return [];
  try {
    const db = await openDocDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const results: Array<{ key: string; blob: Blob }> = [];
      const req = store.openCursor();
      req.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          if (cursor.value instanceof Blob) {
            results.push({ key: String(cursor.key), blob: cursor.value });
          }
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export interface StorageSyncProgress {
  total: number;
  current: number;
  currentFile: string;
}

export interface StorageSyncResult {
  syncedCount: number;
  alreadyCount: number;
  totalCount: number;
  errors: string[];
}

/**
 * Migration / Synchronisation complète des fichiers déjà présents dans l'IndexedDB locale vers Supabase Storage.
 * Parcourt les documents stockés sur la machine, les corrèle avec les cours enregistrés et les téléverse
 * automatiquement s'ils n'existent pas encore dans le bucket de l'utilisateur.
 */
export async function syncLocalFilesToSupabaseStorage(
  onProgress?: (progress: StorageSyncProgress) => void
): Promise<StorageSyncResult> {
  const user = getCurrentUserCached();
  const userId = user?.id;
  if (!userId) {
    return { syncedCount: 0, alreadyCount: 0, totalCount: 0, errors: ['Utilisateur non connecté'] };
  }

  const entries = await getAllLocalDocumentEntries();
  if (entries.length === 0) {
    return { syncedCount: 0, alreadyCount: 0, totalCount: 0, errors: [] };
  }

  // Corrélation avec les cours locaux pour retrouver le sujet et le dossier
  const userCourses = getUserCoursesImmediate();
  const fileToCourseMeta = new Map<string, { subject: string; folder: string }>();

  userCourses.forEach((c) => {
    const subject = c.title;
    const lines = (c.body_md || '').split('\n');
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
          fileToCourseMeta.set(fileName.toLowerCase(), { subject, folder: currentFolder });
        }
      }
    }
  });

  // Dédoublonnage des entrées IndexedDB
  const filesMap = new Map<string, { subject?: string; folder?: string; fileName: string; blob: Blob }>();

  for (const entry of entries) {
    const parsed = parseDocKey(entry.key);
    if (!parsed || !parsed.fileName || !parsed.fileName.includes('.')) continue;

    // Préférer le nom de fichier avec sa casse d'origine si l'objet Blob est un File
    const originalName = (entry.blob as any).name || parsed.fileName;
    const lowerName = originalName.toLowerCase();

    let subject = parsed.subject;
    let folder = parsed.folder;

    if (!subject && fileToCourseMeta.has(lowerName)) {
      const meta = fileToCourseMeta.get(lowerName)!;
      subject = meta.subject;
      folder = meta.folder;
    }

    const uniqueId = `${subject || ''}/${folder || ''}/${lowerName}`;
    if (!filesMap.has(uniqueId)) {
      filesMap.set(uniqueId, {
        subject,
        folder,
        fileName: originalName,
        blob: entry.blob,
      });
    }
  }

  const uniqueFiles = Array.from(filesMap.values());
  const totalCount = uniqueFiles.length;
  let syncedCount = 0;
  let alreadyCount = 0;
  const errors: string[] = [];

  for (let i = 0; i < uniqueFiles.length; i++) {
    const item = uniqueFiles[i];
    onProgress?.({
      total: totalCount,
      current: i + 1,
      currentFile: item.fileName,
    });

    const storagePath = buildStoragePath(userId, item.subject, item.folder, item.fileName);
    if (!storagePath) continue;

    const contentType = getMimeType(item.fileName, item.blob.type);
    const sb = getSupabase();

    // Téléversement sans écrasement préalable pour détecter les fichiers déjà présents
    const { error } = await sb.storage
      .from(COURSE_FILES_BUCKET)
      .upload(storagePath, item.blob, {
        upsert: false,
        contentType,
      });

    if (error) {
      const msg = error.message || String(error);
      if (
        msg.includes('already exists') ||
        msg.includes('Duplicate') ||
        (error as any).statusCode === 409 ||
        (error as any).statusCode === '409'
      ) {
        alreadyCount++;
      } else {
        console.warn('[StorageSync] Erreur upload:', storagePath, error);
        errors.push(`${item.fileName}: ${msg}`);
      }
    } else {
      syncedCount++;
    }
  }

  return { syncedCount, alreadyCount, totalCount, errors };
}

/**
 * Convertit un DataURL base64 (ex: data:application/pdf;base64,...) en un Blob natif.
 */
export function dataUrlToBlob(dataUrl: string): Blob {
  const arr = dataUrl.split(',');
  const mimeMatch = arr[0].match(/:(.*?);/);
  const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) {
    u8arr[n] = bstr.charCodeAt(n);
  }
  return new Blob([u8arr], { type: mime });
}
