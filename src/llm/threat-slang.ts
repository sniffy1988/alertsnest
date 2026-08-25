import { normalize } from '../common/text';
import { isAllClearPost, isContinuation, isEtaOnly, isTrackLost, leftOblast } from '../alerts/message-chain';

export type ThreatKind =
  | 'shahed'
  | 'ballistic'
  | 'cruise'
  | 'kinzhal'
  | 'kh59'
  | 'kab'
  | 'missile'
  | 'recon'
  | 'aircraft'
  | 'explosion'
  | 'air_raid'
  | 'sam'
  | 'mlrs'
  | 'jet_uav'
  | 'strike_uav'
  | 'all_clear'
  | 'none'
  | 'other';

export const THREAT_LABELS: Record<ThreatKind, { ua: string; ru: string; en: string }> = {
  shahed: { ua: 'Шахед («мопед»)', ru: 'Шахед («мопед»)', en: 'Shahed' },
  ballistic: { ua: 'Балістика', ru: 'Баллистика', en: 'Ballistic missile' },
  cruise: { ua: 'Крилата ракета', ru: 'Крылатая ракета', en: 'Cruise missile' },
  kinzhal: { ua: 'Кинджал', ru: 'Кинжал', en: 'Kinzhal' },
  kh59: { ua: 'Х-59', ru: 'Х-59', en: 'Kh-59' },
  kab: { ua: 'КАБ / ФАБ', ru: 'КАБ / ФАБ', en: 'Guided bomb' },
  missile: { ua: 'Ракета', ru: 'Ракета', en: 'Missile' },
  recon: { ua: 'Дорозвідка', ru: 'Доразведка', en: 'Recon drone' },
  aircraft: { ua: 'Літак-носій', ru: 'Самолёт-носитель', en: 'Launch aircraft' },
  explosion: { ua: 'Приліт / вибух', ru: 'Прилёт / взрыв', en: 'Impact / explosion' },
  air_raid: { ua: 'Повітряна загроза', ru: 'Воздушная угроза', en: 'Air threat' },
  sam: { ua: 'ППО працює', ru: 'ПВО работает', en: 'Air defense' },
  mlrs: { ua: 'РСЗО', ru: 'РСЗО', en: 'MLRS' },
  jet_uav: { ua: 'Реактивний БПЛА', ru: 'Реактивный БПЛА', en: 'Jet UAV' },
  strike_uav: { ua: 'Ударний БПЛА', ru: 'Ударный БПЛА', en: 'Strike UAV' },
  all_clear: { ua: 'Відбій / чисто', ru: 'Отбой / чисто', en: 'All clear' },
  none: { ua: 'Не загроза', ru: 'Не угроза', en: 'Not a threat' },
  other: { ua: 'Загроза', ru: 'Угроза', en: 'Threat' },
};

const SLANG: Array<{ needles: string[]; type: ThreatKind; allClear?: boolean }> = [
  { needles: ['відбій', 'отбой', 'укриття знято', 'укрытие снято', 'все чисто', 'усе чисто', 'повітря чисто', 'воздух чисто'], type: 'all_clear', allClear: true },
  {
    needles: [
      'реактивний бпла',
      'реактивный бпла',
      'реактивн. бпла',
      'реактивні бпла',
      'реактивных бпла',
      'швидкісн',
      'скоростн',
      'р. шах',
      'р шах',
      'р.шах',
      'р. шаболд',
      'р шаболд',
      'р.шаболд',
    ],
    type: 'jet_uav',
  },
  { needles: ['шахед', 'шахеды', 'шахеді', 'шаболд', 'мопед', 'мопеди', 'герань', 'geran', 'бпла-камікадзе', 'бандерол', 'блядерол'], type: 'shahed' },
  { needles: ['ударний бпла', 'ударный бпла', 'ударний на', 'ударный на'], type: 'strike_uav' },
  { needles: ['кинжал', 'кинджал', 'кінжал'], type: 'kinzhal' },
  { needles: ['іскандер-к', 'искандер-к', 'калибр', 'калібр', 'онікс', 'оникс', 'крилата', 'крылата'], type: 'cruise' },
  { needles: ['орешник', 'орешника', 'oreshnik'], type: 'ballistic' },
  { needles: ['баліст', 'баллист', 'іскандер', 'искандер'], type: 'ballistic' },
  { needles: ['-59', 'х-59', 'х59', 'x-59', 'x59'], type: 'kh59' },
  { needles: ['каб', 'кабы', 'фаб', 'умпк', 'умпк'], type: 'kab' },
  { needles: ['дорозвід', 'доразвед', 'розвідник', 'разведчик'], type: 'recon' },
  { needles: ['31к', 'міг-31', 'миг-31', 'ту-95', 'ту-22', 'ту-160', 'стратег'], type: 'aircraft' },
  { needles: ['рсзо', 'рсзв', 'залп граду', 'установки град', 'смерч', 'вільха', 'ольха'], type: 'mlrs' },
  { needles: ['наша бойова', 'наша боевая', 'ппо', 'пво'], type: 'sam' },
  { needles: ['приліт', 'прилет', 'вибух', 'взрыв', 'упав', 'упал'], type: 'explosion' },
  { needles: ['ракета', 'ракет'], type: 'missile' },
  { needles: ['повітря', 'воздух', 'загроз', 'угроз'], type: 'air_raid' },
];

