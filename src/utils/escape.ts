/**
 * Échappement HTML pour toute valeur interpolée dans un `innerHTML`.
 *
 * À utiliser systématiquement sur les données qui ne viennent pas du code
 * lui-même : contenu d'un flux iCalendar / RSS récupéré via un relais tiers,
 * champs saisis par l'utilisateur, retours d'API.
 *
 * Les guillemets sont échappés aussi : la fonction est donc sûre en contexte
 * texte comme en contexte attribut (`value="${esc(x)}"`).
 */
const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPE_MAP[c]!);
}
