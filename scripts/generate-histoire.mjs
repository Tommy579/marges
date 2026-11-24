import fs from 'node:fs';
import path from 'node:path';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';

// Charge le fichier .env local s'il existe (Node 20.12+ / 22+)
try {
  if (fs.existsSync(path.resolve('.env')) && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(path.resolve('.env'));
  }
} catch {
  // Ignore si .env est absent ou déjà injecté dans l'environnement
}

// 1. Clé API (Google Cloud Console prioritaire, fallback GEMINI_API_KEY)
const apiKey = (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || '').trim();
if (!apiKey) {
  console.error("❌ Erreur : Variable d'environnement GOOGLE_API_KEY (ou GEMINI_API_KEY) manquante.");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });

const targetDir = path.resolve('src/content/textes');
const STORY_TYPE = 'histoire';

// Longueur demandée au modèle, et bornes réellement acceptées.
// Entre les deux : simple avertissement. Au-delà : on redemande une génération.
const MIN_WORDS = 350;
const MAX_WORDS = 550;
const HARD_MIN_WORDS = 300;
const HARD_MAX_WORDS = 650;

// Ambiances tirées au hasard pour varier les histoires d'un jour à l'autre.
const AMBIANCES = [
  'un objet du quotidien qui prend vie discrètement',
  'une petite aventure matinale dans un quartier endormi',
  'une amitié inattendue entre un chat curieux et un vieux livre',
  'une promenade sous la pluie avec une tasse de thé fumante',
  'une cozy fantasy légère dans un atelier de réparation d’étoiles',
  'un secret partagé au coin d’une fenêtre en automne',
  'une balade au marché aux fleurs un matin de printemps',
  'une bibliothèque de village qui ouvre juste avant l’aube',
];

/**
 * Mentions interdites dans le texte public : elles trahiraient la consigne
 * interne (histoire brève destinée à un jeune lectorat) et cassent le ton.
 */
const FORBIDDEN_MENTIONS = [
  { pattern: /\bados?\b/i, label: 'ados' },
  { pattern: /\badolescent(?:e)?s?\b/i, label: 'adolescent' },
  { pattern: /\b(?:2|deux)\s*[-–—à]\s*3\s*minutes\b/i, label: '2-3 minutes' },
  { pattern: /\bcourte\s+histoire\b|\bhistoire\s+courte\b|\bnouvelle\s+courte\b/i, label: 'courte histoire' },
  { pattern: /\bhistoire\s+du\s+soir\b/i, label: 'histoire du soir' },
  { pattern: /\bjeunes?\s+lecteurs?\b/i, label: 'jeunes lecteurs' },
  { pattern: /\bpour\s+(?:les\s+)?enfants\b/i, label: 'pour les enfants' },
];

const todayDate = new Date().toISOString().slice(0, 10);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Erreur de validation du contenu renvoyé par le modèle (frontmatter manquant,
 * texte hors bornes, mention interdite…). Le prompt ne change pas : on réessaie
 * avec le même modèle, la génération étant stochastique.
 */
class ContentValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ContentValidationError';
  }
}

/** Inventaire des histoires déjà publiées (dédoublonnage + anti-doublon du jour). */
function getExistingStories() {
  if (!fs.existsSync(targetDir)) return [];
  const files = fs.readdirSync(targetDir).filter((f) => f.endsWith('.md') || f.endsWith('.mdx'));
  const stories = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(targetDir, file), 'utf-8');
      if (!/^type:\s*"?histoire"?\s*$/m.test(content)) continue;

      const titleMatch = content.match(/^title:\s*"([^"]+)"/m);
      const dateMatch = content.match(/^date:\s*(\d{4}-\d{2}-\d{2})\s*$/m);
      stories.push({
        file,
        title: titleMatch ? titleMatch[1] : file,
        date: dateMatch ? dateMatch[1] : '',
      });
    } catch {
      // Fichier illisible : on l'ignore, il ne doit pas bloquer la génération.
    }
  }

  return stories;
}

