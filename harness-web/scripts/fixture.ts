import fs from 'node:fs';
import path from 'node:path';
import { printFlashLoanReceiver, buildFlashLoanReceiver } from '../src/generator/aave/flashLoanReceiver';
import { printDeployScript } from '../src/generator/aave/deployScript';
import { assembleAttackTests, type AttackSnippetFile } from '../src/generator/attacks/assembleAttackTests';
import { REMAPPINGS, type GeneratedProject, type GenerateOptions } from '../src/types';

const root = path.join(__dirname, '../..');
const snippets: AttackSnippetFile = JSON.parse(
  fs.readFileSync(path.join(root, 'fixtures/attack-snippets.json'), 'utf8'),
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
};

const project: GeneratedProject = {
  preset: opts.preset,
  contractName: opts.name,
  contractSource: printFlashLoanReceiver(opts),
  attackTestSource: assembleAttackTests(opts, snippets).source,
  deployScriptSource: printDeployScript(opts),
  remappings: REMAPPINGS,
  appliedFindingIds: buildFlashLoanReceiver(opts).appliedFindingIds,
};

fs.writeFileSync(
  path.join(root, 'fixtures/sample-generated.json'),
  JSON.stringify(project, null, 2) + '\n',
);
console.error(`wrote sample-generated.json — ${project.appliedFindingIds.length} findings applied`);
