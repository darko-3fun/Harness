import fs from 'node:fs';
import path from 'node:path';
import { FINDINGS } from '../src/audit/findings';
import { PRESET_LIST } from '../src/types';

/**
 * Writes the audit corpus out to harness-api/knowledge/findings.json.
 *
 * The corpus lives here, in TypeScript, because that is where it is type-checked
 * against the finding-ID vocabulary and mutation-tested. The API needs the same
 * rules as data. Exporting rather than maintaining a second copy is what stops the
 * two drifting — which they had, leaving the API's engine knowing 15 findings and
 * two presets while the generator had moved on to 38 and six.
 */
const out = path.join(__dirname, '../../harness-api/knowledge/findings.json');

const doc = {
  _meta: {
    version: 2,
    generated: 'by harness-web/scripts/export-findings.ts — do not edit by hand',
    source: 'harness-web/src/audit/findings.ts',
    presets: PRESET_LIST,
    count: FINDINGS.length,
    taxonomy: 'AuditVault vuln/ slugs as catalogued in sanbir/evm-hack-registry',
    attribution: [
      'https://github.com/sanbir/evm-hack-registry',
      'https://github.com/SunWeb3Sec/DeFiHackLabs',
      'https://github.com/AuditWare/AuditVault',
    ],
  },
  findings: FINDINGS,
};

fs.writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
console.log(
  `wrote ${path.relative(process.cwd(), out)} — ${FINDINGS.length} findings across ${PRESET_LIST.length} presets`,
);
