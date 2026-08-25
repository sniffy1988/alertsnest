import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import { normalize } from '../common/text';
import { GAZETTEER, KHARKIV_CENTER, type PlaceKind } from './ua-gazetteer';
import {
  kindFromOsmTags,
  pickBestGeocode,
  type GeocodeHint,
  type RawGeocodeHit,
} from './geocode-rank';
import {
  dropStreetShadows,
  expandAliases,
  expandPlaceSlang,
  foldPlaceText,
  foldUa,
  inKharkivOblast,
  isPlausiblePlaceLabel,
  looksLikeSettlement,
  mentionsAdminRaion,
  namesEqual,
  nominativeGuesses,
  OBLAST_BBOX,
  placeForms,
  placeStem,
  placeVariants,
  queryLooksLikeStreet,
  registerPlaceSlang,
  tokenRefersToName,
} from './place-match';
import { isThreatLabel } from '../llm/threat-slang';

export type ToponymKind = PlaceKind;

export type MemoryToponym = {
  id: number;
  name: string;
  norm: string;
  aliases: string[];
  lat: number;
  lon: number;
  kind: ToponymKind;
  source: string;
};

export type LearnResult =
  | { status: 'local'; place: MemoryToponym }
  | { status: 'foreign'; label: string }
  | { status: 'unknown'; label: string };

const OVERPASS_URLS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];
const OVERPASS_CITY_QUERY = `
[out:json][timeout:60];
(
  way["highway"]["name"](49.89,36.05,50.12,36.45);
  node["place"~"suburb|neighbourhood|quarter"]["name"](49.89,36.05,50.12,36.45);
);
out center tags;
`.trim();

/** Split oblast bbox into tiles — full-area / ISO3166 area queries often 504 on public mirrors. */
function oblastSettlementQueries(): string[] {
  const { minLat, maxLat, minLon, maxLon } = OBLAST_BBOX;
  const midLat = (minLat + maxLat) / 2;
  const midLon = (minLon + maxLon) / 2;
  const tiles: Array<[number, number, number, number]> = [
    [minLat, minLon, midLat, midLon],
    [minLat, midLon, midLat, maxLon],
    [midLat, minLon, maxLat, midLon],
    [midLat, midLon, maxLat, maxLon],
  ];
  return tiles.map(
    ([s, w, n, e]) =>
      `
[out:json][timeout:45];
node["place"~"town|village|hamlet|isolated_dwelling"]["name"](${s},${w},${n},${e});
out tags;
`.trim(),
  );
}

type NominatimHit = {
  lat: string;
  lon: string;
  name?: string;
  display_name?: string;
  class?: string;
  type?: string;
  addresstype?: string;
  importance?: number;
  address?: RawGeocodeHit['address'];
};

type GeocodeResult = {
  lat: number;
  lon: number;
  displayName?: string;
  inOblast: boolean;
  kind: ToponymKind;
};

