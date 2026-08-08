import { printFlashLoanReceiver } from '../src/generator/aave/flashLoanReceiver';
import type { GenerateOptions } from '../src/types';

const opts: GenerateOptions = {
  preset: 'aave-v3-flashloan-receiver',
  name: 'MyFlashLoanReceiver',
  access: 'ownable',
  pausable: true,
  asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  routerAllowlist: true,
  claimRewards: true,
  sweepEscapeHatch: true,
};
console.log(printFlashLoanReceiver(opts));
