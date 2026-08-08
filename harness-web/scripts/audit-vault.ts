import { printPreset, PRESET_DEFAULTS } from '../src/generator';
import { mockAudit } from '../src/mocks/auditFindings';

for (const preset of ['aave-v3-flashloan-receiver', 'aave-v3-erc4626-vault'] as const) {
  const opts = PRESET_DEFAULTS[preset];
  const src = printPreset(opts);
  const r = mockAudit(src, preset);
  console.log(`${preset.padEnd(28)} mitigated ${r.score.mitigated}  triggered ${r.score.triggered}` +
    (r.score.triggered ? `  -> ${r.findings.filter(f=>f.status==='triggered').map(f=>f.id).join(', ')}` : ''));
  if (preset === 'aave-v3-erc4626-vault') {
    const broken = src.replace('return _managedAssets;', 'return ATOKEN.balanceOf(address(this));');
    const rb = mockAudit(broken, preset);
    console.log(`  ^ with balanceOf denominator: triggered ${rb.score.triggered} -> ${rb.findings.filter(f=>f.status==='triggered').map(f=>`${f.id}(${f.severity})`).join(', ')}`);
  }
}
