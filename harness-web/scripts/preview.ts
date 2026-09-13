import { printPreset, PRESET_DEFAULTS } from '../src/generator';
import { buildProjectFiles } from '../src/lib/exportProject';
import type { AttackSnippetFile } from '../src/generator/attacks/assembleAttackTests';
import snippets from '../src/generated/attack-snippets.json';
import { PRESET_LIST, type GenerateOptions, type Preset } from '../src/types';

/**
 * Prints a preset's generated file to stdout:
 *   npx tsx scripts/preview.ts <preset> [contract|attacks|properties|deploy] [json-overrides]
 */
const preset = process.argv[2] as Preset;
const which = process.argv[3] ?? 'contract';
const overrides = JSON.parse(process.argv[4] ?? '{}') as Partial<GenerateOptions>;
if (!PRESET_LIST.includes(preset)) {
  console.error(`usage: preview.ts <${PRESET_LIST.join('|')}> [contract|attacks|properties|deploy] [json]`);
  process.exit(2);
}
const opts: GenerateOptions = { ...PRESET_DEFAULTS[preset], ...overrides };
if (which === 'contract') {
  console.log(printPreset(opts));
} else {
  const files = buildProjectFiles(opts, snippets as unknown as AttackSnippetFile);
  console.log(
    which === 'attacks' ? files.attackTests : which === 'properties' ? files.propertyTests : files.deployScript,
  );
}
