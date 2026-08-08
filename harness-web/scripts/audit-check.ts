import { printFlashLoanReceiver } from '../src/generator/aave/flashLoanReceiver';
import { mockAudit } from '../src/mocks/auditFindings';
import type { GenerateOptions } from '../src/types';

const opts: GenerateOptions = {
  preset: 'aave-v3-flashloan-receiver',
  name: 'MyFlashLoanReceiver', access: 'ownable', pausable: true,
  asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  routerAllowlist: true, claimRewards: true, sweepEscapeHatch: true,
};

const source = printFlashLoanReceiver(opts);
const show = (label: string, src: string) => {
  const r = mockAudit(src, opts.preset);
  console.log(`${label.padEnd(34)} mitigated ${r.score.mitigated}  triggered ${r.score.triggered}` +
    (r.score.triggered ? `  -> ${r.findings.filter(f=>f.status==='triggered').map(f=>`${f.id}(${f.severity})`).join(', ')}` : ''));
};

show('as generated', source);
show('minus NotSelfInitiated gate', source.replace(/.*revert NotSelfInitiated.*\n/, ''));
show('minus using SafeERC20', source.replace(/.*using SafeERC20.*\n/, ''));
show('minus whenNotPaused', source.replace(/^\s*whenNotPaused\n/m, ''));
show('with a raw .call() added', source.replace('return true;', 'target.call(data);\n        return true;'));
