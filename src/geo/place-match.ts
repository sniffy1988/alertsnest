import type { PlaceKind } from './ua-gazetteer';
import { foldUa } from './fold-ua';
import { expandAliases, formMatches, placeForms } from './place-forms';

export { foldUa } from './fold-ua';
export { placeForms, expandAliases, formMatches } from './place-forms';

export const OBLAST_BBOX = { minLat: 48.45, maxLat: 50.55, minLon: 34.75, maxLon: 38.15 };

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

  const tokens = foldedText.split(' ').filter(Boolean);
  return tokens.some((token) => tokenRefersToName(token, name));
}

/**
 * Strict token↔name link via multilingual forms (UA/RU cases).
 * Does NOT equate stem-siblings (Лозова ≠ Лозове).
 */
export function tokenRefersToName(token: string, name: string): boolean {
  const ft = foldUa(token);
  const fl = foldUa(name);
  if (!ft || !fl) return false;
  if (formMatches(token, name)) return true;
  for (const variant of placeVariants(name)) {
    if (formMatches(token, variant)) return true;
  }
  if (/\s+район$/.test(fl)) {
    const head = fl.replace(/\s+район$/, '');
    if (ft === head || formMatches(token, head)) return true;
    if (
      /(ський|ский|ська|ская|ське|ское|ській|ской)$/.test(ft) &&
      placeStem(ft) === placeStem(head)
    ) {
      return true;
    }
  }
  return false;
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
    const stem = streetHeadStem(item.name);
    if (!outerStems.has(stem) && !outerStems.has(placeStem(item.name))) return true;
    return streetFormInText(text, item.name);
  });
}

function streetHeadStem(streetName: string): string {
  const head =
    foldUa(streetName)
      .replace(/^(вул|улица|просп|пр|майдан)\s+/, '')
      .split(/\s+/)[0] ?? '';
  return placeStem(head);
}

/** When «X район» is in text, keep that region — drop stem-sibling settlements/streets. */
export function preferRaionOverStemSiblings<T extends { name: string; kind?: PlaceKind; matchType?: PlaceKind }>(
  items: T[],
  text: string,
): T[] {
  if (!mentionsAdminRaion(text)) return items;
  const kindOf = (item: T) => item.kind ?? item.matchType;
  const raions = items.filter((item) => kindOf(item) === 'region' && /район/i.test(item.name));
  if (!raions.length) return items;
  const mentioned = raions.filter((item) => mentionedIn(text, item.name));
  const keep = mentioned.length ? mentioned : raions;
  return keep;
}

/** Among stem-siblings, keep only items that the text actually refers to. */
export function dropStemSiblings<T extends { name: string; kind?: PlaceKind; matchType?: PlaceKind }>(
  items: T[],
  text: string,
): T[] {
  if (items.length < 2) return items;
  const kindOf = (item: T) => item.kind ?? item.matchType;
  const byStem = new Map<string, T[]>();
  for (const item of items) {
    const stem = placeStem(item.name);
    if (stem.length < 4) continue;
    const list = byStem.get(stem) ?? [];
    list.push(item);
    byStem.set(stem, list);
  }
  const drop = new Set<T>();
  for (const group of byStem.values()) {
    if (group.length < 2) continue;
    const referred = group.filter((item) => mentionedIn(text, item.name));
    const winners = referred.length ? referred : group;
    // Prefer region > settlement > district > street when several still match
    const rank = (item: T) => {
      const k = kindOf(item);
      if (k === 'region') return 4;
      if (k === 'settlement') return 3;
      if (k === 'district') return 2;
      if (k === 'city') return 1;
      return 0;
    };
    const bestRank = Math.max(...winners.map(rank));
    const best = winners.filter((item) => rank(item) === bestRank);
    for (const item of group) {
      if (!best.includes(item)) drop.add(item);
    }
  }
  return items.filter((item) => !drop.has(item));
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
  if (isForeignOblastLabel(raw)) return false;
  const n = foldUa(raw);
  if (!n) return false;
  if (!/[а-яa-z]/i.test(n)) return false;
  if (/^(так|ні|да|нет|ок|hello|test)$/.test(n)) return false;
  return true;
}

/** Cities / oblasts that air channels mention but we do not alert on. */
const OUTSIDE_CITY_RE: Array<{ name: string; re: RegExp }> = [
  { name: 'Київ', re: /(?:^|\s)(ки[иеє]в|киев|kyiv|kiev)(?!ськ|ск|щин)(?:а|у|е|і|ом)?(?:\s|$)/ },
  { name: 'Полтава', re: /(?:^|\s)полтав(?:а|у|и|і|е|ой)?(?:\s|$)/ },
  { name: 'Полтавська область', re: /(?:^|\s)полтав(?:ськ[а-я]*\s+област|ск[а-я]*\s+област|щин[а-я]*)/ },
  { name: 'Суми', re: /(?:^|\s)(суми|сумы|сум[уиы])(?:\s|$)/ },
  { name: 'Сумська область', re: /(?:^|\s)сум(?:ськ[а-я]*\s+област|ск[а-я]*\s+област|щин[а-я]*)/ },
  { name: 'Київська область', re: /(?:^|\s)(ки[иеє]вщин[а-я]*|киевщин[а-я]*|ки[иеє]вськ[а-я]*\s+област|киевск[а-я]*\s+област)/ },
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
    .replace(/ки[иеє]вськ[а-я]*\s+район/g, ' ')
    .replace(/киевск[а-я]*\s+район/g, ' ')
    .replace(/полтавськ[а-я]*\s+шлях/g, ' ')
    .replace(/полтавск[а-я]*\s+шлях/g, ' ')
    .replace(/сумськ[а-я]*\s+вул/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isForeignOblastLabel(name: string): boolean {
  const n = foldUa(name);
  if (!n) return false;
  if (/^харк|^харьков/.test(n)) return false;
  return (
    /^(полтав|сум|ки[иеє]в|киев|дн[иі]про|днепр|запор|черн[иі]г|донець|луган|одес|микола|херсон|черкас|житомир|в[иі]нниц|б[єе]лгород)/.test(
      n,
    ) && /(област|щин|ська|ская|ский|ський)/.test(n)
  );
}

export function findOutsideCities(text: string, extra: string[] = []): string[] {
  const n = stripKharkivFalseFriends(foldUa([text, ...extra].filter(Boolean).join(' ')));
  if (!n) return [];
  const hits: string[] = [];
  for (const row of OUTSIDE_CITY_RE) {
    if (row.re.test(n)) hits.push(row.name);
  }
  for (const label of extra) {
    if (isForeignOblastLabel(label)) hits.push(label.trim());
  }
  return [...new Set(hits)];
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

/** @deprecated use placeForms — kept as thin alias for geocode query expansion */
export function nominativeGuesses(name: string): string[] {
  return placeForms(name);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
