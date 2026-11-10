/**
 * Module d'assistance à la rédaction de cours par intelligence artificielle.
 *
 * Gère plusieurs moteurs au choix de l'utilisateur :
 * 1. Puter.js (par défaut, sans inscription obligatoire, sans clé d'API)
 * 2. Clé personnelle Google Gemini (AI Studio gratuit)
 * 3. Clé personnelle Groq (Llama 3.3 70B gratuit)
 * 4. Chrome Built-in AI (Gemini Nano local, si activé dans le navigateur)
 */

export type AiProvider = 'puter' | 'gemini' | 'groq' | 'chrome';
export type DraftMode = 'cours' | 'fiche';

export interface AiSettings {
  provider: AiProvider;
  geminiKey: string;
  groqKey: string;
}

const STORAGE_KEYS = {
  PROVIDER: 'marges_ai_provider',
  GEMINI_KEY: 'marges_gemini_api_key',
  GROQ_KEY: 'marges_groq_api_key',
};

/**
 * Récupère les paramètres IA enregistrés dans le navigateur.
 */
export function getAiSettings(): AiSettings {
  if (typeof window === 'undefined') {
    return { provider: 'puter', geminiKey: '', groqKey: '' };
  }
  const provider = (localStorage.getItem(STORAGE_KEYS.PROVIDER) as AiProvider) || 'puter';
  const geminiKey = localStorage.getItem(STORAGE_KEYS.GEMINI_KEY) || '';
  const groqKey = localStorage.getItem(STORAGE_KEYS.GROQ_KEY) || '';
  return { provider, geminiKey, groqKey };
}

/**
 * Sauvegarde les paramètres IA dans le navigateur.
 */
export function saveAiSettings(settings: Partial<AiSettings>): void {
  if (typeof window === 'undefined') return;
  if (settings.provider !== undefined) {
    localStorage.setItem(STORAGE_KEYS.PROVIDER, settings.provider);
  }
  if (settings.geminiKey !== undefined) {
    localStorage.setItem(STORAGE_KEYS.GEMINI_KEY, settings.geminiKey.trim());
  }
  if (settings.groqKey !== undefined) {
    localStorage.setItem(STORAGE_KEYS.GROQ_KEY, settings.groqKey.trim());
  }
}

/**
 * Détecte si l'API native Chrome Prompt (Gemini Nano) est disponible.
 */
export async function isChromeAiAvailable(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  const anyWindow = window as any;
  if (!anyWindow.ai?.languageModel) return false;
  try {
    const status = await anyWindow.ai.languageModel.availability();
    return status === 'readily' || status === 'after-download';
  } catch {
    return false;
  }
}

/**
 * Charge dynamiquement le script Puter.js si nécessaire.
 */
let puterLoadingPromise: Promise<any> | null = null;
export function loadPuterScript(): Promise<any> {
  if (typeof window === 'undefined') return Promise.reject(new Error('Environnement non navigateur'));
  const anyWindow = window as any;
  if (anyWindow.puter?.ai) return Promise.resolve(anyWindow.puter);

  if (puterLoadingPromise) return puterLoadingPromise;

  puterLoadingPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[src*="js.puter.com"]');
    if (existing) {
      existing.addEventListener('load', () => resolve(anyWindow.puter));
      existing.addEventListener('error', () => reject(new Error('Échec du chargement de Puter.js')));
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://js.puter.com/v2/';
    script.async = true;
    script.onload = () => resolve((window as any).puter);
    script.onerror = () => reject(new Error('Impossible de charger Puter.js. Vérifiez votre connexion.'));
    document.head.appendChild(script);
  });

  return puterLoadingPromise;
}

/**
 * Prépare les instructions pour le modèle selon le mode choisi.
 */
function buildPrompts(mode: DraftMode, title: string, rawNotes: string): { systemPrompt: string; userPrompt: string } {
  const isCours = mode === 'cours';

  const systemPrompt = isCours
    ? `Tu es un professeur universitaire et rédacteur pédagogique rigoureux.
Ton rôle est d'élaborer un cours complet, fluide et très structuré en français à partir de notes d'étudiant prises à la volée.
Consignes impératives :
1. Rédige en français soigné, clair et universitaire. Évite le jargon creux.
2. Structure le cours avec des titres Markdown clairs :
   - # Titre général du cours
   - Une courte introduction situant la problématique et le contexte
   - ## I. Première partie (avec sous-parties ### A., ### B. si nécessaire)
   - ## II. Deuxième partie
   - ## III. Troisième partie (si le contenu le justifie)
   - Encadrés de définitions via la syntaxe : > [!NOTE] Définition : ...
   - ## Conclusion & Notions à retenir
3. Ne te contente pas de répéter les abréviations : développe chaque idée en paragraphes complets, argumentés et reliés par des transitions.
4. Reste strictement fidèle aux idées de la note. N'invente pas d'auteurs imaginaires ou de faits fictifs.
5. N'ajoute aucun commentaire méta (pas de "Voici votre cours :", commence directement par le titre).`
    : `Tu es un tuteur universitaire méthodique.
Ton rôle est de créer une fiche de synthèse de révision dense et claire en français à partir de notes d'étudiant.
Consignes impératives :
1. Rédige en français direct et synthétique.
2. Structure la fiche avec ce plan Markdown :
   - # Fiche de synthèse : ${title || 'Sans titre'}
   - ## 1. Concepts et définitions clés (utilise des encadrés > [!NOTE])
   - ## 2. Plan condensé et arguments essentiels (utilise des listes et points numérotés)
   - ## 3. Pièges fréquents & points d'attention (> [!WARNING])
   - ## 4. Questions types pour s'auto-évaluer (- [ ] question...)
3. Reste concis, précis et lisible en un coup d'œil.
4. N'ajoute aucun commentaire méta avant ou après le document.`;

  const userPrompt = `Titre de la séance : ${title || 'Sans titre'}

Notes brutes prises par l'étudiant :
"""
${rawNotes.trim()}
"""

Rédige maintenant le document demandé en Markdown pur.`;

  return { systemPrompt, userPrompt };
}

