import { readFile } from 'node:fs/promises';
import { streamRows } from '../../tools/stream_rows.mjs';
const manifest=JSON.parse(await readFile('data/blue-dots/manifest.json','utf8'));
console.log(JSON.stringify({label:manifest.displayLabel,total:manifest.sourceManifest.total,files:manifest.files.length,coordinateSystem:manifest.sourceManifest.coordinateSystem,overlapPolicy:manifest.overlapPolicy,source:manifest.source},null,2));