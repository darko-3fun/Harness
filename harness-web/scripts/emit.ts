import fs from 'node:fs';
import path from 'node:path';
import { printPreset } from '../src/generator';
import { assembleAttackTests, type AttackSnippetFile } from '../src/generator/attacks/assembleAttackTests';
import type { GenerateOptions } from '../src/types';

const outDir = process.argv[2];
const snippets: AttackSnippetFile = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../fixtures/attack-snippets.json'), 'utf8'),
);

const opts: GenerateOptions = {
  preset: 'aave-v3-flashloan-receiver',
  name: 'MyFlashLoanReceiver',
  access: 'ownable',
  pausable: true,
  asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  routerAllowlist: true,
  claimRewards: false,
  sweepEscapeHatch: true,
  ...JSON.parse(process.argv[3] ?? '{}'),
};

const { source, testNames, skipped } = assembleAttackTests(opts, snippets);
fs.mkdirSync(path.join(outDir, 'src'), { recursive: true });
fs.mkdirSync(path.join(outDir, 'test'), { recursive: true });
fs.writeFileSync(path.join(outDir, `src/${opts.name}.sol`), printPreset(opts));
fs.writeFileSync(path.join(outDir, `test/${opts.name}.attack.t.sol`), source);
console.error(`emitted ${testNames.length} tests: ${testNames.join(', ')}; skipped ${skipped.length}`);
