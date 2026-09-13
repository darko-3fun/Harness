// The repo root owns two files both apps consume: contract/types.ts (the shared
// interface contract) and fixtures/attack-snippets.json (the attack-test bodies).
// Vercel deploys only harness-web/, so each has to exist inside this app too. This
// copies them in; the copies are committed. When the root is absent (a Vercel
// build), the committed copies are used as-is.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '../..');

const pairs = [
  ['contract/types.ts', 'harness-web/src/types.ts'],
  ['contract/types.ts', 'harness-api/src/types.ts'],
  ['fixtures/attack-snippets.json', 'harness-web/src/generated/attack-snippets.json'],
];

for (const [from, to] of pairs) {
  const src = path.join(root, from);
  const dest = path.join(root, to);
  if (!fs.existsSync(src)) {
    console.log(`sync-shared: ${from} not present, using committed copy of ${to}`);
    continue;
  }
  if (!fs.existsSync(path.dirname(dest))) continue; // the other app is not checked out
  const incoming = fs.readFileSync(src, 'utf8');
  if (from.endsWith('.json')) JSON.parse(incoming); // fail loudly on malformed input
  if (fs.existsSync(dest) && fs.readFileSync(dest, 'utf8') === incoming) {
    console.log(`sync-shared: ${to} up to date`);
  } else {
    fs.writeFileSync(dest, incoming);
    console.log(`sync-shared: updated ${to}`);
  }
}
