import type { PlaceKind } from './ua-gazetteer';
import { foldUa, inKharkivOblast, namesEqual, placeStem } from './place-match';

export type GeocodeAddress = {
  state?: string;
  county?: string;
  city?: string;
  town?: string;
  village?: string;
  hamlet?: string;
  suburb?: string;
  neighbourhood?: string;
  road?: string;
  municipality?: string;
  'ISO3166-2-lvl4'?: string;
  country_code?: string;
};

export type RawGeocodeHit = {
  lat: number;
  lon: number;
  name?: string;
  displayName?: string;
  class?: string;
  type?: string;
  addresstype?: string;
  importance?: number;
  address?: GeocodeAddress;
};

export type RankedGeocodeHit = {
  lat: number;
  lon: number;
  displayName?: string;
  inOblast: boolean;
  kind: PlaceKind;
  score: number;
  nameMatch: boolean;
};

export type GeocodeHint = { lat: number; lon: number };

const SETTLEMENT_TYPES = new Set([
  'city',
  'town',
  'village',
  'hamlet',
  'isolated_dwelling',
  'suburb',
  'neighbourhood',
  'quarter',
  'municipality',
]);
const DISTRICT_TYPES = new Set(['suburb', 'neighbourhood', 'quarter', 'borough', 'city_district', 'district']);
const STREET_TYPES = new Set(['road', 'residential', 'living_street', 'pedestrian', 'tertiary', 'secondary', 'primary', 'trunk', 'unclassified', 'service', 'path']);

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (n: number) => (n * Math.PI) / 180;
  const r = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

export function addressLooksLikeKharkivOblast(address?: GeocodeAddress): boolean | null {
  if (!address) return null;
  const iso = address['ISO3166-2-lvl4'];
  if (iso) return /^UA-63$/i.test(iso);
  const state = foldUa(address.state ?? '');
  if (!state) return null;
  if (/харк|kharkiv|харьков/.test(state)) return true;
  if (/полтав|сум|ки[иеє]в|днепр|дн[иі]про|луган|донець/.test(state)) return false;
  return null;
}

export function kindFromOsmTags(
  hit: Pick<RawGeocodeHit, 'class' | 'type' | 'addresstype'>,
  fallback: PlaceKind,
): PlaceKind {
  const addresstype = hit.addresstype ?? '';
  const type = hit.type ?? '';
  const cls = hit.class ?? '';

  if (addresstype === 'city' || type === 'city') return 'city';
  if (addresstype === 'state' || addresstype === 'county' || type === 'state' || type === 'county') {
    return 'region';
  }
  if (
    DISTRICT_TYPES.has(addresstype) ||
    DISTRICT_TYPES.has(type) ||
    (cls === 'place' && DISTRICT_TYPES.has(type))
  ) {
    return 'district';
  }
  if (
    addresstype === 'road' ||
    cls === 'highway' ||
    STREET_TYPES.has(type) ||
    STREET_TYPES.has(addresstype)
  ) {
    return 'street';
  }
  if (
    SETTLEMENT_TYPES.has(addresstype) ||
    SETTLEMENT_TYPES.has(type) ||
    (cls === 'place' && SETTLEMENT_TYPES.has(type))
  ) {
    if (type === 'suburb' || type === 'neighbourhood' || type === 'quarter') return 'district';
    return 'settlement';
  }
  return fallback;
}

export function nameMatchesQuery(query: string, hit: RawGeocodeHit): boolean {
  const q = foldUa(query);
  if (!q) return false;
  const candidates = [
    hit.name,
    hit.displayName?.split(',')[0],
    hit.address?.road,
    hit.address?.village,
    hit.address?.hamlet,
    hit.address?.town,
    hit.address?.city,
    hit.address?.suburb,
    hit.address?.neighbourhood,
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (namesEqual(q, candidate)) return true;
    const stemQ = placeStem(q);
    const stemC = placeStem(candidate);
    if (stemQ.length >= 5 && stemQ === stemC) return true;
  }
  return false;
}

function typeMatchesKind(kind: PlaceKind, hit: RawGeocodeHit): boolean {
  const derived = kindFromOsmTags(hit, kind);
  if (kind === 'city') return derived === 'city' || derived === 'settlement';
  if (kind === 'settlement') return derived === 'settlement' || derived === 'city' || derived === 'district';
  if (kind === 'district') return derived === 'district' || derived === 'settlement';
  if (kind === 'street') return derived === 'street';
  if (kind === 'region') return derived === 'region' || derived === 'settlement';
  return true;
}

export function rankGeocodeHits(
  query: string,
  kind: PlaceKind,
  hits: RawGeocodeHit[],
  opts?: { hint?: GeocodeHint | null; requireNameMatch?: boolean },
): RankedGeocodeHit[] {
  const hint = opts?.hint;
  const requireName = opts?.requireNameMatch !== false;
  const ranked: RankedGeocodeHit[] = [];

  for (const hit of hits) {
    if (!Number.isFinite(hit.lat) || !Number.isFinite(hit.lon)) continue;
    const bboxOk = inKharkivOblast(hit.lat, hit.lon);
    const addrOk = addressLooksLikeKharkivOblast(hit.address);
    if (addrOk === false) continue;
    const inOblast = bboxOk;
    // Foreign hits kept only when name matches (for caller status); score stays low.

    const nameMatch = nameMatchesQuery(query, hit);
    if (requireName && !nameMatch) continue;

    const derivedKind = kindFromOsmTags(hit, kind);
    let score = 0;
    if (nameMatch) score += 100;
    if (inOblast) score += 40;
    if (addrOk === true) score += 20;
    if (typeMatchesKind(kind, hit)) score += 25;
    if (derivedKind === kind) score += 10;
    score += Math.min(Math.max(hit.importance ?? 0, 0), 1) * 5;

    const refLat = hint?.lat;
    const refLon = hint?.lon;
    if (refLat != null && refLon != null) {
      const km = haversineKm(hit.lat, hit.lon, refLat, refLon);
      score += Math.max(0, 30 - km);
    }

    if ((kind === 'street' || kind === 'district') && inOblast) {
      const cityKm = haversineKm(hit.lat, hit.lon, 49.9935, 36.2304);
      if (cityKm > 25) continue;
      score += Math.max(0, 15 - cityKm / 2);
    }

    ranked.push({
      lat: hit.lat,
      lon: hit.lon,
      displayName: hit.name || hit.displayName,
      inOblast,
      kind: derivedKind,
      score,
      nameMatch,
    });
  }

  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

export function pickBestGeocode(
  query: string,
  kind: PlaceKind,
  hits: RawGeocodeHit[],
  opts?: { hint?: GeocodeHint | null; preferInOblast?: boolean },
): RankedGeocodeHit | null {
  const ranked = rankGeocodeHits(query, kind, hits, { hint: opts?.hint, requireNameMatch: true });
  if (!ranked.length) return null;
  if (opts?.preferInOblast !== false) {
    const local = ranked.find((h) => h.inOblast);
    if (local) return local;
  }
  return ranked[0] ?? null;
}
