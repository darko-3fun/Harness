// Agent B owns fixtures/attack-snippets.json at the repo root, but Vercel deploys
// only harness-web/, so the file has to exist inside this app. This copies it in
// and the copy is committed. When the root fixture is absent (Vercel build), the
// committed copy is used as-is.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '../../fixtures/attack-snippets.json');
const dest = path.join(here, '../src/generated/attack-snippets.json');

if (!fs.existsSync(src)) {
  console.log(`sync-fixtures: ${path.relative(here, src)} not present, using committed copy`);
  process.exit(0);
}

const incoming = fs.readFileSync(src, 'utf8');
JSON.parse(incoming); // fail loudly on malformed input rather than at runtime
if (fs.existsSync(dest) && fs.readFileSync(dest, 'utf8') === incoming) {
  console.log('sync-fixtures: up to date');
} else {
  fs.writeFileSync(dest, incoming);
  console.log('sync-fixtures: updated src/generated/attack-snippets.json');
}
