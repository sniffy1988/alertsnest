import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import { normalize } from '../common/text';
import { GAZETTEER, KHARKIV_CENTER, type PlaceKind } from './ua-gazetteer';
import {
  expandPlaceSlang,
  foldPlaceText,
  foldUa,
  inKharkivOblast,
  looksLikeSettlement,
  namesEqual,
  placeStem,
  placeVariants,
  registerPlaceSlang,
} from './place-match';

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

const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const OVERPASS_QUERY = `
[out:json][timeout:90];
(
  way["highway"]["name"](49.89,36.05,50.12,36.45);
  node["place"~"suburb|neighbourhood|quarter"]["name"](49.89,36.05,50.12,36.45);
);
out center tags;
`.trim();

@Injectable()
export class ToponymService implements OnModuleInit {
  private readonly logger = new Logger(ToponymService.name);
  private items: MemoryToponym[] = [];
  private byNorm = new Map<string, MemoryToponym>();

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.dropBadLearned();
    await this.ensureSeed();
    await this.refreshMemory();
    const osmCount = await this.prisma.toponym.count({ where: { source: 'osm' } });
    if (osmCount === 0) {
      try {
        const added = await this.importFromOsm();
        this.logger.log(`OSM import added ${added} toponyms`);
        await this.refreshMemory();
      } catch (err) {
        this.logger.warn(`OSM import skipped: ${err instanceof Error ? err.message : err}`);
      }
    }
    this.logger.log(`Toponym dictionary ready: ${this.items.length}`);
  }

  all(): MemoryToponym[] {
    return this.items;
  }

  lookup(raw: string): MemoryToponym | null {
    const key = normalize(raw);
    if (!key) return null;
    for (const variant of placeVariants(raw)) {
      const exact = this.byNorm.get(variant) ?? this.byNorm.get(normalize(variant)) ?? this.byNorm.get(foldUa(variant));
      if (exact) return exact;
    }

    const queryStem = placeStem(raw);
    if (queryStem.length < 5) return null;

    let best: MemoryToponym | null = null;
    let bestLen = 0;
    for (const item of this.items) {
      const labels = [item.name, item.norm, ...item.aliases];
      for (const label of labels) {
        if (!namesEqual(raw, label)) continue;
        const len = foldUa(label).length;
        if (len > bestLen) {
          best = item;
          bestLen = len;
        }
      }
    }
    return best;
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

    for (const item of this.items) {
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
          if (item.kind === 'city') {
            return /^(харків|харьков|kharkiv|kharkov|харкову|харькову|харкова|харькова|харкові)$/.test(
              foldUa(token),
            );
          }
          if (namesEqual(token, label)) return true;
          const tokenStem = placeStem(token);
          return tokenStem.length >= 4 && tokenStem === stem;
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
    return [...hits.values()];
  }

  async explain(alias: string, meaning: string): Promise<{ ok: true; place: string } | { ok: false; reason: 'bad' | 'unknown_target' }> {
    const rawAlias = alias.trim();
    const rawMeaning = meaning.trim();
    if (rawAlias.length < 2 || rawMeaning.length < 2) return { ok: false, reason: 'bad' };
    const target = this.lookup(rawMeaning);
    if (!target) return { ok: false, reason: 'unknown_target' };
    await this.addAlias(target, rawAlias);
    await this.sweepUnknowns(rawAlias);
    this.logger.log(`taught alias "${rawAlias}" → ${target.name}`);
    return { ok: true, place: target.name };
  }

  async rememberUnknown(input: {
    labels: string[];
    sampleText: string;
    channel: string;
  }): Promise<{ created: string[] }> {
    const created: string[] = [];
    const labels = input.labels.map((s) => s.trim()).filter((s) => s.length >= 2);
    const toStore = labels.length ? labels : [input.sampleText.slice(0, 48).trim()].filter(Boolean);
    for (const label of toStore) {
      if (this.lookup(label)) continue;
      const norm = foldUa(label);
      if (!norm || this.lookup(norm)) continue;
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
      await this.prisma.unknownToponym.create({
        data: {
          label,
          norm,
          sampleText: input.sampleText.slice(0, 400),
          channel: input.channel,
        },
      });
      created.push(label);
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

  private async sweepUnknowns(alias: string): Promise<void> {
    const norms = [...new Set([foldUa(alias), normalize(alias)].filter(Boolean))];
    if (norms.length) {
      await this.prisma.unknownToponym.deleteMany({ where: { norm: { in: norms } } });
    }
    const leftover = await this.prisma.unknownToponym.findMany();
    for (const row of leftover) {
      if (this.lookup(row.label) || this.lookup(row.norm)) {
        await this.prisma.unknownToponym.delete({ where: { id: row.id } }).catch(() => undefined);
      }
    }
  }

  private async addAlias(item: MemoryToponym, seenAs: string): Promise<void> {
    const extras = [...new Set([normalize(seenAs), foldUa(seenAs), seenAs.trim().toLowerCase()].filter(Boolean))];
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

  async learn(names: string[], hint?: MemoryToponym | null): Promise<MemoryToponym[]> {
    const resolved: MemoryToponym[] = [];
    for (const raw of names) {
      const name = raw.trim();
      if (name.length < 3) continue;
      const existing = this.lookup(name);
      if (existing) {
        await this.touch(existing, name);
        const fresh = this.byNorm.get(existing.norm) ?? existing;
        resolved.push(fresh);
        continue;
      }
      const created = await this.insertLearned(name, hint);
      if (created) resolved.push(created);
    }
    return resolved;
  }

  private async insertLearned(name: string, hint?: MemoryToponym | null): Promise<MemoryToponym | null> {
    const kind = this.guessKind(name);
    const geo = await this.geocode(name, kind);
    if (!geo) {
      this.logger.log(`Skip learn "${name}" (${kind}): no coordinates`);
      return null;
    }
    const row = await this.prisma.toponym.create({
      data: {
        name,
        norm: normalize(name),
        aliases: JSON.stringify([normalize(name), foldUa(name)].filter(Boolean)),
        lat: geo.lat,
        lon: geo.lon,
        kind,
        source: 'nominatim',
        hitCount: 1,
      },
    });
    const mem = this.toMemory(row);
    this.index(mem);
    this.logger.log(`Learned toponym "${name}" (${kind}) ${geo.lat.toFixed(4)},${geo.lon.toFixed(4)}`);
    return mem;
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

  private async geocode(name: string, kind: ToponymKind): Promise<{ lat: number; lon: number } | null> {
    const suffix = kind === 'street' || kind === 'district' ? 'Харків' : 'Харківська область Україна';
    try {
      const response = await axios.get<Array<{ lat: string; lon: string }>>(
        'https://nominatim.openstreetmap.org/search',
        {
          timeout: 12_000,
          params: { q: `${name} ${suffix}`, format: 'json', limit: 1 },
          headers: { 'User-Agent': 'alertsNest/1.0 (kharkiv-alerts)', Accept: 'application/json' },
        },
      );
      const hit = response.data[0];
      if (!hit) return null;
      const lat = Number(hit.lat);
      const lon = Number(hit.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      if (!inKharkivOblast(lat, lon)) return null;
      if ((kind === 'street' || kind === 'district') && this.haversineKm(lat, lon, KHARKIV_CENTER.lat, KHARKIV_CENTER.lon) > 25) {
        return null;
      }
      return { lat, lon };
    } catch (err) {
      this.logger.warn(`Nominatim "${name}": ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  private haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const toRad = (n: number) => (n * Math.PI) / 180;
    const r = 6371;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * r * Math.asin(Math.sqrt(a));
  }

  private async ensureSeed(): Promise<void> {
    for (const place of GAZETTEER) {
      const aliases = [...new Set([normalize(place.name), ...place.aliases.map(normalize)])];
      const norm = aliases[0];
      const existing = await this.prisma.toponym.findUnique({ where: { norm } });
      if (existing) {
        const merged = [...new Set([...this.parseAliases(existing.aliases), ...aliases])];
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

  private async importFromOsm(): Promise<number> {
    const elements = await this.fetchOverpass();
    this.logger.log(`OSM overpass elements=${elements.length}`);
    let added = 0;
    for (const el of elements) {
      const name = el.tags?.['name:uk'] || el.tags?.name;
      if (!name) continue;
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      if (lat == null || lon == null) continue;
      const kind = this.kindFromOsm(el);
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
            source: 'osm',
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

  private async fetchOverpass(): Promise<OsmElement[]> {
    let lastError: unknown;
    for (const url of OVERPASS_URLS) {
      try {
        const response = await axios.post(url, new URLSearchParams({ data: OVERPASS_QUERY }).toString(), {
          timeout: 90_000,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: '*/*',
            'User-Agent': 'alertsNest/1.0 (kharkiv-alerts)',
          },
        });
        const elements = (response.data as { elements?: OsmElement[] }).elements ?? [];
        if (elements.length) return elements;
        this.logger.warn(`OSM ${url} empty response`);
      } catch (err) {
        lastError = err;
        this.logger.warn(`OSM ${url} failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    throw lastError ?? new Error('Overpass failed');
  }

  private kindFromOsm(el: OsmElement): ToponymKind {
    const place = el.tags?.place;
    if (place === 'village' || place === 'town' || place === 'hamlet' || place === 'isolated_dwelling') {
      return 'settlement';
    }
    if (place === 'suburb' || place === 'neighbourhood' || place === 'quarter') return 'district';
    if (el.tags?.admin_level) return 'district';
    return 'street';
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
    if (!this.items.some((x) => x.id === item.id)) this.items.push(item);
    this.byNorm.set(item.norm, item);
    const folded = foldUa(item.norm);
    if (folded) this.byNorm.set(folded, item);
    for (const alias of item.aliases) {
      if (alias) {
        this.byNorm.set(alias, item);
        const foldAlias = foldUa(alias);
        if (foldAlias) this.byNorm.set(foldAlias, item);
        registerPlaceSlang(alias, item.name);
      }
    }
  }
}

type OsmElement = {
  type: string;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};