/** Compte les mots d'un texte (les fragments purement ponctuation sont ignorés). */
function countWords(text) {
  return text
    .split(/\s+/)
    .map((token) => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(Boolean).length;
}

/** Détecte si une erreur de l'API Gemini est temporaire (503, 429, 500, etc.). */
function isTransientError(err) {
  if (!err) return false;
  if (err instanceof ContentValidationError) return true;

  // Le SDK expose parfois un code HTTP numérique fiable : on le préfère aux regex.
  const status = Number(err.status ?? err.code ?? err.httpStatus);
  if (Number.isFinite(status)) {
    if ([429, 500, 502, 503, 504].includes(status)) return true;
    if (status >= 400) return false; // 400/401/403/404 : inutile d'insister
  }

  const msg = typeof err === 'string'
    ? err
    : `${err.message || ''} ${err.statusText || ''} ${err.code || ''}`;

  const patterns = [
    /\b503\b/, /\b429\b/, /\b500\b/, /\b502\b/, /\b504\b/,
    /UNAVAILABLE/i, /RESOURCE_EXHAUSTED/i, /INTERNAL/i,
    /BAD_GATEWAY/i, /GATEWAY_TIMEOUT/i,
    /high demand/i, /spikes in demand/i, /temporarily unavailable/i,
    /overloaded/i, /rate limit/i, /quota exceeded/i,
    /fetch failed/i, /ECONNRESET/i, /ETIMEDOUT/i,
    // Réponses tronquées ou vides : cela vaut un nouvel essai.
    /MAX_TOKENS/i, /no text/i, /empty response/i,
  ];

  return patterns.some((p) => p.test(msg));
}

/** Résumé court de l'erreur pour les logs. */
function getErrorSummary(err) {
  if (!err) return 'UNKNOWN';
  if (err.status) return String(err.status);
  const msg = err.message || '';
  const match = msg.match(/"code":\s*(\d+)/) || msg.match(/\b(503|429|500|502|504)\b/);
  if (match) return match[1];
  const statusMatch = msg.match(/"status":\s*"([^"]+)"/);
  if (statusMatch) return statusMatch[1];
  return 'UNKNOWN';
}

