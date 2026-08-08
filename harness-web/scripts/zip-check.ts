import fs from 'node:fs';
import path from 'node:path';
import { buildProjectZip, remixUrl } from '../src/lib/exportProject';
import { buildPreset, printPreset, PRESET_DEFAULTS } from '../src/generator';
import type { AttackSnippetFile } from '../src/generator/attacks/assembleAttackTests';

const snippets: AttackSnippetFile = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../fixtures/attack-snippets.json'), 'utf8'),
);
const out = process.argv[2];

(async () => {
  for (const preset of ['aave-v3-flashloan-receiver', 'aave-v3-erc4626-vault'] as const) {
    const opts = PRESET_DEFAULTS[preset];
    const applied = buildPreset(opts).appliedFindingIds;
    const blob = await buildProjectZip(opts, snippets, applied);
    const buf = Buffer.from(await blob.arrayBuffer());
    fs.writeFileSync(path.join(out, `${opts.name}.zip`), buf);
    console.log(`${opts.name}.zip  ${buf.length} bytes`);
    const url = remixUrl(printPreset(opts));
    console.log(`  remix url ${url.length} chars, starts ${url.slice(0, 46)}…`);
  }
})();
