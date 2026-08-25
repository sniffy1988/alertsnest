import { normalize } from '../common/text';

/** Ukrainian/Russian orthography fold for toponym matching. */
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
