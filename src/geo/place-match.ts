import { normalize } from '../common/text';
import type { PlaceKind } from './ua-gazetteer';

const OBLAST_BBOX = { minLat: 48.45, maxLat: 50.55, minLon: 34.75, maxLon: 38.15 };

export function foldUa(s: string): string {
  return normalize(s)
    .replace(/[''`ʼ]/g, '')
    .replace(/[ъь]/g, '')
    .replace(/і/g, 'и')
    .replace(/ї/g, 'и')
    .replace(/є/g, 'е')
    .replace(/ґ/g, 'г')
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const PLACE_SLANG: Record<string, string> = {
  сс: foldUa('північна салтівка'),
  бд: foldUa('велика данилівка'),
};

export function foldPlaceText(s: string): string {
  return foldUa(s)
    .replace(/(^|\s)с\s+с(?=\s|$)/g, '$1сс')
    .replace(/(^|\s)б\s+д(?=\s|$)/g, '$1бд');
}

export function registerPlaceSlang(alias: string, meaning: string): void {
  const key = foldUa(alias).replace(/\s+/g, '');
  const target = foldUa(meaning);
  if (key.length >= 2 && key.length <= 4 && target) PLACE_SLANG[key] = target;
}

export function expandPlaceSlang(text: string): string {
  const keys = Object.keys(PLACE_SLANG).sort((a, b) => b.length - a.length);
  if (!keys.length) return foldPlaceText(text);
  const re = new RegExp(`(^|\\s)(${keys.map(escapeRe).join('|')})(?=\\s|$)`, 'g');
  return foldPlaceText(text).replace(re, (_m, pre: string, key: string) => `${pre}${PLACE_SLANG[key] ?? key}`);
}

export function placeVariants(name: string): string[] {
  const folded = foldUa(name);
  const out = new Set<string>([name.trim(), folded].filter(Boolean));
  const stripped = folded.replace(/^(ст|стар|старий|старый)\s+/, '');
  if (stripped && stripped !== folded) {
    out.add(stripped);
    out.add(`ст ${stripped}`);
    out.add(`старий ${stripped}`);
    out.add(`старый ${stripped}`);
  }
  return [...out];
}

const WORD = '(^|\\s)';
const END = '(?=\\s|$)';

export function placeStem(s: string): string {
  let n = foldUa(s)
    .replace(new RegExp(`${WORD}(ст|стар|старий|старый|смт|село|селище|місто|м|вул|улица|просп|пр|проспект|майдан|площадь|площа)${END}`, 'g'), '$1')
    .replace(new RegExp(`${WORD}(харківська|харьковская)\\s+(область|обл)${END}`, 'g'), '$1')
    .replace(new RegExp(`${WORD}(область|обл|район|пригород|околиці|околицы|передмістя)${END}`, 'g'), '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (n.length < 6) return n;
  n = n.replace(/(ського|ского|ській|ской|ська|ская|ське|ское|ський|ский)$/g, '');
  n = n.replace(/(ового|овому|ової|овой|ове|ова|ове)$/g, '');
  if (n.length >= 6) n = n.replace(/[аеиоуиюя]$/g, '');
  // павлівка / павловка / кегичівка / кегичевка
  n = n.replace(/[ие]вк/g, 'овк').replace(/[ие]в$/g, 'ов');
  return n;
}

export function namesEqual(a: string, b: string): boolean {
  const fa = foldUa(a);
  const fb = foldUa(b);
  if (!fa || !fb) return false;
  if (fa === fb) return true;
  const sa = placeStem(a);
  const sb = placeStem(b);
  return sa.length >= 5 && sa === sb;
}

/** Whole-token mention: «павлівка» must not match inside «краснопавловку». */
export function mentionedIn(text: string, name: string): boolean {
  const foldedText = foldPlaceText(text);
  const expandedText = expandPlaceSlang(text);
  const foldedName = foldUa(name);
  if (!foldedText || !foldedName) return false;
  if (foldedText === foldedName || expandedText === foldedName) return true;
  if (PLACE_SLANG[foldedName] && (` ${foldedText} `.includes(` ${foldedName} `))) return true;

  const padded = ` ${foldedText} `;
  const paddedExpanded = ` ${expandedText} `;
  if (padded.includes(` ${foldedName} `) || paddedExpanded.includes(` ${foldedName} `)) return true;
  for (const variant of placeVariants(name)) {
    const phrase = foldUa(variant);
    if (phrase.length >= 2 && (padded.includes(` ${phrase} `) || paddedExpanded.includes(` ${phrase} `))) return true;
  }

  const stem = placeStem(name);
  if (stem.length < 4) {
    return new RegExp(`(?:^| )${escapeRe(foldedName)}(?: |$)`).test(padded);
  }
  const tokens = foldedText.split(' ').filter(Boolean);
  return tokens.some((token) => {
    if (token === foldedName || token === stem) return true;
    const tokenStem = placeStem(token);
    return tokenStem.length >= 4 && tokenStem === stem;
  });
}

export function inKharkivOblast(lat: number, lon: number): boolean {
  return (
    lat >= OBLAST_BBOX.minLat &&
    lat <= OBLAST_BBOX.maxLat &&
    lon >= OBLAST_BBOX.minLon &&
    lon <= OBLAST_BBOX.maxLon
  );
}

export type DetectedRegion = {
  name: string;
  code: string;
  lat: number;
  lon: number;
  kind: Extract<PlaceKind, 'region'>;
};

const REGIONS: DetectedRegion[] = [
  { name: 'Північ області', code: 'oblast_north', lat: 50.18, lon: 36.22, kind: 'region' },
  { name: 'Південь області', code: 'oblast_south', lat: 49.4, lon: 36.25, kind: 'region' },
  { name: 'Схід області', code: 'oblast_east', lat: 49.9, lon: 37.25, kind: 'region' },
  { name: 'Захід області', code: 'oblast_west', lat: 49.95, lon: 35.7, kind: 'region' },
];

export function detectOblastRegion(text: string): DetectedRegion | null {
  const n = foldUa(text);
  if (!n) return null;
  const oblastish = /област|пригород|околиц|передміст|район област/.test(n);
  if (!oblastish) return null;
  if (/(північн|северн)/.test(n)) return REGIONS[0];
  if (/(південн|южн)/.test(n)) return REGIONS[1];
  if (/(східн|восточн)/.test(n)) return REGIONS[2];
  if (/(західн|западн)/.test(n)) return REGIONS[3];
  return null;
}

export function looksLikeSettlement(name: string): boolean {
  const n = foldUa(name);
  if (!n) return false;
  if (/(област|пригород|околиц|передміст|смт|село|селище)/.test(n)) return true;
  return /(івка|ивка|овка|евка|янка|инка|ево|ово)\b/.test(n) && !/(вул|просп|майдан|шосе)/.test(n);
}

export function isVagueOblastName(name: string): boolean {
  const n = foldUa(name);
  return (
    /^(харківська|харьковская)?\s*(область|обл)$/.test(n) ||
    n === 'харківська' ||
    n === 'харьковская' ||
    n === 'область' ||
    n === 'пригород' ||
    n === 'околиці' ||
    n === 'околицы'
  );
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
