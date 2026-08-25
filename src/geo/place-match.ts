import { normalize } from '../common/text';
import type { PlaceKind } from './ua-gazetteer';

export const OBLAST_BBOX = { minLat: 48.45, maxLat: 50.55, minLon: 34.75, maxLon: 38.15 };

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
  const adj = n.replace(/(ового|овому|ової|овой)$/g, '');
  if (adj.length >= 5) n = adj;
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

export function mentionsAdminRaion(text: string): boolean {
  return extractRaionPhrase(text) != null;
}

export function queryLooksLikeStreet(name: string): boolean {
  return /(вул|улица|просп|майдан|шосе|площадь|площа)\b/.test(foldUa(name));
}

export function explicitStreetCue(text: string): boolean {
  return queryLooksLikeStreet(text);
}

/** Drop city streets that only matched via the same stem as an oblast settlement. */
export function dropStreetShadows<T extends { name: string; kind?: PlaceKind; matchType?: PlaceKind }>(
  items: T[],
  text: string,
): T[] {
  const kindOf = (item: T) => item.kind ?? item.matchType;
  const outerStems = new Set(
    items
      .filter((item) => kindOf(item) === 'settlement' || kindOf(item) === 'region')
      .map((item) => placeStem(item.name))
      .filter((stem) => stem.length >= 4),
  );
  if (!outerStems.size) return items;
  return items.filter((item) => {
    if (kindOf(item) !== 'street') return true;
    const stem = placeStem(item.name);
    if (!outerStems.has(stem)) return true;
    return streetFormInText(text, item.name);
  });
}

function streetFormInText(text: string, streetName: string): boolean {
  const folded = foldPlaceText(text);
  const padded = ` ${folded} `;
  const phrase = foldUa(streetName);
  if (phrase.length >= 4 && padded.includes(` ${phrase} `)) return true;
  const stem = placeStem(streetName);
  if (stem.length < 4) return false;
  const tokens = folded.split(' ').filter(Boolean);
  const adjective = tokens.some(
    (token) => /(ська|ская|ське|ское|ський|ский|ській|ской)$/.test(token) && placeStem(token) === stem,
  );
  return adjective && explicitStreetCue(text);
}

export function extractRaionPhrase(text: string): string | null {
  const m = text.match(/[А-Яа-яІіЇїЄєҐґA-Ya-y]{3,}ськ[иі]й\s+район|[А-Яа-яІіЇїЄєҐґA-Ya-y]{3,}ск[иі]й\s+район/i);
  return m?.[0] ?? null;
}

export function isVagueOblastName(name: string): boolean {
  const n = foldUa(name);
  return (
    /^(харківська|харьковская)?\s*(область|обл)$/.test(n) ||
    n === 'харківська' ||
    n === 'харьковская' ||
    n === 'харківської' ||
    n === 'харьковской' ||
    n === 'область' ||
    n === 'пригород' ||
    n === 'передмістя' ||
    n === 'передместья' ||
    n === 'околиці' ||
    n === 'околицы'
  );
}

/** City-wide Kharkiv alert with no specific district/settlement. */
export function isCityWideKharkivCue(text: string): boolean {
  const n = foldUa(text);
  if (!n) return false;
  const city =
    /(?:^|\s)(харків|харьков|kharkiv)(?:\s|$|та|и|у|е|і|,)|по\s+харк|по\s+харьк|харків\s+та|харьков\s+и/.test(
      n,
    );
  const wide =
    /передміст|пригород|повітрян\w*\s+тривог|воздушн\w*\s+тревог|тривога|тревога|по\s+місту|по\s+городу|всьому\s+місту|всему\s+городу/.test(
      n,
    );
  return city && wide;
}

/** Drop labels that are not worth geocoding / admin explain prompts. */
export function isPlausiblePlaceLabel(name: string): boolean {
  const raw = name.trim();
  if (raw.length < 3 || raw.length > 64) return false;
  if (isVagueOblastName(raw)) return false;
  const n = foldUa(raw);
  if (!n) return false;
  if (!/[а-яa-z]/i.test(n)) return false;
  if (/^(так|ні|да|нет|ок|hello|test)$/.test(n)) return false;
  return true;
}

