# Marges (Daily)

Un espace personnel et carnet éditorial dédié à la réflexion philosophique sur l'intelligence artificielle et la condition humaine, combiné à un tableau de bord académique (emploi du temps iCal, supports de cours du Semestre 5 et gestionnaire de révisions/rappels).

---

## 🚀 Fonctionnement du Déploiement et de la Génération Quotidienne (GitHub Actions)

Le projet s'appuie sur **GitHub Actions** et **GitHub Pages** pour automatiser sa publication sans aucun serveur persistant :

### 1. Workflow de Publication Quotidienne & Déploiement
Le fichier [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml) gère l'ensemble du cycle de vie du site :
- **Planification quotidienne (Cron)** : déclenché automatiquement chaque jour à **06h00 UTC** (7h en heure d'hiver / 8h en heure d'été française).
- **Déclenchement manuel (`workflow_dispatch`)** : accessible depuis l'onglet *Actions* de GitHub avec option de choix du thème et du format d'article.
- **Push automatique** : chaque push sur la branche `dev` ou `main` reconstruit le site statique et met à jour GitHub Pages.

### 2. Génération philosophique via Gemini API
- Le script [`scripts/generate-article.mjs`](scripts/generate-article.mjs) est exécuté par le runner GitHub.
- Il interroge l'API Google Gemini en utilisant la variable d'environnement `GOOGLE_API_KEY` (clé API Google Cloud Console, avec repli sur `GEMINI_API_KEY`).
- **Règles de qualité & sécurité :**
  - **Aucun doublon** : le script scanne les titres existants dans `src/content/textes/` et enjoint le modèle d'aborder un angle inédit.
  - **Rigueur philosophique** : contrainte stricte de citer uniquement des auteurs réels et des ouvrages vérifiables.
  - **Transparence éditoriale** : les articles générés sont balisés avec `isAiGenerated: true` dans leur frontmatter Markdown, affichant un badge discret sur l'article.
  - **Validation d'intégrité** : vérification que le contenu fait au moins 500 mots et que le frontmatter YAML est valide avant d'écrire le fichier. En cas d'échec de l'API, le script s'arrête avec un code de sortie non nul (`exit 1`) sans corrompre le dépôt.
- Le nouveau fichier est commité par le bot GitHub Actions (`github-actions[bot]`) puis le site est compilé avec `npm run build` et immédiatement déployé sur GitHub Pages.

---

## 🛠️ Configuration requise sur GitHub

1. **Clé API Google Cloud Console (Gemini)** :
   - Rendez-vous sur votre dépôt : `Settings > Secrets and variables > Actions`.
   - Ajoutez un secret nommé **`GOOGLE_API_KEY`** avec votre clé d'API Google Cloud Console (avec l'API *Generative Language API* activée sur le projet).
2. **Permissions des Workflows** :
   - Rendez-vous dans : `Settings > Actions > General > Workflow permissions`.
   - Cochez **"Read and write permissions"** pour autoriser le bot à commiter les nouveaux articles.
3. **Source GitHub Pages** :
   - Dans `Settings > Pages`, assurez-vous que la source est définie sur **GitHub Actions**.

---

## 💻 Développement local

```bash
# Installation des dépendances
npm install

# Lancer le serveur de développement local
npm run dev

# Compiler le site et générer l'index Pagefind
npm run build

# Tester la génération d'un article en local (après avoir rempli GOOGLE_API_KEY dans .env)
node scripts/generate-article.mjs conscience essai
```