import fs from 'node:fs';
import path from 'node:path';
import { GoogleGenAI } from '@google/genai';

// 1. Vérification de la clé API
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("❌ Erreur : Variable d'environnement GEMINI_API_KEY manquante.");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });

const THEMES = ['conscience', 'langage', 'ethique', 'travail', 'creativite', 'relations', 'pouvoir', 'attention'];
const FORMATS = ['essai', 'question', 'dialogue', 'note'];

const targetDir = path.resolve('src/content/textes');

// 2. Inventaire des articles déjà existants pour éviter les doublons et varier les thèmes
function getExistingArticles() {
  if (!fs.existsSync(targetDir)) return [];
  const files = fs.readdirSync(targetDir).filter((f) => f.endsWith('.md') || f.endsWith('.mdx'));
  const articles = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(targetDir, file), 'utf-8');
      const titleMatch = content.match(/title:\s*"([^"]+)"/);
      const themeMatch = content.match(/themes:\s*\[([^\]]+)\]/);
      articles.push({
        file,
        title: titleMatch ? titleMatch[1] : file,
        themes: themeMatch ? themeMatch[1].split(',').map((t) => t.trim().replace(/['"]/g, '')) : [],
      });
    } catch {
      // ignore
    }
  }
  return articles;
}

const existing = getExistingArticles();
const existingTitles = existing.map((a) => a.title);

// Arguments en ligne de commande :
// node scripts/generate-article.mjs [theme] [format] [subject]
let rawTheme = (process.argv[2] || '').trim().toLowerCase();
let rawFormat = (process.argv[3] || '').trim().toLowerCase();
let rawSubject = (process.argv[4] || '').trim();

// Si l'utilisateur a tapé son sujet dans le 1er paramètre (champ thème) au lieu d'un des 8 thèmes
if (rawTheme && !THEMES.includes(rawTheme) && !rawSubject) {
  rawSubject = process.argv[2].trim();
  rawTheme = '';
}

// Fonction de détection intelligente du grand thème le plus proche selon les mots-clés du sujet libre
function inferThemeFromSubject(text) {
  const t = text.toLowerCase();
  if (/conscien|senti|âme|mort|pensée|esprit|intérior|illusion|vivant/i.test(t)) return 'conscience';
  if (/lang|mot|parol|silence|écr|dire|texte|poés|rhétor|bavard/i.test(t)) return 'langage';
  if (/éthique|moral|just|bien|mal|responsab|faute|devoir|dignité|valeur/i.test(t)) return 'ethique';
  if (/travail|métier|outil|techni|ouvri|aliénat|repos|effort|automatis|geste/i.test(t)) return 'travail';
  if (/créat|art|styl|origin|génie|imagin|beauté|imitation|invent/i.test(t)) return 'creativite';
  if (/relat|amour|ami|solitud|autrui|autre|empath|lien|social|polit/i.test(t)) return 'relations';
  if (/pouvoir|contrôl|surveill|autorit|dominat|polit|état|loi|gouvern/i.test(t)) return 'pouvoir';
  if (/attent|mémoir|ennui|temps|vitess|distract|lectur|sommeil|présen/i.test(t)) return 'attention';
  return null;
}

const themeArg = THEMES.includes(rawTheme)
  ? rawTheme
  : (rawSubject && inferThemeFromSubject(rawSubject)) || THEMES[Math.floor(Math.random() * THEMES.length)];

const typeArg = FORMATS.includes(rawFormat)
  ? rawFormat
  : FORMATS[Math.floor(Math.random() * FORMATS.length)];

const subjectArg = rawSubject;

const todayDate = new Date().toISOString().slice(0, 10);

// Délais de rétrogradation exponentielle (Exponential Backoff)
const RETRY_DELAYS_MS = [10_000, 25_000, 60_000, 120_000];
const MAX_RETRIES = RETRY_DELAYS_MS.length;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Erreur de validation du contenu renvoyé par le modèle (frontmatter manquant,
 * texte trop court…). Ce n'est pas la peine de changer de modèle : le prompt est
 * le même, donc on réessaie avec le même modèle avant de basculer.
 */
class ContentValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ContentValidationError';
  }
}

/**
 * Détecte si une erreur de l'API Gemini est temporaire (503, 429, 500, etc.)
 * Ce type d'erreur justifie un nouvel essai, éventuellement sur un autre modèle.
 */
function isTransientError(err) {
  if (!err) return false;

  // Les erreurs de validation du contenu se réessayent aussi, mais pour une
  // autre raison : la génération est stochastique, un second tirage peut passer.
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
    /\b503\b/,
    /\b429\b/,
    /\b500\b/,
    /\b502\b/,
    /\b504\b/,
    /UNAVAILABLE/i,
    /RESOURCE_EXHAUSTED/i,
    /INTERNAL/i,
    /BAD_GATEWAY/i,
    /GATEWAY_TIMEOUT/i,
    /high demand/i,
    /spikes in demand/i,
    /temporarily unavailable/i,
    /overloaded/i,
    /rate limit/i,
    /quota exceeded/i,
    /fetch failed/i,
    /ECONNRESET/i,
    /ETIMEDOUT/i,
  ];

  return patterns.some((p) => p.test(msg));
}

