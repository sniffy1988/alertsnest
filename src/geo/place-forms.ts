import { foldUa } from './fold-ua';

/**
 * Multilingual place-name forms (Ukrainian + Russian) for toponym matching.
 * Generates declined surface forms and UA↔RU lemma pairs (Лозова ↔ Лозовая, -івка ↔ -евка).
 */

const formCache = new Map<string, string[]>();

/** All folded surface forms for a place label (lemma + cases + cross-lang). */
export function placeForms(name: string): string[] {
  const key = foldUa(name);
  if (!key) return [];
  const cached = formCache.get(key);
  if (cached) return cached;

  const out = new Set<string>();
  for (const lemma of expandLemmas(name)) {
    out.add(foldUa(lemma));
    for (const form of declineLemma(lemma)) out.add(foldUa(form));
  }
  // Also decline from the surface token itself (when input is already declined)
  for (const lemma of recoverLemmas(name)) {
    out.add(foldUa(lemma));
    for (const form of declineLemma(lemma)) out.add(foldUa(form));
  }

  const list = [...out].filter((s) => s.length >= 2);
  formCache.set(key, list);
  return list;
}

/** True if token is a known form of name (any case / UA or RU). */
export function formMatches(token: string, name: string): boolean {
  const ft = foldUa(token);
  if (!ft) return false;
  const nameForms = placeForms(name);
  if (nameForms.includes(ft)) return true;
  const tokenForms = placeForms(token);
  return tokenForms.some((tf) => nameForms.includes(tf));
}

/** UA↔RU cores without equating Лозова↔Лозове (-а vs -е). */
export function softCore(name: string): string {
  let f = foldUa(name);
  if (/ая$/.test(f)) f = f.replace(/ая$/, 'а');
  if (/яя$/.test(f)) f = f.replace(/яя$/, 'я');
  if (/евка$/.test(f)) f = f.replace(/евка$/, 'ивка');
  if (/овка$/.test(f)) f = f.replace(/овка$/, 'ивка');
  return f;
}

/** Lemmas in both languages from a single label. */
export function expandLemmas(name: string): string[] {
  const raw = name.trim();
  const f = foldUa(raw);
  if (!f) return [];
  const out = new Set<string>([raw, f]);

  // Strip admin suffixes for lemma work
  const head = f.replace(/\s+(район|област|обл)$/, '').trim();
  if (head && head !== f) {
    out.add(head);
    for (const x of crossLangPair(head)) out.add(x);
  }

  for (const x of crossLangPair(f)) out.add(x);

  // Adjective + район: лозивский район → keep full + head
  if (/\s+район$/.test(f)) {
    const adj = f.replace(/\s+район$/, '');
    out.add(adj);
    for (const x of ukAdjForms(adj)) out.add(x);
    for (const x of ruAdjForms(adj)) out.add(x);
  }

  return [...out];
}

function crossLangPair(folded: string): string[] {
  const out: string[] = [folded];
  // Лозова (UA) ↔ Лозовая (RU)
  if (/ая$/.test(folded)) out.push(folded.replace(/ая$/, 'а'));
  if (/(ов|ев|ин|ын)а$/.test(folded)) out.push(folded.replace(/а$/, 'ая'));
  // -івка ↔ -евка / -овка
  if (/ивка$/.test(folded)) {
    out.push(folded.replace(/ивка$/, 'евка'));
    out.push(folded.replace(/ивка$/, 'овка'));
  }
  if (/евка$/.test(folded)) out.push(folded.replace(/евка$/, 'ивка'));
  if (/овка$/.test(folded)) out.push(folded.replace(/овка$/, 'ивка'));
  return out;
}

