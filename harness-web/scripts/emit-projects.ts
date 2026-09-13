import fs from 'node:fs';
import path from 'node:path';
import { buildPreset, PRESET_DEFAULTS } from '../src/generator';
import { buildProjectFiles, buildProjectZip } from '../src/lib/exportProject';
import type { AttackSnippetFile } from '../src/generator/attacks/assembleAttackTests';
import { PRESET_LIST, type GenerateOptions, type Preset } from '../src/types';

/**
 * Writes every preset's exported project to disk, unzipped, so it can be run with
 * forge: `npx tsx scripts/emit-projects.ts <outDir> [preset] [json-overrides]`.
 *
 * The same code path builds the zip the UI downloads, so what forge runs here is
 * byte-for-byte what a user gets.
 */
const snippets: AttackSnippetFile = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../src/generated/attack-snippets.json'), 'utf8'),
);
const out = process.argv[2];
const only = process.argv[3] as Preset | undefined;
const overrides = JSON.parse(process.argv[4] ?? '{}') as Partial<GenerateOptions>;
if (!out) throw new Error('usage: emit-projects.ts <outDir> [preset] [json-overrides]');

(async () => {
  for (const preset of PRESET_LIST) {
    if (only && preset !== only) continue;
    const opts: GenerateOptions = { ...PRESET_DEFAULTS[preset], ...overrides };
    const applied = buildPreset(opts).appliedFindingIds;
    const files = buildProjectFiles(opts, snippets);
    const dir = path.join(out, opts.name);
    for (const sub of ['src', 'test', 'script']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
    fs.writeFileSync(path.join(dir, `src/${opts.name}.sol`), files.contract);
    fs.writeFileSync(path.join(dir, `test/${opts.name}.attack.t.sol`), files.attackTests);
    fs.writeFileSync(path.join(dir, `test/${opts.name}.props.t.sol`), files.propertyTests);
    fs.writeFileSync(path.join(dir, `script/${opts.name}.s.sol`), files.deployScript);
    const blob = await buildProjectZip(opts, snippets, applied);
    const buf = Buffer.from(await blob.arrayBuffer());
    fs.writeFileSync(path.join(out, `${opts.name}.zip`), buf);
    // The zip carries foundry.toml, remappings, setup.sh and .env.example; unpack
    // those next to the sources so the directory is runnable as-is.
    const JSZip = (await import('jszip')).default;
    const z = await JSZip.loadAsync(buf);
    for (const name of ['foundry.toml', 'remappings.txt', '.env.example', 'setup.sh', 'README.md']) {
      fs.writeFileSync(path.join(dir, name), await z.file(name)!.async('string'));
    }
    console.log(`${preset.padEnd(28)} ${files.attacks.length} attack tests, ${files.properties.length} properties -> ${dir}`);
  }
})();
