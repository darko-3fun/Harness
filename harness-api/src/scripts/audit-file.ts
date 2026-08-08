// Audits and compiles an arbitrary .sol file — the "paste your own code" path (B5), and how
// Agent A's generator output gets checked outside the fixture flow.
// Usage: tsx src/scripts/audit-file.ts <path.sol> <preset> [ContractName]

import fs from 'node:fs';
import path from 'node:path';
import { auditSource } from '../routes/audit.js';
import { compileContract } from '../routes/compile.js';
import { assertPreset } from '../validate.js';

const [, , filePath, presetArg, nameArg] = process.argv;
if (!filePath || !presetArg) {
  console.error('usage: tsx src/scripts/audit-file.ts <path.sol> <preset> [ContractName]');
  process.exit(2);
}

const preset = assertPreset(presetArg);
const source = fs.readFileSync(path.resolve(filePath), 'utf8');
const contractName = nameArg ?? source.match(/contract\s+([A-Za-z_][A-Za-z0-9_]*)/)?.[1];

console.log(`${path.basename(filePath)}  ·  ${preset}  ·  ${contractName ?? '(no contract found)'}`);

if (contractName) {
  const compiled = compileContract({ source, contractName });
  for (const e of compiled.errors.filter((x) => x.severity === 'error')) {
    console.log(`  [solc] line ${e.line ?? '?'}: ${e.message.split('\n')[0]}`);
  }
  console.log(
    compiled.ok
      ? `compile: OK — ${compiled.sizeBytes} bytes deployed, ${compiled.abi?.length} ABI entries`
      : 'compile: FAILED',
  );
}

const audit = auditSource({ source, preset });
console.log(`audit:   ${audit.score.mitigated} mitigated, ${audit.score.triggered} triggered`);
for (const f of audit.findings) {
  const mark = f.status === 'triggered' ? '❌' : '✅';
  console.log(`  ${mark} ${f.id.padEnd(14)} [${f.severity.padEnd(8)}] ${f.title}`);
}

process.exit(audit.score.triggered > 0 ? 1 : 0);