export function threatLabel(type: string | null | undefined, locale = 'ua'): string {
  const key = (type as ThreatKind) in THREAT_LABELS ? (type as ThreatKind) : 'other';
  const pack = THREAT_LABELS[key];
  if (locale.startsWith('ru')) return pack.ru;
  if (locale.startsWith('en')) return pack.en;
  return pack.ua;
}

export function detectThreatSlang(text: string): { type: ThreatKind; allClear: boolean } | null {
  const n = normalize(text);
  if (!n) return null;
  for (const row of SLANG) {
    if (row.needles.some((needle) => n.includes(normalize(needle)))) {
      return { type: row.type, allClear: Boolean(row.allClear) };
    }
  }
  return null;
}

/** True when a "place" string is really a weapon / alert word, not a toponym. */
export function isThreatLabel(name: string): boolean {
  const n = normalize(name)
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
  if (!n || n.length < 3) return true;
  if (
    /^(балист\w*|баллист\w*|шахед\w*|шаболд\w*|мопед\w*|геран\w*|кинжал\w*|кинджал\w*|орешник\w*|калибр\w*|калібр\w*|іскандер\w*|искандер\w*|ракет\w*|каб\w*|фаб\w*|умпк|бпла\w*|ппо|пво|тривог\w*|тревог\w*|загроз\w*|угроз\w*|повітря|воздух|приліт\w*|прилет\w*|вибух\w*|взрыв\w*|бандерол\w*|oreshnik|shahed|kinzhal|iskander)$/.test(
      n,
    )
  ) {
    return true;
  }
  // Single declined threat lemma: "баллистике", "орешника"
  for (const row of SLANG) {
    if (row.allClear) continue;
    for (const needle of row.needles) {
      const stem = normalize(needle).replace(/(ике|ики|ика|ику|ам|ами|ах|ов|ів|ей)?$/i, '').slice(0, 6);
      if (stem.length >= 4 && n.includes(stem) && n.length <= stem.length + 4) return true;
    }
  }
  return false;
}

export function enrichThreatType(
  text: string,
  llmType: string | null,
  llmIsThreat: boolean,
  context: string[] = [],
): { threatType: string; isThreat: boolean; notify: boolean; fromSlang: boolean; trackLost: boolean } {
  const trackLost = isTrackLost(text);
  const left = leftOblast(text);
  const chained = context.length > 0 || isContinuation(text);
  const combined = [...context, text].join('\n');
  const slang = detectThreatSlang(chained || trackLost ? combined : text);
  const textAllClear = isAllClearPost(text) || isAllClearPost(combined);
  const weak = !llmType || llmType === 'other' || llmType === 'all_clear' || llmType === 'none';
  // local vs foreign is decided later by geocode + distance, not by slang regex
  if (slang) {
    const type = weak ? slang.type : llmType;
    const allClear = !trackLost && !left && (slang.allClear || textAllClear);
    return {
      threatType: allClear ? 'all_clear' : type,
      isThreat: !allClear,
      notify: !isEtaOnly(text),
      fromSlang: weak,
      trackLost,
    };
  }
  const allClear = !trackLost && !left && textAllClear;
  const empty = !allClear && !llmIsThreat && !trackLost && !chained;
  return {
    threatType: allClear ? 'all_clear' : empty ? 'none' : (llmType && llmType !== 'all_clear' ? llmType : 'other'),
    isThreat: allClear ? false : llmIsThreat || trackLost || chained,
    notify: !isEtaOnly(text) && (allClear || llmIsThreat || trackLost || chained),
    fromSlang: false,
    trackLost,
  };
}
