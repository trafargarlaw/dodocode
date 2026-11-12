// How the search dialog decides whether an entry matches what was typed.

/**
 * Scores an entry against the search: 0 hides it. Each typed word has to appear in the entry's
 * words, in any order; an entry whose first word starts with the first typed word ranks first.
 */
export function searchScore(words: readonly string[], search: string): number {
  const typed = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (typed.length === 0) return 1;
  const text = words.join(" ").toLowerCase();
  if (!typed.every((word) => text.includes(word))) return 0;
  return text.startsWith(typed[0] as string) ? 1 : 0.5;
}
