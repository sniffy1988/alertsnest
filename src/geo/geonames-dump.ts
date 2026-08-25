import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import axios from 'axios';
import type { PlaceKind } from './ua-gazetteer';
import { inKharkivOblast } from './place-match';

/** GeoNames admin1 code for Kharkivs’ka Oblast’. */
export const KHARKIV_ADMIN1 = '07';

export const GEONAMES_UA_ZIP = 'https://download.geonames.org/export/dump/UA.zip';
export const DUMP_RELATIVE = 'data/kharkiv-places.json';
export const GEONAMES_USER_AGENT = 'alertsNest/1.0 (kharkiv-alerts; geonames dump)';

const PLACE_CODES = new Set(['PPL', 'PPLA', 'PPLA2', 'PPLA3', 'PPLA4', 'PPLC', 'PPLX', 'PPLL']);

export type DumpPlace = {
  name: string;
  aliases: string[];
  lat: number;
  lon: number;
  kind: PlaceKind;
  feature: string;
  population: number;
};

export type PlacesDump = {
  source: 'geonames';
  url: string;
  admin1: string;
  downloadedAt: string;
  places: DumpPlace[];
};

export function dumpFilePath(cwd = process.cwd()): string {
  return join(cwd, DUMP_RELATIVE);
}

export function readPlacesDump(path = dumpFilePath()): PlacesDump | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as PlacesDump;
    if (!Array.isArray(raw.places) || raw.places.length === 0) return null;
    return raw;
  } catch {
    return null;
  }
}

export function parseGeonamesUaTxt(txt: string): DumpPlace[] {
  const out: DumpPlace[] = [];
  const seen = new Set<string>();

  for (const line of txt.split('\n')) {
    if (!line) continue;
    const col = line.split('\t');
    if (col.length < 15) continue;
    if (col[10] !== KHARKIV_ADMIN1) continue;

    const fc = col[6];
    const fcode = col[7];
    const lat = Number(col[4]);
    const lon = Number(col[5]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (!inKharkivOblast(lat, lon)) continue;

    const kind = kindFromFeature(fc, fcode, col[1]);
    if (!kind) continue;

    const alts = (col[3] ? col[3].split(',') : []).map((s) => s.trim()).filter(Boolean);
    const name = pickDisplayName(col[1], alts);
    if (name.length < 2) continue;

    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      name,
      aliases: usefulAliases(col[1], col[2], alts, name),
      lat,
      lon,
      kind,
      feature: fcode,
      population: Number(col[14]) || 0,
    });
  }

  return out;
}

export async function downloadGeonamesDump(dest = dumpFilePath()): Promise<PlacesDump> {
  mkdirSync(join(dest, '..'), { recursive: true });
  const work = join(tmpdir(), 'alertsNest-geonames');
  mkdirSync(work, { recursive: true });
  const zipPath = join(work, 'UA.zip');
  const txtPath = join(work, 'UA.txt');

  const response = await axios.get<ArrayBuffer>(GEONAMES_UA_ZIP, {
    responseType: 'arraybuffer',
    timeout: 60_000,
    headers: { 'User-Agent': GEONAMES_USER_AGENT },
  });
  writeFileSync(zipPath, Buffer.from(response.data));

  const unzip = spawnSync('unzip', ['-o', zipPath, 'UA.txt', '-d', work], { encoding: 'utf8' });
  if (unzip.status !== 0 || !existsSync(txtPath)) {
    throw new Error(unzip.stderr?.trim() || 'unzip UA.txt failed');
  }

  const places = parseGeonamesUaTxt(readFileSync(txtPath, 'utf8'));
  if (!places.length) throw new Error('GeoNames UA.txt produced no Kharkiv places');

  const dump: PlacesDump = {
    source: 'geonames',
    url: GEONAMES_UA_ZIP,
    admin1: KHARKIV_ADMIN1,
    downloadedAt: new Date().toISOString(),
    places,
  };
  writeFileSync(dest, JSON.stringify(dump));
  return dump;
}

function kindFromFeature(fc: string, fcode: string, name: string): PlaceKind | null {
  if (fc === 'A' && fcode === 'ADM2') return 'region';
  if (fc !== 'P' || !PLACE_CODES.has(fcode)) return null;
  if (/^(kharkiv|kharkov|харків|харьков)$/i.test(name.replace(/['’ʼ]/g, ''))) return 'city';
  if (fcode === 'PPLX') return 'district';
  return 'settlement';
}

function pickDisplayName(primary: string, alts: string[]): string {
  const all = [primary, ...alts];
  return all.find((s) => /[іїєґІЇЄҐ]/.test(s)) ?? all.find((s) => /[а-яА-ЯёЁіІїЇєЄґҐ]/.test(s)) ?? primary;
}

function usefulAliases(primary: string, ascii: string, alts: string[], official: string): string[] {
  const out: string[] = [];
  const seen = new Set([official.toLowerCase()]);
  for (const raw of [primary, ascii, ...alts]) {
    const s = raw.trim();
    if (s.length < 2 || s.length > 48) continue;
    const cyrillic = /[а-яА-ЯёЁіІїЇєЄґҐ]/.test(s);
    const officialLatin = s === primary || s === ascii;
    if (!cyrillic && !officialLatin) continue;
    if (!cyrillic && !/^[A-Za-z][A-Za-z\s'.-]*[A-Za-z]$/.test(s)) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= 8) break;
  }
  return out;
}