/** Cities / oblasts that air channels mention but we do not alert on. */
const OUTSIDE_CITY_RE: Array<{ name: string; re: RegExp }> = [
  { name: 'Київ', re: /(?:^|\s)(ки[иеє]в|киев|kyiv|kiev)(?!ськ|ск)(?:а|у|е|і|ом)?(?:\s|$)/ },
  { name: 'Полтава', re: /(?:^|\s)полтав(?:а|у|и|і|е|ой)?(?:\s|$)/ },
  { name: 'Суми', re: /(?:^|\s)(суми|сумы|сум[уиы])(?:\s|$)/ },
  { name: 'Дніпро', re: /(?:^|\s)(дн[иі]про|днепр)(?:а|у|е|о)?(?:\s|$)/ },
  { name: 'Чернігів', re: /(?:^|\s)черн[иі]г[иі]в(?:а|у|е|і)?(?:\s|$)/ },
  { name: 'Запоріжжя', re: /(?:^|\s)запор[иі]ж(?:жя|ье|жя|жжя)?(?:\s|$)/ },
  { name: 'Донецьк', re: /(?:^|\s)донецьк(?:а|у|е)?(?:\s|$)/ },
  { name: 'Луганськ', re: /(?:^|\s)луганськ(?:а|у|е)?(?:\s|$)/ },
  { name: 'Одеса', re: /(?:^|\s)одес(?:а|у|и|і)?(?:\s|$)/ },
  { name: 'Миколаїв', re: /(?:^|\s)микола[їи]в(?:а|у|е)?(?:\s|$)/ },
  { name: 'Херсон', re: /(?:^|\s)херсон(?:а|у|е|і)?(?:\s|$)/ },
  { name: 'Черкаси', re: /(?:^|\s)черкас(?:и|ы)?(?:\s|$)/ },
  { name: 'Кропивницький', re: /(?:^|\s)(кропивниц|к[іі]ровоград)(?:ький|ский|а|у)?(?:\s|$)/ },
  { name: 'Вінниця', re: /(?:^|\s)в[иі]нниц(?:я|а|ю|у|і)?(?:\s|$)/ },
  { name: 'Житомир', re: /(?:^|\s)житомир(?:а|у|е|і)?(?:\s|$)/ },
  { name: 'Бєлгород', re: /(?:^|\s)б[єе]лгород(?:а|у|е|і)?(?:\s|$)/ },
];

function stripKharkivFalseFriends(folded: string): string {
  return folded
    .replace(/ки[иеє]вськ\w*\s+район/g, ' ')
    .replace(/киевск\w*\s+район/g, ' ')
    .replace(/полтавськ\w*\s+шлях/g, ' ')
    .replace(/полтавск\w*\s+шлях/g, ' ')
    .replace(/сумськ\w*\s+вул/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function findOutsideCities(text: string, extra: string[] = []): string[] {
  const n = stripKharkivFalseFriends(foldUa([text, ...extra].filter(Boolean).join(' ')));
  if (!n) return [];
  if (
    /полтавськ\w*\s+област|полтавск\w*\s+област|ки[иеє]вськ\w*\s+област|киевск\w*\s+област|сумськ\w*\s+област|сумск\w*\s+област/.test(
      n,
    )
  ) {
    const oblast: string[] = [];
    if (/полтавськ|полтавск/.test(n)) oblast.push('Полтавська область');
    if (/ки[иеє]вськ|киевск/.test(n)) oblast.push('Київська область');
    if (/сумськ|сумск/.test(n)) oblast.push('Сумська область');
    return [...new Set(oblast)];
  }
  const hits: string[] = [];
  for (const row of OUTSIDE_CITY_RE) {
    if (row.re.test(n)) hits.push(row.name);
  }
  return hits;
}

export function hasKharkivLocalCue(text: string): boolean {
  const n = foldUa(text);
  return /харк[иі]в|харьков|kharkiv|салт[иі]в|олекс[иі]|хтз|п[иі]сочин|дергач|циркун|липц|данилив|науков|немишл|роган|холодна гора|ки[иеє]вськ\w*\s+район|полтавськ\w*\s+шлях|ст салтов|старий салтов/.test(
    n,
  );
}

export function isForeignOnlyThreat(text: string, extra: string[] = []): boolean {
  const foreign = findOutsideCities(text, extra);
  if (!foreign.length) return false;
  return !hasKharkivLocalCue(text);
}

export function nominativeGuesses(name: string): string[] {
  const raw = name.trim();
  const folded = foldUa(raw);
  const out = new Set<string>([raw, folded].filter(Boolean));
  if (folded.length < 5) return [...out];

  if (/ського$/.test(folded)) out.add(folded.replace(/ського$/, 'ський'));
  if (/ского$/.test(folded)) out.add(folded.replace(/ского$/, 'ский'));
  if (/ській$/.test(folded)) out.add(folded.replace(/ській$/, 'ський'));
  if (/ской$/.test(folded)) out.add(folded.replace(/ской$/, 'ский'));
  if (/ою$/.test(folded)) out.add(folded.replace(/ою$/, 'а'));
  if (/ею$/.test(folded)) out.add(folded.replace(/ею$/, 'я'));
  if (/ом$/.test(folded)) out.add(folded.replace(/ом$/, ''));
  if (/ем$/.test(folded)) out.add(folded.replace(/ем$/, ''));
  if (/ах$/.test(folded)) out.add(folded.replace(/ах$/, 'и'));
  if (/ях$/.test(folded)) out.add(folded.replace(/ях$/, 'і'));
  if (/у$/.test(folded)) out.add(folded.replace(/у$/, 'а'));
  if (/ю$/.test(folded)) out.add(folded.replace(/ю$/, 'я'));
  if (/і$/.test(folded) && !/ські$|цькі$/.test(folded)) out.add(folded.replace(/і$/, 'а'));
  if (/ї$/.test(folded)) out.add(folded.replace(/ї$/, 'я'));
  if (/и$/.test(folded) && folded.length >= 6) out.add(folded.replace(/и$/, 'а'));

  return [...out];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
