/**
 * Réglages globaux du site — à personnaliser.
 */
export const SITE = {
  title: 'Marges',
  tagline: '',
  description:
    "Essais, questions ouvertes, dialogues et fragments sur la place de l'intelligence artificielle dans nos vies : travail, relations, création, conscience, éthique, pouvoir.",
  lang: 'fr',
  locale: 'fr_FR',
  author: 'Tom',
  email: 'contact@marges.example',
  /** Licence des textes (affichée dans le pied de page et les mentions légales). */
  license: {
    name: 'CC BY-NC-SA 4.0',
    url: 'https://creativecommons.org/licenses/by-nc-sa/4.0/deed.fr',
  },
  /** Hébergeur (obligatoire dans les mentions légales en France). */
  host: {
    name: 'GitHub, Inc. (GitHub Pages)',
    address: '88 Colin P. Kelly Jr. Street, San Francisco, CA 94107, États-Unis',
    url: 'https://pages.github.com',
  },
} as const;

/** Formats éditoriaux. */
export const TYPES = {
  essai: { label: 'Essai', plural: 'Essais', description: 'Une argumentation longue.' },
  question: { label: 'Question', plural: 'Questions', description: 'Une question ouverte, sans prétendre conclure.' },
  dialogue: { label: 'Dialogue', plural: 'Dialogues', description: 'Un échange à deux voix, à la manière socratique.' },
  note: { label: 'Note', plural: 'Notes', description: 'Une pensée courte, un fragment.' },
  histoire: { label: 'Histoire', plural: 'Histoires', description: 'Une petite histoire' },
} as const;

export type TypeSlug = keyof typeof TYPES;
export const TYPE_SLUGS = Object.keys(TYPES) as [TypeSlug, ...TypeSlug[]];
