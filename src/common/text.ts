export function normalize(s: string): string {
  return s.toLowerCase().replace(/[’ʼ]/g, "'").trim();
}

export function cleanMessage(text: string): string {
  return text
    .replace(/[’ʼ]/g, "'")
    .replace(/✅?\s*підпишись на схід\.?/gi, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[^\S\r\n]+/g, ' ')
    .trim();
}

export function previewMessage(text: string, max = 400): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