@Injectable()
export class ToponymService implements OnModuleInit {
  private readonly logger = new Logger(ToponymService.name);
  private items: MemoryToponym[] = [];
  private byNorm = new Map<string, MemoryToponym>();
  private lastGeocodeAt = 0;
  private readonly geocodeCache = new Map<string, GeocodeResult | 'miss'>();

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.dropBadLearned();
    await this.ensureSeed();
    await this.refreshMemory();
    await this.sweepResolvedUnknowns();
    await this.ensureOsmImports();
    this.logger.log(`Toponym dictionary ready: ${this.items.length}`);
  }

  all(): MemoryToponym[] {
    return this.items;
  }

  lookup(raw: string, preferredKind?: ToponymKind | null): MemoryToponym | null {
    const key = normalize(raw);
    if (!key) return null;
    for (const variant of placeVariants(raw)) {
      const exact = this.byNorm.get(variant) ?? this.byNorm.get(normalize(variant)) ?? this.byNorm.get(foldUa(variant));
      if (!exact) continue;
      if (preferredKind) {
        const sameKind = this.items.find(
          (item) =>
            item.kind === preferredKind &&
            (namesEqual(raw, item.name) ||
              namesEqual(raw, item.norm) ||
              item.aliases.some((a) => namesEqual(raw, a))),
        );
        if (sameKind) return sameKind;
        if (exact.kind === preferredKind) return exact;
        continue;
      }
      if (exact.kind !== 'street' || queryLooksLikeStreet(raw)) return exact;
      const outer = this.items.find(
        (item) =>
          (item.kind === 'settlement' || item.kind === 'region') && namesEqual(raw, item.name),
      );
      return outer ?? exact;
    }

    const queryStem = placeStem(raw);
    if (queryStem.length < 5) return null;

    const scored = (wantKind: ToponymKind | null | undefined): MemoryToponym | null => {
      const wantStreet = wantKind === 'street' || queryLooksLikeStreet(raw);
      const wantCity =
        wantKind === 'city' || /^(харків|харьков|kharkiv|kharkov)$/.test(foldUa(raw));
      let best: MemoryToponym | null = null;
      let bestScore = -1;
      for (const item of this.items) {
        if (wantKind && item.kind !== wantKind) continue;
        if (wantCity && item.kind !== 'city') continue;
        const labels = [item.name, item.norm, ...item.aliases];
        for (const label of labels) {
          const exactFold = foldUa(label) === foldUa(raw);
          const refers = tokenRefersToName(raw, label) || tokenRefersToName(raw, item.name);
          if (!exactFold && !refers) continue;
          const kindBoost = wantKind
            ? item.kind === wantKind
              ? 8
              : 0
            : wantStreet
              ? item.kind === 'street'
                ? 4
                : 0
              : wantCity
                ? item.kind === 'city'
                  ? 8
                  : 0
                : item.kind === 'settlement' || item.kind === 'region'
                  ? 4
                  : item.kind === 'street'
                    ? 0
                    : 1;
          const score = (exactFold ? 100 : 50) + kindBoost + Math.min(foldUa(label).length, 30) / 100;
          if (score > bestScore) {
            best = item;
            bestScore = score;
          }
        }
      }
      return best;
    };

    return scored(preferredKind) ?? (preferredKind ? scored(null) : null);
  }

  findInText(text: string): MemoryToponym[] {
    const folded = foldPlaceText(text);
    if (!folded) return [];
    const slang = expandPlaceSlang(text);
    const withSt = folded.replace(/(^|\s)ст\s+/g, '$1старий ');
    const haystacks = [...new Set([folded, slang, withSt])];
    const tokens = folded.split(' ').filter(Boolean);
    const hits = new Map<number, MemoryToponym>();
    const scored: Array<{ item: MemoryToponym; len: number }> = [];
    const raionOnly = mentionsAdminRaion(text);

    for (const item of this.items) {
      if (raionOnly && item.kind === 'street') continue;
      const labels = [item.name, item.norm, ...item.aliases];
      for (const label of labels) {
        const phrase = foldUa(label);
        const phraseHit = haystacks.some((hay) => phrase.includes(' ') && ` ${hay} `.includes(` ${phrase} `));
        if (phraseHit) {
          scored.push({ item, len: phrase.length });
          break;
        }
        if (phrase.length >= 2 && phrase.length <= 3 && tokens.includes(phrase)) {
          scored.push({ item, len: phrase.length });
          break;
        }
        const stem = placeStem(label);
        if (stem.length < 4) continue;
        const ok = tokens.some((token) => {
          const ft = foldUa(token);
          // Bare "Харків" must not stem-match Харківський район / Харківська вулиця.
          if (
            /^(харків|харьков|kharkiv|kharkov|харкову|харькову|харкова|харькова|харкові|харькове)$/.test(ft)
          ) {
            return item.kind === 'city';
          }
          if (item.kind === 'city') {
            return false;
          }
          return tokenRefersToName(token, label) || tokenRefersToName(token, item.name);
        });
        if (!ok) continue;
        scored.push({ item, len: foldUa(label).length });
        break;
      }
    }

    scored.sort((a, b) => b.len - a.len);
    for (const row of scored) {
      const longer = [...hits.values()].some(
        (existing) =>
          foldUa(existing.name).includes(foldUa(row.item.name)) ||
          foldUa(existing.norm).includes(foldUa(row.item.norm)),
      );
      if (longer) continue;
      hits.set(row.item.id, row.item);
    }
    return dropStreetShadows([...hits.values()], text);
  }

  async explain(
    alias: string,
    meaning: string,
  ): Promise<
    | { ok: true; place: string; lat: number; lon: number; learned: boolean }
    | { ok: false; reason: 'bad' | 'unknown_target' | 'foreign' }
  > {
    const rawAlias = alias.trim();
    const rawMeaning = meaning.trim();
    if (rawAlias.length < 2 || rawMeaning.length < 2) return { ok: false, reason: 'bad' };
    let target = this.lookup(rawMeaning);
    let learned = false;
    if (!target) {
      const [result] = await this.learn([rawMeaning]);
      if (result?.status === 'foreign') return { ok: false, reason: 'foreign' };
      if (result?.status !== 'local') return { ok: false, reason: 'unknown_target' };
      target = result.place;
      learned = true;
    }
    await this.addAlias(target, rawAlias);
    if (foldUa(rawAlias) !== foldUa(rawMeaning)) await this.addAlias(target, rawMeaning);
    await this.sweepUnknowns(rawAlias);
    await this.sweepUnknowns(rawMeaning);
    this.logger.log(`taught alias "${rawAlias}" → ${target.name}${learned ? ' (geocoded)' : ''}`);
    return { ok: true, place: target.name, lat: target.lat, lon: target.lon, learned };
  }

  async rememberUnknown(input: {
    labels: string[];
    sampleText: string;
    channel: string;
  }): Promise<{ created: Array<{ id: number; label: string }> }> {
    const created: Array<{ id: number; label: string }> = [];
    const labels = input.labels
      .map((s) => s.trim())
      .filter((s) => s.length >= 2 && isPlausiblePlaceLabel(s) && !isThreatLabel(s));
    if (!labels.length) return { created };
    const seenNorm = new Set<string>();
    for (const label of labels) {
      if (this.lookup(label)) continue;
      const norm = this.unknownNorm(label);
      if (!norm || this.lookup(norm) || seenNorm.has(norm)) continue;
      seenNorm.add(norm);
      const existing = await this.prisma.unknownToponym.findUnique({ where: { norm } });
      if (existing) {
        await this.prisma.unknownToponym.update({
          where: { id: existing.id },
          data: {
            hitCount: { increment: 1 },
            lastSeenAt: new Date(),
            sampleText: input.sampleText.slice(0, 400),
            channel: input.channel,
          },
        });
        continue;
      }
      const row = await this.prisma.unknownToponym.create({
        data: {
          label,
          norm,
          sampleText: input.sampleText.slice(0, 400),
          channel: input.channel,
        },
      });
      created.push({ id: row.id, label });
    }
    return { created };
  }

  listUnknown(limit = 25) {
    return this.prisma.unknownToponym.findMany({
      orderBy: [{ hitCount: 'desc' }, { lastSeenAt: 'desc' }],
      take: limit,
    });
  }

  async dismissUnknown(idOrLabel: string): Promise<boolean> {
    const id = Number(idOrLabel);
    if (Number.isInteger(id) && id > 0) {
      try {
        await this.prisma.unknownToponym.delete({ where: { id } });
        return true;
      } catch {
        return false;
      }
    }
    const norm = foldUa(idOrLabel);
    const res = await this.prisma.unknownToponym.deleteMany({
      where: { OR: [{ norm }, { label: idOrLabel.trim() }] },
    });
    return res.count > 0;
  }

  private unknownNorm(label: string): string {
    const stem = placeStem(label);
    return stem.length >= 4 ? stem : foldUa(label);
  }

  private async sweepUnknowns(alias: string): Promise<void> {
    const norms = [...new Set([this.unknownNorm(alias), foldUa(alias), normalize(alias)].filter(Boolean))];
    if (norms.length) {
      await this.prisma.unknownToponym.deleteMany({ where: { norm: { in: norms } } });
    }
    await this.sweepResolvedUnknowns();
  }

  private async sweepResolvedUnknowns(): Promise<void> {
    const leftover = await this.prisma.unknownToponym.findMany();
    for (const row of leftover) {
      if (this.lookup(row.label) || this.lookup(row.norm)) {
        await this.prisma.unknownToponym.delete({ where: { id: row.id } }).catch(() => undefined);
      }
    }
  }

  private async addAlias(item: MemoryToponym, seenAs: string): Promise<void> {
    const extras = expandAliases(seenAs, [normalize(seenAs), foldUa(seenAs), seenAs.trim().toLowerCase()], 24);
    const aliases = new Set(item.aliases);
    for (const extra of extras) aliases.add(extra);
    item.aliases = [...aliases];
    for (const extra of extras) {
      this.byNorm.set(extra, item);
      const folded = foldUa(extra);
      if (folded) this.byNorm.set(folded, item);
      registerPlaceSlang(extra, item.name);
    }
    await this.prisma.toponym.update({
      where: { id: item.id },
      data: { aliases: JSON.stringify(item.aliases) },
    });
  }

  resolveNames(names: string[]): MemoryToponym[] {
    const found = new Map<number, MemoryToponym>();
    for (const name of names) {
      const hit = this.lookup(name);
      if (hit) found.set(hit.id, hit);
    }
    return [...found.values()];
  }

  async learn(
    names: string[],
    hint?: MemoryToponym | GeocodeHint | null,
    preferredKind?: ToponymKind | null,
  ): Promise<LearnResult[]> {
    const resolved: LearnResult[] = [];
    const focus = this.toHint(hint);
    for (const raw of names) {
      const name = raw.trim();
      if (name.length < 3) continue;
      if (!isPlausiblePlaceLabel(name) || isThreatLabel(name)) {
        this.logger.log(`Skip learn "${name}": not a place label`);
        continue;
      }
      const existing = this.lookup(name, preferredKind);
      if (existing) {
        await this.touch(existing, name);
        const fresh = this.byNorm.get(existing.norm) ?? existing;
        resolved.push({ status: 'local', place: fresh });
        continue;
      }
      resolved.push(await this.insertLearned(name, focus, preferredKind));
    }
    return resolved;
  }

  private toHint(hint?: MemoryToponym | GeocodeHint | null): GeocodeHint | null {
    if (!hint) return null;
    if (!Number.isFinite(hint.lat) || !Number.isFinite(hint.lon)) return null;
    return { lat: hint.lat, lon: hint.lon };
  }

  private async insertLearned(
    name: string,
    hint?: GeocodeHint | null,
    preferredKind?: ToponymKind | null,
  ): Promise<LearnResult> {
    const guessedKind = preferredKind ?? this.guessKind(name);
    const geo = await this.geocode(name, guessedKind, hint);
    if (!geo) {
      this.logger.log(`Skip learn "${name}" (${guessedKind}): no coordinates`);
      return { status: 'unknown', label: name };
    }
    if (!geo.inOblast) {
      this.logger.log(`Skip learn "${name}": outside oblast ${geo.lat.toFixed(4)},${geo.lon.toFixed(4)}`);
      return { status: 'foreign', label: geo.displayName ?? name };
    }
    const kind = preferredKind ?? geo.kind ?? guessedKind;
    const official = geo.displayName?.split(',')[0]?.trim() || name;
    const aliases = expandAliases(official, [normalize(name), foldUa(name), normalize(official)], 48);
    const row = await this.prisma.toponym.create({
      data: {
        name: official,
        norm: normalize(official),
        aliases: JSON.stringify(aliases),
        lat: geo.lat,
        lon: geo.lon,
        kind,
        source: 'nominatim',
        hitCount: 1,
      },
    });
    const mem = this.toMemory(row);
    this.index(mem);
    await this.sweepUnknowns(name);
    this.logger.log(`Learned toponym "${official}" from "${name}" (${kind}) ${geo.lat.toFixed(4)},${geo.lon.toFixed(4)}`);
    return { status: 'local', place: mem };
  }

  private async touch(item: MemoryToponym, seenAs: string): Promise<void> {
    const alias = normalize(seenAs);
    const aliases = new Set(item.aliases);
    aliases.add(alias);
    item.aliases = [...aliases];
    this.byNorm.set(alias, item);
    await this.prisma.toponym.update({
      where: { id: item.id },
      data: {
        hitCount: { increment: 1 },
        aliases: JSON.stringify(item.aliases),
      },
    });
  }

  private guessKind(name: string): ToponymKind {
    const n = foldUa(name);
    if (n === 'харків' || n === 'харьков') return 'city';
    if (/(област|пригород|околиц|передміст)/.test(n)) return 'region';
    if (looksLikeSettlement(name)) return 'settlement';
    if (n.includes('район') || n.includes('салтів') || n.includes('олексі') || n.includes('хтз')) {
      return 'district';
    }
    if (n.includes('вул') || n.includes('просп') || n.includes('майдан') || n.includes('шосе')) {
      return 'street';
    }
    return 'settlement';
  }

  private async dropBadLearned(): Promise<void> {
    const bad = await this.prisma.toponym.deleteMany({
      where: { source: 'llm' },
    });
    if (bad.count) this.logger.log(`Dropped ${bad.count} learned toponyms with guessed coords`);
  }

  private async geocode(
    name: string,
    kind: ToponymKind,
    hint?: GeocodeHint | null,
  ): Promise<GeocodeResult | null> {
    const cacheKey = `${kind}:${foldUa(name)}:${hint ? `${hint.lat.toFixed(2)},${hint.lon.toFixed(2)}` : '-'}`;
    const cached = this.geocodeCache.get(cacheKey);
    if (cached === 'miss') return null;
    if (cached) return cached;

    const queries = nominativeGuesses(name);
    let foreign: GeocodeResult | null = null;

    for (const query of queries) {
      const local = await this.nominatimSearch(query, kind, true, hint);
      if (local?.inOblast) {
        this.geocodeCache.set(cacheKey, local);
        return local;
      }
      if (local && !foreign) foreign = local;
    }
    for (const query of queries) {
      const anywhere = await this.nominatimSearch(query, kind, false, hint);
      if (!anywhere) continue;
      if (anywhere.inOblast) {
        this.geocodeCache.set(cacheKey, anywhere);
        return anywhere;
      }
      foreign = anywhere;
    }

    for (const query of queries) {
      const photon = await this.photonSearch(query, kind, hint);
      if (!photon) continue;
      if (photon.inOblast) {
        this.geocodeCache.set(cacheKey, photon);
        return photon;
      }
      if (!foreign) foreign = photon;
    }

    if (foreign) {
      this.geocodeCache.set(cacheKey, foreign);
      return foreign;
    }
    this.geocodeCache.set(cacheKey, 'miss');
    return null;
  }

  private async throttleGeocode(): Promise<void> {
    const wait = 1100 - (Date.now() - this.lastGeocodeAt);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastGeocodeAt = Date.now();
  }

  private toRawHits(rows: NominatimHit[]): RawGeocodeHit[] {
    const out: RawGeocodeHit[] = [];
    for (const hit of rows) {
      const lat = Number(hit.lat);
      const lon = Number(hit.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      out.push({
        lat,
        lon,
        name: hit.name,
        displayName: hit.display_name,
        class: hit.class,
        type: hit.type,
        addresstype: hit.addresstype,
        importance: hit.importance,
        address: hit.address,
      });
    }
    return out;
  }

  private async nominatimSearch(
    name: string,
    kind: ToponymKind,
    bounded: boolean,
    hint?: GeocodeHint | null,
  ): Promise<GeocodeResult | null> {
    await this.throttleGeocode();

    const viewbox = `${OBLAST_BBOX.minLon},${OBLAST_BBOX.maxLat},${OBLAST_BBOX.maxLon},${OBLAST_BBOX.minLat}`;
    const common = {
      format: 'jsonv2',
      limit: 10,
      addressdetails: 1,
      countrycodes: 'ua',
      viewbox,
      bounded: bounded ? 1 : 0,
    };

    const attempts: Record<string, string | number>[] = [];
    if (kind === 'street') {
      attempts.push({ ...common, street: name, city: 'Харків' });
      attempts.push({ ...common, q: `${name} Харків Україна` });
    } else if (kind === 'district') {
      attempts.push({ ...common, city: name, state: 'Харківська область' });
      attempts.push({ ...common, q: `${name} Харків Україна` });
    } else if (kind === 'settlement' || kind === 'city') {
      attempts.push({
        ...common,
        city: name,
        state: 'Харківська область',
        featureType: 'settlement',
      });
      attempts.push({
        ...common,
        q: `${name} Харківська область Україна`,
        featureType: 'settlement',
      });
    } else {
      attempts.push({
        ...common,
        q: bounded ? `${name} Харківська область Україна` : `${name} Україна`,
      });
    }

    try {
      for (const params of attempts) {
        const response = await axios.get<NominatimHit[]>('https://nominatim.openstreetmap.org/search', {
          timeout: 12_000,
          params,
          headers: {
            'User-Agent': 'alertsNest/1.0 (kharkiv-alerts)',
            Accept: 'application/json',
            'Accept-Language': 'uk',
          },
        });
        const best = pickBestGeocode(name, kind, this.toRawHits(response.data ?? []), {
          hint,
          preferInOblast: bounded,
        });
        if (best) {
          return {
            lat: best.lat,
            lon: best.lon,
            displayName: best.displayName,
            inOblast: best.inOblast,
            kind: best.kind,
          };
        }
        await this.throttleGeocode();
      }
      return null;
    } catch (err) {
      this.logger.warn(`Nominatim "${name}": ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  private async photonSearch(
    name: string,
    kind: ToponymKind,
    hint?: GeocodeHint | null,
  ): Promise<GeocodeResult | null> {
    await this.throttleGeocode();
    try {
      const response = await axios.get<{
        features?: Array<{
          geometry?: { coordinates?: number[] };
          properties?: {
            name?: string;
            city?: string;
            state?: string;
            country?: string;
            countrycode?: string;
            type?: string;
            osm_key?: string;
            osm_value?: string;
            extent?: number[];
          };
        }>;
      }>('https://photon.komoot.io/api/', {
        timeout: 12_000,
        params: {
          q: name,
          lang: 'uk',
          limit: 10,
          lat: hint?.lat ?? KHARKIV_CENTER.lat,
          lon: hint?.lon ?? KHARKIV_CENTER.lon,
          bbox: `${OBLAST_BBOX.minLon},${OBLAST_BBOX.minLat},${OBLAST_BBOX.maxLon},${OBLAST_BBOX.maxLat}`,
        },
        headers: { 'User-Agent': 'alertsNest/1.0 (kharkiv-alerts)', Accept: 'application/json' },
      });

      const hits: RawGeocodeHit[] = [];
      for (const feature of response.data.features ?? []) {
        const coords = feature.geometry?.coordinates;
        const props = feature.properties;
        if (!coords || coords.length < 2 || !props) continue;
        const lon = Number(coords[0]);
        const lat = Number(coords[1]);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        hits.push({
          lat,
          lon,
          name: props.name,
          displayName: [props.name, props.city, props.state, props.country].filter(Boolean).join(', '),
          class: props.osm_key,
          type: props.osm_value ?? props.type,
          addresstype: props.type,
          address: {
            state: props.state,
            city: props.city,
            country_code: props.countrycode,
          },
        });
      }

      const best = pickBestGeocode(name, kind, hits, { hint, preferInOblast: true });
      if (!best) return null;
      return {
        lat: best.lat,
        lon: best.lon,
        displayName: best.displayName,
        inOblast: best.inOblast,
        kind: best.kind,
      };
    } catch (err) {
      this.logger.warn(`Photon "${name}": ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  private async ensureSeed(): Promise<void> {
    for (const place of GAZETTEER) {
      const aliases = expandAliases(place.name, [normalize(place.name), ...place.aliases.map(normalize)], 48);
      const norm = normalize(place.name);
      const existing = await this.prisma.toponym.findUnique({ where: { norm } });
      if (existing) {
        const merged = expandAliases(place.name, [...this.parseAliases(existing.aliases), ...aliases], 64);
        await this.prisma.toponym.update({
          where: { id: existing.id },
          data: { aliases: JSON.stringify(merged), lat: place.lat, lon: place.lon, kind: place.kind },
        });
        continue;
      }
      await this.prisma.toponym.create({
        data: {
          name: place.name,
          norm,
          aliases: JSON.stringify(aliases),
          lat: place.lat,
          lon: place.lon,
          kind: place.kind,
          source: 'seed',
          hitCount: 0,
        },
      });
    }
  }

  private parseAliases(raw: string): string[] {
    try {
      return JSON.parse(raw) as string[];
    } catch {
      return [];
    }
  }

  private async ensureOsmImports(): Promise<void> {
    const osmCity = await this.prisma.toponym.count({
      where: { source: 'osm', kind: { in: ['street', 'district'] } },
    });
    const oblastDone = await this.prisma.toponym.findUnique({
      where: { norm: '__osm_oblast_done__' },
    });

    if (osmCity === 0) {
      try {
        const added = await this.importOsmElements(await this.fetchOverpass(OVERPASS_CITY_QUERY), 'city');
        this.logger.log(`OSM city import added ${added} toponyms`);
        await this.refreshMemory();
      } catch (err) {
        this.logger.warn(`OSM city import skipped: ${err instanceof Error ? err.message : err}`);
      }
    }

    if (!oblastDone) {
      // Heavy; don't block Nest boot if mirrors are slow — retry next restart on failure.
      void this.importOblastSettlements().catch((err) => {
        this.logger.warn(`OSM oblast import skipped: ${err instanceof Error ? err.message : err}`);
      });
    }
  }

  private async importOblastSettlements(): Promise<void> {
    const seen = new Set<string>();
    const merged: OsmElement[] = [];
    let tileErrors = 0;
    for (const query of oblastSettlementQueries()) {
      try {
        const elements = await this.fetchOverpass(query);
        for (const el of elements) {
          const key = `${el.type ?? 'n'}:${el.lat ?? el.center?.lat},${el.lon ?? el.center?.lon}:${el.tags?.name ?? ''}`;
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(el);
        }
      } catch (err) {
        tileErrors += 1;
        this.logger.warn(`OSM oblast tile failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (!merged.length) {
      throw new Error(tileErrors ? `all ${tileErrors} oblast tiles failed` : 'oblast overpass empty');
    }
    const added = await this.importOsmElements(merged, 'oblast');
    await this.prisma.toponym.upsert({
      where: { norm: '__osm_oblast_done__' },
      create: {
        name: '__osm_oblast_done__',
        norm: '__osm_oblast_done__',
        aliases: '[]',
        lat: KHARKIV_CENTER.lat,
        lon: KHARKIV_CENTER.lon,
        kind: 'region',
        source: 'osm_oblast',
        hitCount: 0,
      },
      update: {},
    });
    this.logger.log(`OSM oblast settlements import added ${added} toponyms (from ${merged.length} elements)`);
    await this.refreshMemory();
  }

  private async importOsmElements(elements: OsmElement[], scope: 'city' | 'oblast'): Promise<number> {
    this.logger.log(`OSM ${scope} overpass elements=${elements.length}`);
    let added = 0;
    const source = scope === 'oblast' ? 'osm_oblast' : 'osm';
    for (const el of elements) {
      const name = el.tags?.['name:uk'] || el.tags?.name;
      if (!name || name.startsWith('__')) continue;
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      if (lat == null || lon == null) continue;
      if (scope === 'oblast' && !inKharkivOblast(lat, lon)) continue;
      const kind = this.kindFromOsm(el);
      if (scope === 'oblast' && kind === 'street') continue;
      if (scope === 'city' && (kind === 'settlement' || kind === 'city')) continue;
      const norm = normalize(name);
      if (!norm || this.byNorm.has(norm)) continue;
      try {
        const aliases = [norm];
        if (el.tags?.['name:ru']) aliases.push(normalize(el.tags['name:ru']));
        if (el.tags?.['name:en']) aliases.push(normalize(el.tags['name:en']));
        const row = await this.prisma.toponym.create({
          data: {
            name,
            norm,
            aliases: JSON.stringify([...new Set(aliases.filter(Boolean))]),
            lat,
            lon,
            kind,
            source,
            hitCount: 0,
          },
        });
        this.index(this.toMemory(row));
        added += 1;
      } catch {
        // unique race / duplicate
      }
    }
    return added;
  }

  private async fetchOverpass(query: string): Promise<OsmElement[]> {
    let lastError: unknown;
    for (const url of OVERPASS_URLS) {
      try {
        const response = await axios.post(url, new URLSearchParams({ data: query }).toString(), {
          timeout: 55_000,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: '*/*',
            'User-Agent': 'alertsNest/1.0 (kharkiv-alerts)',
          },
          validateStatus: (status) => status >= 200 && status < 300,
        });
        const elements = (response.data as { elements?: OsmElement[] }).elements ?? [];
        if (elements.length) {
          this.logger.log(`OSM ok via ${url}: ${elements.length} elements`);
          return elements;
        }
        this.logger.warn(`OSM ${url} empty response`);
      } catch (err) {
        lastError = err;
        this.logger.warn(`OSM ${url} failed: ${err instanceof Error ? err.message : err}`);
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    throw lastError ?? new Error('Overpass failed');
  }

  private kindFromOsm(el: OsmElement): ToponymKind {
    return kindFromOsmTags(
      {
        class: el.tags?.highway ? 'highway' : 'place',
        type: el.tags?.place ?? el.tags?.highway,
        addresstype: el.tags?.place,
      },
      el.tags?.highway ? 'street' : 'settlement',
    );
  }

  private async refreshMemory(): Promise<void> {
    const rows = await this.prisma.toponym.findMany();
    this.items = [];
    this.byNorm.clear();
    for (const row of rows) this.index(this.toMemory(row));
  }

  private toMemory(row: {
    id: number;
    name: string;
    norm: string;
    aliases: string;
    lat: number;
    lon: number;
    kind: string;
    source: string;
  }): MemoryToponym {
    let aliases: string[] = [];
    try {
      aliases = JSON.parse(row.aliases) as string[];
    } catch {
      aliases = [row.norm];
    }
    return {
      id: row.id,
      name: row.name,
      norm: row.norm,
      aliases,
      lat: row.lat,
      lon: row.lon,
      kind: row.kind as ToponymKind,
      source: row.source,
    };
  }

  private index(item: MemoryToponym): void {
    if (item.name.startsWith('__') || item.norm.startsWith('__')) return;
    if (!this.items.some((x) => x.id === item.id)) this.items.push(item);
    this.byNorm.set(item.norm, item);
    const folded = foldUa(item.norm);
    if (folded) this.byNorm.set(folded, item);
    const forms = placeForms(item.name);
    for (const form of forms) {
      if (!this.byNorm.has(form)) this.byNorm.set(form, item);
    }
    for (const alias of item.aliases) {
      if (alias) {
        this.byNorm.set(alias, item);
        const foldAlias = foldUa(alias);
        if (foldAlias) this.byNorm.set(foldAlias, item);
        for (const form of placeForms(alias).slice(0, 12)) {
          if (!this.byNorm.has(form)) this.byNorm.set(form, item);
        }
        registerPlaceSlang(alias, item.name);
      }
    }
  }
}

type OsmElement = {
  type?: string;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};