/**
 * Extrait le code ou nom d'erreur pour les logs
 */
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

/**
 * Vérifie que le frontmatter respecte le schéma de src/content.config.ts.
 * Sans ce garde-fou, un article hors schéma était commité puis cassait le build.
 */
function validateFrontmatter(content) {
  if (!content.startsWith('---')) {
    throw new ContentValidationError('Le frontmatter YAML est absent ou mal formé.');
  }

  const end = content.indexOf('\n---', 3);
  const block = end === -1 ? content : content.slice(0, end);

  const titleMatch = block.match(/^title:\s*"([^"]+)"/m);
  if (!titleMatch || !titleMatch[1].trim()) {
    throw new ContentValidationError("Impossible d'extraire un titre valide depuis le frontmatter.");
  }

  if (!/^summary:\s*\S/m.test(block)) {
    throw new ContentValidationError('Champ « summary » absent du frontmatter.');
  }

  if (!/^date:\s*\d{4}-\d{2}-\d{2}\s*$/m.test(block)) {
    throw new ContentValidationError('Champ « date » absent ou mal formé (attendu : AAAA-MM-JJ).');
  }

  const typeMatch = block.match(/^type:\s*"?([a-z-]+)"?\s*$/m);
  if (!typeMatch || !FORMATS.includes(typeMatch[1])) {
    throw new ContentValidationError(
      `Champ « type » invalide (${typeMatch ? typeMatch[1] : 'absent'}) ; attendu : ${FORMATS.join(', ')}.`
    );
  }

  const themesMatch = block.match(/^themes:\s*\[([^\]]*)\]/m);
  const themes = themesMatch
    ? themesMatch[1].split(',').map((t) => t.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
    : [];
  if (themes.length === 0) {
    throw new ContentValidationError('Champ « themes » vide ou absent.');
  }
  const unknownThemes = themes.filter((t) => !THEMES.includes(t));
  if (unknownThemes.length > 0) {
    throw new ContentValidationError(
      `Thème(s) inconnu(s) : ${unknownThemes.join(', ')} ; attendu : ${THEMES.join(', ')}.`
    );
  }

  if (!/^isAiGenerated:\s*true\s*$/m.test(block)) {
    throw new ContentValidationError('Champ « isAiGenerated: true » attendu dans le frontmatter.');
  }

  return titleMatch[1].trim();
}

/**
 * Exécute l'appel Gemini avec Exponential Backoff + Jitter et Fallback multi-modèles
 */
async function generateWithFallbackAndRetry(prompt) {
  const candidateModels = Array.from(
    new Set(
      [
        process.env.GEMINI_MODEL,
        'gemini-3.8-flash',
        'gemini-3.5-flash-lite',
        'gemini-3.1-flash-lite',
      ].filter(Boolean)
    )
  );

  let lastError = null;

  for (let modelIdx = 0; modelIdx < candidateModels.length; modelIdx++) {
    const model = candidateModels[modelIdx];
    console.log(`\n🎯 Modèle sélectionné [${modelIdx + 1}/${candidateModels.length}] : ${model}`);

    // Tentative initiale (0) + jusqu'à MAX_RETRIES réessais
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: prompt,
          config: {
            temperature: 0.7,
          },
        });

        const rawText = response.text ? response.text.trim() : '';

        // Nettoyage éventuel des balises markdown englobantes
        const content = rawText
          .replace(/^```(?:markdown)?\n?/i, '')
          .replace(/\n?```$/i, '')
          .trim();

        // Validation stricte du contenu
        if (!content || content.length < 500) {
          throw new ContentValidationError(
            `Contenu généré trop court ou vide (${content.length} caractères reçus).`
          );
        }

        const title = validateFrontmatter(content);

        return { content, title, modelUsed: model };
      } catch (err) {
        lastError = err;
        const isTransient = isTransientError(err);
        const errCode = getErrorSummary(err);

        if (!isTransient) {
          // Erreur non temporaire : arrêt immédiat
          console.error(`❌ Erreur fatale non transitoire (${errCode}) avec ${model} :`, err.message || err);
          throw err;
        }

        if (attempt < MAX_RETRIES) {
          const baseDelay = RETRY_DELAYS_MS[attempt];
          const jitter = Math.floor(Math.random() * 4000) + 1000; // 1s à 5s
          const totalWaitMs = baseDelay + jitter;
          const waitSec = (totalWaitMs / 1000).toFixed(1);

          console.warn(
            `⏳ Serveur Gemini occupé (${errCode}), nouvelle tentative ${attempt + 1}/${MAX_RETRIES} pour le modèle ${model} dans ${waitSec}s...`
          );
          await sleep(totalWaitMs);
        } else {
          console.warn(
            `⚠️ Le modèle ${model} a échoué après ${MAX_RETRIES} tentatives (${errCode}).`
          );
          if (modelIdx < candidateModels.length - 1) {
            console.log(`🔀 Bascule automatique vers le modèle de secours : ${candidateModels[modelIdx + 1]}...`);
          }
        }
      }
    }
  }

  throw new Error(`Tous les modèles ont échoué après les retries. Dernière erreur : ${lastError?.message || lastError}`);
}

