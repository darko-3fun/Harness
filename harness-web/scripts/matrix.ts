import { printPreset } from '../src/generator';
import type { GenerateOptions, Preset } from '../src/types';

const out: Record<string, { content: string }> = {};
let n = 0, rejected = 0;
for (const preset of ['aave-v3-flashloan-receiver', 'aave-v3-erc4626-vault'] as Preset[])
  for (const access of ['none', 'ownable', 'roles'] as const)
    for (const pausable of [false, true])
      for (const routerAllowlist of [false, true])
        for (const claimRewards of [false, true])
          for (const sweepEscapeHatch of [false, true])
            for (const extra of [{}, { depositCap: '10000000000000', feeBps: 200 }]) {
              const name = `Gen${n++}`;
              const opts = {
                preset, name, access, pausable, routerAllowlist, claimRewards, sweepEscapeHatch,
                asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', ...extra,
              } as GenerateOptions;
              try { out[`${name}.sol`] = { content: printPreset(opts) }; } catch { rejected++; }
            }
console.error(`accepted ${Object.keys(out).length}, rejected ${rejected} of ${n}`);
console.log(JSON.stringify(out));
