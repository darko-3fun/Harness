// Throwaway: identify unknown 4-byte selectors against candidate signatures.
// Usage: tsx src/scripts/selector-probe.ts 0x2c5211c6,0xc44b11f7

import { toFunctionSelector } from 'viem';

const targets = (process.argv[2] ?? '')
  .toLowerCase()
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const candidates = [
  // this project's own entrypoints
  'executeFlashLoan(address,uint256,bytes)',
  'executeOperation(address,uint256,uint256,address,bytes)',
  'deposit(uint256,address)',
  'redeem(uint256,address,address)',
  'withdraw(uint256,address,address)',
  'sweep(address,address)',
  'claimRewards(address)',
  'reserveCaps()',
  // this vault's own errors
  'ReserveUnavailable(address)',
  'ZeroLtvCollateral(address)',
  'DepositCapExceeded(uint256)',
  'PartialWithdraw(uint256,uint256)',
  'UnhealthyPosition(uint256)',
  'CannotSweepPrincipal(address)',
  // OpenZeppelin
  'EnforcedPause()',
  'OwnableUnauthorizedAccount(address)',
  'ERC4626ExceededMaxDeposit(address,uint256,uint256)',
  'ERC20InsufficientBalance(address,uint256,uint256)',
  'ERC20InsufficientAllowance(address,uint256,uint256)',
  'SafeERC20FailedOperation(address)',
  // Aave v3 pool surface
  'getConfiguration(address)',
  'getReserveData(address)',
  'getReserveDataExtended(address)',
  'getReserveNormalizedIncome(address)',
  'getReserveNormalizedVariableDebt(address)',
  'getUserConfiguration(address)',
  'getUserAccountData(address)',
  'getEModeCategoryData(uint8)',
  'getUserEMode(address)',
  'getReserveAToken(address)',
  'getReserveVariableDebtToken(address)',
  'getVirtualUnderlyingBalance(address)',
  'getFlashLoanLogic()',
  'mintToTreasury(address[])',
  'updateState(address)',
  'validateBorrow(address)',
  'FLASHLOAN_PREMIUM_TOTAL()',
  // Aave v3.3 custom errors
  'InvalidAmount()',
  'InvalidMintAmount()',
  'InvalidBurnAmount()',
  'ReserveInactive()',
  'ReserveFrozen()',
  'ReservePaused()',
  'SupplyCapExceeded()',
  'BorrowCapExceeded()',
  'HealthFactorLowerThanLiquidationThreshold()',
];

const table = new Map<string, string>();
for (const sig of candidates) table.set(toFunctionSelector(`function ${sig}`).toLowerCase(), sig);

if (targets.length === 0) {
  for (const [selector, sig] of table) console.log(`${selector}  ${sig}`);
} else {
  for (const target of targets) {
    const hit = table.get(target);
    console.log(`${target}  ${hit ? `→ ${hit}` : `no match among ${candidates.length} candidates`}`);
  }
}
