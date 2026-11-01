// Downloads the current Fortnite BR map (2048px, no labels) from fortnite-api.com
// into public/maps/hera.png, and prints a few POI world coordinates you can use
// to re-run the Align > 2-point calibration if the map layout changed.
//
//   node scripts/update-map.mjs
//
// No auth needed. Run this after a Fortnite update that changes the map.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'maps', 'hera.png');

const img = await fetch('https://fortnite-api.com/images/map.png');
if (!img.ok) throw new Error(`map.png -> HTTP ${img.status}`);
const bytes = Buffer.from(await img.arrayBuffer());
writeFileSync(OUT, bytes);
console.log(`saved ${(bytes.length / 1048576).toFixed(2)} MB -> ${OUT}`);

const meta = await fetch('https://fortnite-api.com/v1/map').then((r) => r.json());
console.log(`\n${meta.data.pois.length} POIs. A few landmarks (world x, y) for calibration:`);
for (const name of ['Pinky Island', 'Blinky Island', 'Pac-Man Island', 'Chopped Shop', 'Golden Grove']) {
  const p = meta.data.pois.find((x) => x.name === name);
  if (p) console.log(`  ${name.padEnd(16)} (${Math.round(p.location.x)}, ${Math.round(p.location.y)})`);
}
console.log('\nIf positions look off after this, open the viewer, hit Align, and do the 2-point fit.');
