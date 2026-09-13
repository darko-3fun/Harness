import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { printPreset, PRESET_DEFAULTS } from '../src/generator';
import { printDeployScript } from '../src/generator/deployScript';
import { PRESET_LIST, EVM_VERSION, type GenerateOptions } from '../src/types';

/**
 * Compiles every preset's default contract with the same solc the app uses, plus
 * its deploy script. `npm run verify` runs this; it is the fastest signal that a
 * generator change produced something that does not compile.
 */
const require = createRequire(import.meta.url);
const ROOT = path.join(__dirname, '..');
const solc = require(path.join(ROOT, 'node_modules/solc'));

function resolveImport(p: string) {
  try {
    return { contents: fs.readFileSync(path.join(ROOT, 'node_modules', p), 'utf8') };
  } catch {
    return { error: `not found ${p}` };
  }
}

export function compileSource(name: string, source: string): { ok: boolean; errors: string[]; warnings: string[]; sizeBytes?: number } {
  const input = {
    language: 'Solidity',
    sources: { [`${name}.sol`]: { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: EVM_VERSION,
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input), { import: resolveImport }));
  const all = (out.errors ?? []) as { severity: string; formattedMessage: string }[];
  const errors = all.filter((e) => e.severity === 'error').map((e) => e.formattedMessage);
  const warnings = all.filter((e) => e.severity === 'warning').map((e) => e.formattedMessage);
  const artifact = out.contracts?.[`${name}.sol`]?.[name];
  return { ok: errors.length === 0, errors, warnings, sizeBytes: artifact ? artifact.evm.bytecode.object.length / 2 : undefined };
}

if (require.main === module) {
  const only = process.argv[2];
  let failed = 0;
  for (const preset of PRESET_LIST) {
    if (only && preset !== only) continue;
    const opts: GenerateOptions = PRESET_DEFAULTS[preset];
    let source: string;
    try {
      source = printPreset(opts);
    } catch (e) {
      console.log(`${preset.padEnd(28)} GENERATOR THREW: ${(e as Error).message}`);
      failed++;
      continue;
    }
    const r = compileSource(opts.name, source);
    console.log(`${preset.padEnd(28)} ${r.ok ? 'OK ' : 'ERR'} ${r.sizeBytes ?? '-'} bytes, ${r.warnings.length} warnings`);
    for (const e of r.errors) console.log(e);
    for (const w of r.warnings) console.log(w);
    if (!r.ok) failed++;
    try {
      printDeployScript(opts);
    } catch (e) {
      console.log(`  deploy script THREW: ${(e as Error).message}`);
      failed++;
    }
  }
  process.exit(failed ? 1 : 0);
}
