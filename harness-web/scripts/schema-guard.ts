import fs from 'node:fs';
import path from 'node:path';
import { assembleAttackTests, type AttackSnippetFile } from '../src/generator/attacks/assembleAttackTests';
import { PRESET_DEFAULTS } from '../src/generator';

const real: AttackSnippetFile = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../fixtures/attack-snippets.json'), 'utf8'),
);

const cases: [string, AttackSnippetFile][] = [
  ['current fixture', real],
  ['empty snippets', { schemaVersion: 'x', snippets: {} }],
  // What Agent B's `variants` schema would look like to my reader: keys present,
  // but no `body`, so nothing matches.
  ['foreign schema (variants)', {
    schemaVersion: 'harness-attack-snippets/v2',
    snippets: { 'SOME-UNKNOWN-ID': { testName: 't', title: 't', incidents: [], body: [] } },
  } as AttackSnippetFile],
];

for (const [label, file] of cases) {
  for (const preset of ['aave-v3-flashloan-receiver', 'aave-v3-erc4626-vault'] as const) {
    try {
      const r = assembleAttackTests(PRESET_DEFAULTS[preset], file);
      console.log(`${label.padEnd(26)} ${preset.replace('aave-v3-', '').padEnd(20)} -> ${r.testNames.length} tests`);
    } catch (e) {
      console.log(`${label.padEnd(26)} ${preset.replace('aave-v3-', '').padEnd(20)} -> THROWS: ${(e as Error).message.slice(0, 90)}…`);
    }
  }
}
