import { downloadGeonamesDump, dumpFilePath, readPlacesDump } from '../src/geo/geonames-dump';

async function main() {
  const dest = dumpFilePath();
  const dump = await downloadGeonamesDump(dest);
  const verify = readPlacesDump(dest);
  const byKind = new Map<string, number>();
  for (const p of dump.places) {
    byKind.set(p.kind, (byKind.get(p.kind) ?? 0) + 1);
  }
  console.log(
    `Wrote ${verify?.places.length ?? 0} places → ${dest} (${[...byKind.entries()]
      .map(([k, n]) => `${k}=${n}`)
      .join(', ')})`,
  );
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  throw err;
});
