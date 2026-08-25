import { Injectable } from '@nestjs/common';
import { KHARKIV_CENTER, type PlaceKind } from './ua-gazetteer';
import { ToponymService, type MemoryToponym } from './toponym.service';
import {
  detectOblastRegion,
  dropStreetShadows,
  findOutsideCities,
  foldUa,
  isCityWideKharkivCue,
  isPlausiblePlaceLabel,
  isVagueOblastName,
  mentionedIn,
  mentionsAdminRaion,
  queryLooksLikeStreet,
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

const CITY_RADIUS_KM = 22;
const NEARBY_KM: Record<PlaceKind, number> = {
  street: 1.2,
  district: 2,
  city: 8,
  settlement: 3,
  region: 4,
};

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
    if (!this.isInKharkiv(lat, lon)) {
      return { oblastCode: 'outside', label: 'поза Харковом' };
    }
    const street = this.nearestOfKind(lat, lon, 'street');
    const district = this.nearestOfKind(lat, lon, 'district');
    return {
      oblastCode: district?.norm ?? street?.norm ?? 'kharkiv',
      label: [street?.name, district?.name].filter(Boolean).join(', ') || 'Харків',
    };
  }

  async resolveThreatPlaces(input: {
    text: string;
    llmPlaces: string[];
    oblast?: string | null;
    geoScope?: string | null;
  }): Promise<ThreatPlaceResolve> {
    const region = detectOblastRegion(input.text);
    const raionOnly = mentionsAdminRaion(input.text);
    const llmPlaces = input.llmPlaces.filter(
      (name) => isPlausiblePlaceLabel(name) && !isThreatLabel(name),
    );
    const fromText = dropStreetShadows(
      this.toponyms.findInText(input.text).filter((p) => !raionOnly || p.kind !== 'street'),
      input.text,
    );
    const groundedLlm = llmPlaces.filter(
      (name) => !isVagueOblastName(name) && mentionedIn(input.text, name),
    );
    const lookedUp = dropStreetShadows(
      llmPlaces
        .filter((name) => !isVagueOblastName(name))
        .map((name) => this.toponyms.lookup(name))
        .filter((hit): hit is NonNullable<typeof hit> => hit != null && mentionedIn(input.text, hit.name))
        .filter((hit) => !raionOnly || hit.kind !== 'street'),
      input.text,
    );

    const foreign = findOutsideCities(input.text, llmPlaces);
    const names: string[] = [];
    names.push(...fromText.map((p) => p.name));
    names.push(...lookedUp.map((p) => p.name));
    names.push(
      ...groundedLlm.filter(
        (name) =>
          isPlausiblePlaceLabel(name) &&
          !isThreatLabel(name) &&
          !this.toponyms.lookup(name) &&
          !findOutsideCities(name).length,
      ),
    );
    if (region) names.unshift(region.name);
    if (input.oblast && !isVagueOblastName(input.oblast) && mentionedIn(input.text, input.oblast)) {
      names.push(input.oblast);
    }

    const uniqueNames = [
      ...new Set(
        names
          .map((n) => n.trim())
          .filter((n) => n.length >= 3 && isPlausiblePlaceLabel(n) && !isThreatLabel(n)),
      ),
    ];
    const known = uniqueNames
      .map((name) => this.toponyms.lookup(name))
      .filter((hit): hit is NonNullable<typeof hit> => hit != null);
    const hint =
      known.find((p) => p.kind === 'settlement' || p.kind === 'region' || p.kind === 'district') ??
      known[0] ??
      this.toponyms.lookup('Харків');
    const learned = uniqueNames.length ? await this.toponyms.learn(uniqueNames, hint) : [];
    const unique = new Map<number, ResolvedPlace>();
    const unknown: string[] = [];
    for (const item of learned) {
      if (item.status === 'local') unique.set(item.place.id, this.toResolved(item.place));
      else if (item.status === 'foreign') foreign.push(item.label);
      else if (isPlausiblePlaceLabel(item.label) && !isThreatLabel(item.label)) unknown.push(item.label);
    }
    if (region && ![...unique.values()].some((p) => p.code === region.code || p.matchType === 'region')) {
      unique.set(-1, {
        name: region.name,
        lat: region.lat,
        lon: region.lon,
        code: region.code,
        matchType: 'region',
      });
    }

    let places = dropStreetShadows([...unique.values()], input.text);
    places = this.dropCityAdjectiveStreets(places, input.text);

    const cityPlacesInText = fromText.some((p) => p.kind === 'street' || p.kind === 'district');
    const precise = places.filter((p) => p.matchType !== 'city');
    if (precise.length) places = precise;
    if (!cityPlacesInText && (input.geoScope === 'oblast' || input.geoScope === 'suburb' || region)) {
      const outer = places.filter((p) => p.matchType === 'settlement' || p.matchType === 'region');
      if (outer.length) places = outer;
    }

    const cityWide =
      isCityWideKharkivCue(input.text) ||
      (input.geoScope === 'city' && /харк|харьков|kharkiv/i.test(foldUa(input.text)));

    if (!places.length && cityWide) {
      const city = this.toponyms.lookup('Харків');
      if (city) places = [this.toResolved(city)];
    }

    return {
      places,
      foreign: [...new Set(foreign)],
      unknown: [...new Set(unknown)],
    };
  }

  /** «Харківська вулиця» from geocoding «Харківська» — not a real street mention. */
  private dropCityAdjectiveStreets(places: ResolvedPlace[], text: string): ResolvedPlace[] {
    if (queryLooksLikeStreet(text)) return places;
    return places.filter((place) => {
      if (place.matchType !== 'street') return true;
      const n = foldUa(place.name);
      return !/^(вул\.?\s*)?(харківськ|харьковск)/.test(n);
    });
  }

  async resolveAndLearn(names: string[], oblast?: string | null): Promise<ResolvedPlace[]> {
    const resolved = await this.resolveThreatPlaces({ text: names.join(' '), llmPlaces: names, oblast });
    return resolved.places;
  }

  labelForCode(code: string | null | undefined): string {
    if (!code) return 'Харків';
    return this.toponyms.lookup(code)?.name ?? code;
  }

  findPlace(raw: string) {
    return this.toponyms.lookup(raw);
  }

  nearestDistrictNorm(lat: number, lon: number): string | null {
    return this.nearestOfKind(lat, lon, 'district')?.norm ?? null;
  }

  private nearestOfKind(lat: number, lon: number, kind: 'street' | 'district') {
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
    user: { lat: number | null; lon: number | null; oblastCode: string | null },
    places: ResolvedPlace[],
    opts?: { cityWide?: boolean },
  ): { ok: boolean; km?: number; place?: ResolvedPlace } {
    if (user.lat != null && user.lon != null && !this.isInKharkiv(user.lat, user.lon)) {
      return { ok: false };
    }
    if (user.oblastCode === 'outside') return { ok: false };

    const lat = user.lat ?? KHARKIV_CENTER.lat;
    const lon = user.lon ?? KHARKIV_CENTER.lon;

    if (opts?.cityWide) {
      return {
        ok: true,
        km: this.haversineKm(lat, lon, KHARKIV_CENTER.lat, KHARKIV_CENTER.lon),
        place: places.find((p) => p.matchType === 'city') ?? {
          name: 'Харків',
          lat: KHARKIV_CENTER.lat,
          lon: KHARKIV_CENTER.lon,
          code: 'харків',
          matchType: 'city',
        },
      };
    }

    if (places.length === 0) return { ok: false };

    let best: { km: number; place: ResolvedPlace } | null = null;
    for (const place of places) {
      const km = this.haversineKm(lat, lon, place.lat, place.lon);
      if (!best || km < best.km) best = { km, place };
    }
    if (!best) return { ok: false };

    const limit = NEARBY_KM[best.place.matchType] ?? 4;
    if (best.km <= limit) {
      return { ok: true, km: best.km, place: best.place };
    }
    return { ok: false, km: best.km, place: best.place };
  }
}