function unquote(value) {
  return value.trim().replace(/^["']|["']$/g, '').trim();
}

/**
 * Extrait et normalise une histoire à partir de la réponse brute du modèle.
 *
 * Le frontmatter est reconstruit à partir des champs réellement extraits (titre,
 * résumé, sous-titre) : on garantit ainsi un YAML conforme au schéma de
 * src/content.config.ts, quel que soit le formatage du modèle (guillemets
 * manquants, champ `date` erroné, `themes` inventés, etc.).
 */
function parseStory(rawText) {
  const cleaned = rawText
    .replace(/^```(?:markdown|md)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();

  if (!cleaned.startsWith('---')) {
    throw new ContentValidationError('Le frontmatter YAML est absent ou mal formé.');
  }

  const end = cleaned.indexOf('\n---', 3);
  if (end === -1) {
    throw new ContentValidationError('Bloc de frontmatter non refermé par « --- ».');
  }

  const frontmatter = cleaned.slice(3, end);
  const body = cleaned.slice(end + 4).replace(/^\s*\n/, '').trim();

  const field = (key) => {
    const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return match ? unquote(match[1]) : '';
  };

  const title = field('title');
  const summary = field('summary');
  const subtitle = field('subtitle');

  if (!title) {
    throw new ContentValidationError("Titre absent du frontmatter.");
  }
  if (!summary) {
    throw new ContentValidationError('Champ « summary » absent du frontmatter.');
  }
  if (!body) {
    throw new ContentValidationError('Corps du texte vide.');
  }

  const words = countWords(body);
  if (words < HARD_MIN_WORDS || words > HARD_MAX_WORDS) {
    throw new ContentValidationError(
      `Longueur hors bornes : ${words} mots (attendu ${MIN_WORDS}-${MAX_WORDS}).`
    );
  }
  if (words < MIN_WORDS || words > MAX_WORDS) {
    console.warn(`⚠️ Longueur imprécise : ${words} mots (cible ${MIN_WORDS}-${MAX_WORDS}). Accepté.`);
  }

  const haystack = `${title}\n${summary}\n${body}`;
  const banned = FORBIDDEN_MENTIONS.filter(({ pattern }) => pattern.test(haystack));
  if (banned.length > 0) {
    throw new ContentValidationError(
      `Mention(s) interdite(s) détectée(s) : ${banned.map((b) => `« ${b.label} »`).join(', ')}.`
    );
  }

  return { title, summary, subtitle, body, words };
}

/** Échappe une chaîne pour une valeur YAML entre guillemets doubles. */
function yamlString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Assemble le fichier final (frontmatter conforme au schéma + corps). */
function buildFileContent(story) {
  const lines = [
    '---',
    `title: ${yamlString(story.title)}`,
  ];
  if (story.subtitle) lines.push(`subtitle: ${yamlString(story.subtitle)}`);
  lines.push(
    `date: ${todayDate}`,
    `summary: ${yamlString(story.summary)}`,
    `type: ${STORY_TYPE}`,
    'isAiGenerated: true',
    '---',
    '',
    story.body,
    ''
  );
  return lines.join('\n');
}

/** Slug de fichier ASCII (ex. 2026-11-24-le-vieux-banc-de-l-etang.md). */
function slugify(title) {
  return (
    title
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'histoire-du-jour'
  );
}

// Délais de rétrogradation exponentielle (Exponential Backoff)
const RETRY_DELAYS_MS = [10_000, 25_000, 60_000, 120_000];
const MAX_RETRIES = RETRY_DELAYS_MS.length;

/**
 * Appel Gemini avec Exponential Backoff + Jitter et fallback multi-modèles.
 */
async function generateWithFallbackAndRetry(prompt) {
  const thinkingLevel = process.env.GEMINI_THINKING_LEVEL || ThinkingLevel.MEDIUM;
  const candidateModels = Array.from(
    new Set(
      [
        process.env.GEMINI_MODEL,
        'gemini-4-neon',
        'gemini-3.8-flash',
        'gemini-3.5-flash-lite',
        'gemini-3.1-flash-lite',
      ].filter(Boolean)
    )
  );

  let lastError = null;

  for (let modelIdx = 0; modelIdx < candidateModels.length; modelIdx++) {
    const model = candidateModels[modelIdx];
    console.log(`\n🎯 Modèle sélectionné [${modelIdx + 1}/${candidateModels.length}] : ${model} (thinking=${thinkingLevel})`);

    // Tentative initiale (0) + jusqu'à MAX_RETRIES réessais
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: prompt,
          config: {
            temperature: 0.9,
            thinkingConfig: {
              thinkingLevel,
            },
          },
        });

        // ⚠️ `response.text` est une *propriété* (getter) du SDK @google/genai :
        // l'écrire `response.text()` lève « response.text is not a function ».
        const rawText = typeof response.text === 'string' ? response.text.trim() : '';
        if (!rawText) {
          throw new ContentValidationError('Réponse vide du modèle (response.text vide).');
        }

        const story = parseStory(rawText);

        return { story, modelUsed: model };
      } catch (err) {
        lastError = err;
        const isTransient = isTransientError(err);
        const errCode = getErrorSummary(err);

        if (!isTransient) {
          console.error(`❌ Erreur fatale non transitoire (${errCode}) avec ${model} :`, err.message || err);
          throw err;
        }

        if (attempt < MAX_RETRIES) {
          const baseDelay = RETRY_DELAYS_MS[attempt];
          const jitter = Math.floor(Math.random() * 4000) + 1000; // 1s à 5s
          const totalWaitMs = baseDelay + jitter;
          const waitSec = (totalWaitMs / 1000).toFixed(1);

          console.warn(
            `⏳ Réessai ${attempt + 1}/${MAX_RETRIES} pour ${model} dans ${waitSec}s — ${err.message || errCode}`
          );
          await sleep(totalWaitMs);
        } else {
          console.warn(`⚠️ Le modèle ${model} a échoué après ${MAX_RETRIES} tentatives (${errCode}).`);
          if (modelIdx < candidateModels.length - 1) {
            console.log(`🔀 Bascule automatique vers le modèle de secours : ${candidateModels[modelIdx + 1]}...`);
          }
        }
      }
    }
  }

  throw new Error(`Tous les modèles ont échoué après les retries. Dernière erreur : ${lastError?.message || lastError}`);
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const rawSubject = args.filter((a) => !a.startsWith('--')).join(' ').trim();

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const existingStories = getExistingStories();
  const existingTitles = existingStories.map((s) => s.title);

  // Anti-doublon du jour : le cron passe une fois par jour, mais un
  // workflow_dispatch manuel ne doit pas empiler deux histoires identiques.
  const todaysStory = existingStories.find((s) => s.date === todayDate);
  if (todaysStory && !force) {
    console.log(`ℹ️ Une histoire existe déjà pour le ${todayDate} (${todaysStory.file}). Génération ignorée.`);
    console.log('   Utilisez --force pour en générer une supplémentaire.');
    return;
  }

  const selectedAmbiance = AMBIANCES[Math.floor(Math.random() * AMBIANCES.length)];

  console.log(`🌙 [Gemini] Génération d'une histoire pour le ${todayDate}`);
  console.log(`   Ambiance : ${selectedAmbiance}`);
  if (rawSubject) console.log(`   Sujet imposé : « ${rawSubject} »`);

  const subjectDirective = rawSubject
    ? `\nSUJET IMPOSÉ : construis l'histoire autour de « ${rawSubject} », en gardant l'ambiance indiquée.\n`
    : '';

  const forbiddenList = FORBIDDEN_MENTIONS.map((m) => `« ${m.label} »`).join(', ');

  const prompt = `Tu écris pour la revue en ligne « Marges » une petite histoire de fiction en français.
Ambiance choisie : ${selectedAmbiance}.${subjectDirective}
Ton : doux, chaleureux, wholesome. Une fin tendre ou souriante, SANS morale appuyée ni leçon explicite.
Style : prose simple et sensorielle, paragraphes aérés, pas de listes, pas d'intertitres.

LONGUEUR : entre ${MIN_WORDS} et ${MAX_WORDS} mots (compte précisément, c'est un critère de validation).

MOTS INTERDITS — le titre, le résumé et le texte ne doivent contenir AUCUNE de ces mentions : ${forbiddenList}.
Ne révèle jamais la consigne, le public visé, la durée de lecture ni le genre éditorial.

FORMAT DE SORTIE STRICT : un document Markdown brut commençant par ce frontmatter YAML, puis le texte.
---
title: "Titre poétique, évocateur et spécifique"
subtitle: "Sous-titre court, facultatif"
summary: "Une à deux phrases de résumé neutre et accrocheur."
type: histoire
isAiGenerated: true
---

N'écris que le document : ni commentaire, ni délimiteur \`\`\`markdown.
N'invente pas de champ supplémentaire (pas de themes, pas de date, pas de références).
Varie par rapport aux titres déjà publiés :
${existingTitles.length > 0 ? existingTitles.map((t) => `- « ${t} »`).join('\n') : '- (aucune histoire publiée pour l’instant)'}`;

  const { story, modelUsed } = await generateWithFallbackAndRetry(prompt);

  if (existingTitles.some((t) => t.trim().toLowerCase() === story.title.trim().toLowerCase())) {
    console.error(`❌ Titre déjà utilisé : « ${story.title} ».`);
    process.exit(1);
  }

  // Nom de fichier : suffixe numérique plutôt qu'écrasement.
  const slug = slugify(story.title);
  let fileName = `${todayDate}-${slug}.md`;
  let suffix = 2;
  while (fs.existsSync(path.join(targetDir, fileName))) {
    fileName = `${todayDate}-${slug}-${suffix}.md`;
    suffix += 1;
  }
  const targetFile = path.join(targetDir, fileName);

  const fileContent = buildFileContent(story);
  fs.writeFileSync(targetFile, fileContent, 'utf-8');

  console.log('\n✅ Histoire générée avec succès :');
  console.log(`   Fichier : ${fileName}`);
  console.log(`   Titre   : ${story.title}`);
  console.log(`   Modèle  : ${modelUsed}`);
  console.log(`   Mots    : ${story.words}`);
}

main().catch((err) => {
  console.error("❌ Échec définitif de la génération de l'histoire :", err.message || err);
  process.exit(1); // Sortie en erreur pour empêcher un commit corrompu
});
