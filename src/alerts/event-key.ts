import { foldUa, namesEqual, placeStem } from '../geo/place-match';

export const ALERT_DEDUP_MS = 30 * 60 * 1000;

export type EventKeyParts = {
  lost: boolean;
  type: string;
  places: string[];
};

export function canonicalEventKey(opts: {
  threatType: string | null;
  places: Array<{ code: string }>;
  trackLost?: boolean;
}): string {
  if (opts.threatType === 'all_clear') return 'all_clear:kharkiv';
  const type = (opts.threatType || 'threat').toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  const places = [
    ...new Set(opts.places.map((p) => normalizePlaceToken(p.code)).filter(Boolean)),
  ].sort();
  const place = places.join('+') || 'kharkiv';
  return `${opts.trackLost ? 'lost:' : ''}${type}:${place}`;
}

export function parseEventKey(key: string): EventKeyParts {
  const raw = key.trim();
  const lost = raw.startsWith('lost:');
  const rest = lost ? raw.slice(5) : raw;
  const colon = rest.indexOf(':');
  const type = (colon >= 0 ? rest.slice(0, colon) : rest).toLowerCase() || 'threat';
  const placeRaw = colon >= 0 ? rest.slice(colon + 1) : '';
  const places = placeRaw
    .split(/[+|,/]/)
    .map((p) => normalizePlaceToken(p))
    .filter(Boolean);
  return { lost, type, places };
}

export function eventKeysOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const pa = parseEventKey(a);
  const pb = parseEventKey(b);
  if (pa.lost !== pb.lost) return false;
  if (pa.type !== pb.type) return false;
  if (pa.places.length === 0 || pb.places.length === 0) return pa.type === pb.type;
  return pa.places.some((left) => pb.places.some((right) => placesMatch(left, right)));
}

function normalizePlaceToken(raw: string): string {
  const stemmed = placeStem(raw).replace(/\s+/g, '_');
  return stemmed || foldUa(raw).replace(/\s+/g, '_') || raw.toLowerCase().trim();
}

function placesMatch(a: string, b: string): boolean {
  if (a === b) return true;
  return namesEqual(a.replace(/_/g, ' '), b.replace(/_/g, ' '));
}