async function generateDailyContent() {
  console.log(`🤖 [Gemini] Lancement de la génération pour le ${todayDate}`);
  console.log(`   Format : ${typeArg} | Thème : ${themeArg}`);
  if (subjectArg) {
    console.log(`   Sujet libre imposé : « ${subjectArg} »`);
  }
  console.log(`   Titres existants à ne pas répéter (${existingTitles.length}) :`, existingTitles.slice(0, 5));

  const subjectDirective = subjectArg
    ? `\nSUJET OU QUESTION CENTRALE IMPOSÉE :
Tu dois impérativement et de façon centrale traiter la question ou le sujet suivant :
« ${subjectArg} »
Rattache ce sujet au grand thème philosophique "${themeArg}".\n`
    : '';

  const prompt = `Tu es un philosophe et écrivain exigeant pour la revue "Marges" (réflexion philosophique profonde sur l'intelligence artificielle et la condition humaine).
Écris un article philosophique original, percutant et élégant, sur le thème "${themeArg}" sous la forme d'un "${typeArg}".${subjectDirective}

CONSIGNES STRICTES :
1. Titre et sujet :
${
  subjectArg
    ? `- Développe avec exigence le sujet imposé « ${subjectArg} ». Le titre doit être évocateur, inspiré et directement lié à cette réflexion philosophique.`
    : `- Titre et sujet UNIQUES : Ne traite pas un sujet déjà abordé dans ces titres :\n${existingTitles.map((t) => `- "${t}"`).join('\n')}`
}

2. Rigueur philosophique :
- Ne cite que des auteurs, ouvrages et concepts philosophiques réels et vérifiables (ex: Kant, Arendt, Simondon, Barthes, Jonas, Merleau-Ponty, Benjamin, Illich, Spinoza, etc.).
- N'invente aucune citation ni référence bibliographique.
- Utilise des termes philosophiques sans qu'ils soient trop compliqués à comprendre pour le lecteur lambda.

3. Format Markdown et Frontmatter YAML :
Le texte DOIT commencer par le frontmatter YAML exact suivant :
---
title: "Titre inspirant et percutant"
subtitle: "Sous-titre synthétique"
date: ${todayDate}
summary: "Deux phrases d'accroche qui posent le paradoxe philosophique."
type: ${typeArg}
themes: [${themeArg}]
epigraph: "Une citation philosophique authentique et pertinente"
epigraphAuthor: "Auteur authentique de la citation"
dropcap: true
isAiGenerated: true
references:
  - author: "Auteur de référence"
    title: "Ouvrage authentique"
    note: "Année de publication et courte remarque"
---

4. Structure et style :
- Utilise des intertitres de niveau 2 (##).
- Insère au moins deux notes de bas de page philosophiques ([^1] et [^2]).
- Typographie soignée (guillemets français « », tirets cadratins —, espaces insécables).
- Longueur : au moins 500 mots, texte dense, sans remplissage creux ni platitudes d'assistant vocal.
- Rends uniquement le code Markdown brut, sans délimiteurs \`\`\`markdown.`;

  try {
    const { content, title, modelUsed } = await generateWithFallbackAndRetry(prompt);

    // Slugification propre pour le nom de fichier (ex: 2026-10-14-titre-du-texte.md)
    const slug =
      title
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'texte-du-jour';

    // Deux générations le même jour, ou un titre recyclé, écraseraient un texte
    // existant : on suffixe au lieu de perdre le fichier précédent.
    let fileName = `${todayDate}-${slug}.md`;
    let suffix = 2;
    while (fs.existsSync(path.join(targetDir, fileName))) {
      fileName = `${todayDate}-${slug}-${suffix}.md`;
      suffix += 1;
    }
    const targetFile = path.join(targetDir, fileName);

    // Écriture sécurisée du fichier
    fs.writeFileSync(targetFile, content, 'utf-8');
    console.log(`\n✅ Texte philosophique quotidien généré avec succès :`);
    console.log(`   Fichier : ${fileName}`);
    console.log(`   Titre   : ${title}`);
    console.log(`   Modèle  : ${modelUsed}`);
    console.log(`   Taille  : ${content.length} caractères`);
  } catch (err) {
    console.error('\n❌ Échec définitif de la génération :', err.message);
    process.exit(1); // Sortie en erreur pour empêcher un commit corrompu
  }
}

generateDailyContent();