/** Recover possible lemmas from a declined surface form. */
function recoverLemmas(surface: string): string[] {
  const f = foldUa(surface);
  const out = new Set<string>([f]);

  const rules: Array<[RegExp, string | ((m: string) => string)]> = [
    [/ую$/, 'ая'],
    [/ую$/, 'а'],
    [/юю$/, 'яя'],
    [/юю$/, 'я'],
    [/ою$/, 'а'],
    [/ею$/, 'я'],
    [/ой$/, 'ая'],
    [/ой$/, 'а'],
    [/ои$/, 'а'], // лозової
    [/ии$/, 'я'],
    [/ом$/, ''],
    [/ем$/, ''],
    [/ам$/, 'и'],
    [/ями$/, 'я'],
    [/ами$/, 'и'],
    [/ах$/, 'и'],
    [/ях$/, 'і'],
    [/у$/, 'а'],
    [/ю$/, 'я'],
    // do NOT map -е → -а (Лозове ≠ Лозова)
    [/и$/, 'а'],
    [/і$/, 'а'],
    [/ського$/, 'ський'],
    [/ского$/, 'ский'],
    [/ській$/, 'ський'],
    [/ской$/, 'ский'],
    [/ською$/, 'ська'],
    [/ской$/, 'ская'],
    [/скую$/, 'ская'],
    [/ська$/, 'ський'],
    [/ская$/, 'ский'],
  ];

  for (const [re, repl] of rules) {
    if (!re.test(f)) continue;
    const next = typeof repl === 'string' ? f.replace(re, repl) : repl(f);
    if (next && next !== f) out.add(next);
  }

  // лозовій → foldUa → лозовий; map овий → ова for possessive place names
  if (/овии$/.test(f) && f.length >= 6) {
    out.add(f.replace(/овии$/, 'ова'));
  }

  for (const lemma of [...out]) {
    for (const x of crossLangPair(lemma)) out.add(x);
  }
  return [...out];
}

function declineLemma(lemma: string): string[] {
  const f = foldUa(lemma);
  if (f.length < 3) return [f];

  if (/\s+район$/.test(f)) {
    const adj = f.replace(/\s+район$/, '');
    const forms = new Set<string>([f]);
    for (const a of [...ukAdjForms(adj), ...ruAdjForms(adj)]) {
      forms.add(`${a} район`);
      forms.add(a);
    }
    return [...forms];
  }

  if (/(ський|ский|ська|ская|ське|ское)$/.test(f)) {
    return [...ukAdjForms(f), ...ruAdjForms(f)];
  }

  // Feminine RU -ая (Лозовая)
  if (/ая$/.test(f)) {
    const stem = f.slice(0, -2);
    return [
      f,
      `${stem}ой`,
      `${stem}ую`,
      `${stem}ою`,
      `${stem}а`, // UA twin
    ];
  }

  // Feminine UA/RU -а (Лозова, Сахновщина, Павлівка after fold)
  if (/а$/.test(f)) {
    const stem = f.slice(0, -1);
    return [
      f,
      `${stem}и`,
      `${stem}і`,
      `${stem}у`,
      `${stem}ю`,
      `${stem}ою`,
      `${stem}ею`,
      `${stem}ои`, // gen UA folded
      `${stem}ая`, // RU twin
      `${stem}ой`,
      `${stem}ую`,
    ];
  }

  // Feminine -я
  if (/я$/.test(f) && !/ая$/.test(f)) {
    const stem = f.slice(0, -1);
    return [f, `${stem}і`, `${stem}ю`, `${stem}ею`, `${stem}ей`, `${stem}ям`, `${stem}ях`];
  }

  // Neuter -е / -о (Лісне, Селекційне) — keep limited
  if (/[ео]$/.test(f)) {
    const stem = f.slice(0, -1);
    return [f, `${stem}ого`, `${stem}ому`, `${stem}им`, `${stem}ом`];
  }

  // Masculine / indeclinable-ish (Ізюм, ХТЗ)
  if (/[бвгдзклмнпрстфхцчшщ]$/.test(f)) {
    return [f, `${f}а`, `${f}у`, `${f}ом`, `${f}е`, `${f}і`];
  }

  return [f];
}

function ukAdjForms(adj: string): string[] {
  const f = foldUa(adj);
  let stem = f;
  stem = stem.replace(/(ський|ский|ська|ская|ське|ское|ській|ской)$/, '');
  if (stem.length < 3) return [f];
  return [
    `${stem}ський`,
    `${stem}ская`,
    `${stem}ська`,
    `${stem}ське`,
    `${stem}ское`,
    `${stem}ського`,
    `${stem}ского`,
    `${stem}ській`,
    `${stem}ской`,
    `${stem}ську`,
    `${stem}скую`,
    `${stem}ською`,
    `${stem}ским`,
    `${stem}ським`,
  ];
}

function ruAdjForms(adj: string): string[] {
  return ukAdjForms(adj); // overlapped after foldUa
}

/** Expand aliases for DB/index: original + multilingual forms (capped). */
export function expandAliases(name: string, existing: string[] = [], cap = 40): string[] {
  const out = new Set<string>();
  for (const x of [name, ...existing]) {
    const n = x.trim();
    if (!n) continue;
    out.add(n);
    out.add(foldUa(n));
  }
  for (const form of placeForms(name)) {
    out.add(form);
    if (out.size >= cap) break;
  }
  // Prefer keeping explicit existing even over cap
  for (const x of existing) {
    if (x.trim()) out.add(foldUa(x));
  }
  return [...out].filter(Boolean);
}
