export function parsePlaceAlias(raw: string): { alias: string; meaning: string } | null {
  const text = raw.replace(/^\/place(@\w+)?\s*/i, '').trim();
  if (!text) return null;
  const parts = text.split(/\s*(?:=|—|–)\s*|\s+(?:это|це|is)\s+/i);
  if (parts.length < 2) return null;
  const alias = parts[0]?.trim() ?? '';
  const meaning = parts.slice(1).join(' ').trim();
  if (alias.length < 2 || meaning.length < 2) return null;
  return { alias, meaning };
}