/**
 * Appel au moteur Puter.js.
 */
async function generateViaPuter(systemPrompt: string, userPrompt: string): Promise<string> {
  const puter = await loadPuterScript();
  if (!puter?.ai?.chat) {
    throw new Error('Le service Puter.js est inaccessible.');
  }

  const prompt = `${systemPrompt}\n\n---\n\n${userPrompt}`;
  const response = await puter.ai.chat(prompt, { model: 'gpt-4o-mini' });

  if (typeof response === 'string') return response.trim();
  if (response?.message?.content) return String(response.message.content).trim();
  if (response?.text) return String(response.text).trim();
  return String(response).trim();
}

/**
 * Appel direct à l'API Google Gemini avec clé utilisateur.
 */
async function generateViaGemini(systemPrompt: string, userPrompt: string, apiKey: string): Promise<string> {
  if (!apiKey) throw new Error("Aucune clé Google Gemini configurée. Ajoutez votre clé dans Configuration.");

  const model = 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const body = {
    systemInstruction: {
      parts: [{ text: systemPrompt }],
    },
    contents: [
      {
        role: 'user',
        parts: [{ text: userPrompt }],
      },
    ],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 6000,
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let msg = `Erreur Gemini (${res.status})`;
    try {
      const errData = await res.json();
      if (errData?.error?.message) msg = errData.error.message;
    } catch {}
    throw new Error(msg);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Réponse vide de la part de Gemini.');
  return text.trim();
}

/**
 * Appel direct à l'API Groq avec clé utilisateur.
 */
async function generateViaGroq(systemPrompt: string, userPrompt: string, apiKey: string): Promise<string> {
  if (!apiKey) throw new Error("Aucune clé Groq configurée. Ajoutez votre clé dans Configuration.");

  const url = 'https://api.groq.com/openai/v1/chat/completions';
  const body = {
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.4,
    max_tokens: 6000,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let msg = `Erreur Groq (${res.status})`;
    try {
      const errData = await res.json();
      if (errData?.error?.message) msg = errData.error.message;
    } catch {}
    throw new Error(msg);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Réponse vide de la part de Groq.');
  return text.trim();
}

/**
 * Appel à l'API native Chrome Prompt (Gemini Nano local).
 */
async function generateViaChrome(systemPrompt: string, userPrompt: string): Promise<string> {
  const anyWindow = window as any;
  if (!anyWindow.ai?.languageModel) {
    throw new Error("L'API Chrome Built-in AI n'est pas disponible sur ce navigateur.");
  }

  const session = await anyWindow.ai.languageModel.create({
    systemPrompt,
    temperature: 0.4,
  });

  try {
    const result = await session.prompt(userPrompt);
    return String(result).trim();
  } finally {
    try {
      session.destroy();
    } catch {}
  }
}

export interface GenerateDraftOptions {
  title: string;
  notes: string;
  mode: DraftMode;
  provider?: AiProvider;
}

/**
 * Point d'entrée principal pour générer le cours ou la fiche.
 */
export async function generateCourseDraft(options: GenerateDraftOptions): Promise<{ text: string; providerUsed: string }> {
  const { title, notes, mode } = options;
  if (!notes || notes.trim().length < 20) {
    throw new Error('Vos notes sont trop courtes. Ajoutez au moins quelques lignes ou mots-clés.');
  }

  const settings = getAiSettings();
  const provider = options.provider || settings.provider || 'puter';
  const { systemPrompt, userPrompt } = buildPrompts(mode, title, notes);

  if (provider === 'gemini' && settings.geminiKey) {
    const text = await generateViaGemini(systemPrompt, userPrompt, settings.geminiKey);
    return { text, providerUsed: 'Google Gemini (clé personnelle)' };
  }

  if (provider === 'groq' && settings.groqKey) {
    const text = await generateViaGroq(systemPrompt, userPrompt, settings.groqKey);
    return { text, providerUsed: 'Groq Llama 3.3 (clé personnelle)' };
  }

  if (provider === 'chrome') {
    const text = await generateViaChrome(systemPrompt, userPrompt);
    return { text, providerUsed: 'Chrome Gemini Nano (local)' };
  }

  // Si l'utilisateur avait sélectionné gemini/groq mais sans clé, bascule sur Puter
  try {
    const text = await generateViaPuter(systemPrompt, userPrompt);
    return { text, providerUsed: 'Puter.js (accès libre)' };
  } catch (err: any) {
    // Si Puter échoue et que Chrome AI est disponible, tentative de secours
    if (await isChromeAiAvailable()) {
      const text = await generateViaChrome(systemPrompt, userPrompt);
      return { text, providerUsed: 'Chrome Gemini Nano (secours local)' };
    }
    throw err;
  }
}
