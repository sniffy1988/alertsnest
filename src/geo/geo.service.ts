import { Injectable } from '@nestjs/common';
import { KHARKIV_CENTER, type PlaceKind } from './ua-gazetteer';
import { ToponymService, type MemoryToponym } from './toponym.service';
import {
  foldUa,
  inKharkivOblast,
  isPlausiblePlaceLabel,
  isVagueOblastName,
  mentionedIn,
} from './place-match';
import { isThreatLabel } from '../llm/threat-slang';

export type ResolvedPlace = {
  name: string;
  lat: number;
  lon: number;
  code: string;
  matchType: PlaceKind;
};

export type ThreatPlaceResolve = {
  places: ResolvedPlace[];
  foreign: string[];
  unknown: string[];
};

export type LlmLocationInput = {
  name: string;
  kind: PlaceKind;
};

const CITY_RADIUS_KM = 22;
const DEFAULT_USER_RADIUS_KM = 40;
const MIN_USER_RADIUS_KM = 5;
const MAX_USER_RADIUS_KM = 150;

@Injectable()
export class GeoService {
  constructor(private readonly toponyms: ToponymService) {}

  haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const toRad = (n: number) => (n * Math.PI) / 180;
    const r = 6371;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * r * Math.asin(Math.sqrt(a));
  }

  isInKharkiv(lat: number, lon: number): boolean {
    return this.haversineKm(lat, lon, KHARKIV_CENTER.lat, KHARKIV_CENTER.lon) <= CITY_RADIUS_KM;
  }

  resolveUserArea(lat: number, lon: number): { oblastCode: string; label: string } {
    if (!inKharkivOblast(lat, lon)) {
      return { oblastCode: 'outside', label: 'поза Харківською областю' };
    }
    if (this.isInKharkiv(lat, lon)) {
      const street = this.nearestOfKind(lat, lon, 'street');
      const district = this.nearestOfKind(lat, lon, 'district');
      return {
        oblastCode: district?.norm ?? street?.norm ?? 'kharkiv',
        label: [street?.name, district?.name].filter(Boolean).join(', ') || 'Харків',
      };
    }
    const settlement = this.nearestOfKind(lat, lon, 'settlement');
    const region = this.nearestOfKind(lat, lon, 'region');
    return {
      oblastCode: settlement?.norm ?? region?.norm ?? 'oblast',
      label: settlement?.name ?? region?.name ?? 'Харківська область',
    };
  }

  userRadiusKm(radiusKm?: number | null): number {
    const raw = Number.isFinite(radiusKm) ? Number(radiusKm) : DEFAULT_USER_RADIUS_KM;
    return Math.min(MAX_USER_RADIUS_KM, Math.max(MIN_USER_RADIUS_KM, raw));
  }

  /** Resolve only LLM-provided location names (no full-text gazetteer scan). */
  async resolveThreatPlaces(input: {
    text: string;
    locations: LlmLocationInput[];
  }): Promise<ThreatPlaceResolve> {
    const foreign: string[] = [];
    const unknown: string[] = [];
    const unique = new Map<string, ResolvedPlace>();

    for (const loc of input.locations) {
      const name = loc.name.trim();
      if (name.length < 2 || isVagueOblastName(name) || isThreatLabel(name)) continue;
      if (!isPlausiblePlaceLabel(name)) continue;
      if (!this.isGrounded(input.text, name, loc.kind)) continue;

      const lookedUp = this.toponyms.lookup(name, loc.kind);
      if (lookedUp) {
        unique.set(lookedUp.norm, this.toResolved(lookedUp));
        continue;
      }

      const hint =
        this.toponyms.lookup('Харків', 'city') ?? this.toponyms.lookup('Харків');
      const [learned] = await this.toponyms.learn([name], hint, loc.kind);
      if (!learned) {
        if (isPlausiblePlaceLabel(name)) unknown.push(name);
        continue;
      }
      if (learned.status === 'local') unique.set(learned.place.norm, this.toResolved(learned.place));
      else if (learned.status === 'foreign') foreign.push(learned.label);
      else if (isPlausiblePlaceLabel(learned.label) && !isThreatLabel(learned.label)) {
        unknown.push(learned.label);
      }
    }

    return {
      places: [...unique.values()],
      foreign: [...new Set(foreign)],
      unknown: [...new Set(unknown)],
    };
  }

  async resolveAndLearn(
    locations: Array<{ name: string; kind?: PlaceKind | null }>,
  ): Promise<ResolvedPlace[]> {
    const resolved = await this.resolveThreatPlaces({
      text: locations.map((l) => l.name).join(' '),
      locations: locations.map((l) => ({
        name: l.name,
        kind: l.kind ?? 'settlement',
      })),
    });
    return resolved.places;
  }

  labelForCode(code: string | null | undefined): string {
    if (!code) return 'Харків';
    return this.toponyms.lookup(code)?.name ?? code;
  }

  findPlace(raw: string, kind?: PlaceKind | null) {
    return this.toponyms.lookup(raw, kind);
  }

  nearestDistrictNorm(lat: number, lon: number): string | null {
    return this.nearestOfKind(lat, lon, 'district')?.norm ?? null;
  }

  /** City default (Харків) may be injected by LLM without appearing in text. */
  private isGrounded(text: string, name: string, kind: PlaceKind): boolean {
    if (kind === 'city' && /^(харків|харьков|kharkiv|kharkov)$/i.test(foldUa(name))) {
      return true;
    }
    return mentionedIn(text, name);
  }

  private nearestOfKind(lat: number, lon: number, kind: PlaceKind) {
    let best: { name: string; norm: string } | null = null;
    let bestKm = Infinity;
    for (const place of this.toponyms.all()) {
      if (place.kind !== kind) continue;
      const km = this.haversineKm(lat, lon, place.lat, place.lon);
      if (km < bestKm) {
        bestKm = km;
        best = place;
      }
    }
    return best;
  }

  private toResolved(item: MemoryToponym): ResolvedPlace {
    return {
      name: item.name,
      lat: item.lat,
      lon: item.lon,
      code: item.norm,
      matchType: item.kind,
    };
  }

  matchUser(
    user: { lat: number | null; lon: number | null; oblastCode: string | null; radiusKm?: number | null },
    places: ResolvedPlace[],
    opts?: { cityWide?: boolean },
  ): { ok: boolean; km?: number; place?: ResolvedPlace; radiusKm?: number } {
    if (user.lat != null && user.lon != null) {
      if (!inKharkivOblast(user.lat, user.lon)) return { ok: false };
    } else if (user.oblastCode === 'outside') {
      return { ok: false };
    }

    const lat = user.lat ?? KHARKIV_CENTER.lat;
    const lon = user.lon ?? KHARKIV_CENTER.lon;
    const radiusKm = this.userRadiusKm(user.radiusKm);

    if (opts?.cityWide) {
      const km = this.haversineKm(lat, lon, KHARKIV_CENTER.lat, KHARKIV_CENTER.lon);
      const inCity = this.isInKharkiv(lat, lon);
      return {
        ok: inCity || km <= radiusKm,
        km,
        radiusKm,
        place: places.find((p) => p.matchType === 'city') ?? {
          name: 'Харків',
          lat: KHARKIV_CENTER.lat,
          lon: KHARKIV_CENTER.lon,
          code: 'харків',
          matchType: 'city',
        },
      };
    }

    if (places.length === 0) return { ok: false, radiusKm };

    let best: { km: number; place: ResolvedPlace } | null = null;
    for (const place of places) {
      const km = this.haversineKm(lat, lon, place.lat, place.lon);
      if (!best || km < best.km) best = { km, place };
    }
    if (!best) return { ok: false, radiusKm };

    if (best.km <= radiusKm) {
      return { ok: true, km: best.km, place: best.place, radiusKm };
    }
    return { ok: false, km: best.km, place: best.place, radiusKm };
  }
}
