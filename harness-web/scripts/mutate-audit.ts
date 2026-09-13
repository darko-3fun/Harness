import { audit } from '../src/audit/engine';
import { printPreset, PRESET_DEFAULTS } from '../src/generator';
import { FINDING_IDS as F, PRESET_LIST, type FindingId, type Preset } from '../src/types';

/**
 * Mutation test for the audit corpus, every preset.
 *
 * A detect rule that never fires is indistinguishable from one that works, because
 * the generated contract is supposed to be clean. So: assert the clean contract
 * triggers nothing, then remove one mitigation at a time and assert that exactly
 * the expected findings appear — usually one, occasionally two when a single line
 * is what two findings both depend on (the initiator gate is also what keeps idle
 * funds safe, so removing it flips AAVE-FL-001 and AAVE-FL-013 together).
 */
interface Mutation {
  expect: FindingId[];
  what: string;
  apply: (src: string) => string;
}

const cut = (needle: string | RegExp) => (src: string) => {
  const out = src.replace(needle, '');
  if (out === src) throw new Error(`needle not found: ${needle}`);
  return out;
};
const swap = (needle: string | RegExp, replacement: string) => (src: string) => {
  const out = src.replace(needle, replacement);
  if (out === src) throw new Error(`needle not found: ${needle}`);
  return out;
};
const swapAll = (needle: string, replacement: string) => (src: string) => {
  if (!src.includes(needle)) throw new Error(`needle not found: ${needle}`);
  return src.split(needle).join(replacement);
};

const MUTATIONS: Record<Preset, Mutation[]> = {
  'aave-v3-flashloan-receiver': [
    { expect: [F.FLASHLOAN_CALLBACK_UNGATED, F.FLASHLOAN_IDLE_FUNDS], what: 'drop the initiator gate', apply: cut(/.*revert NotSelfInitiated.*\n/) },
    { expect: [F.FLASHLOAN_CALLBACK_UNGATED], what: 'drop the pool gate', apply: cut(/.*revert NotPool.*\n/) },
    { expect: [F.FLASHLOAN_ATTACKER_PARAMS, F.UNCHECKED_EXTERNAL_CALL], what: 'add a raw call from params', apply: swap('return true;', 'target.call(data);\n        return true;') },
    { expect: [F.UNCHECKED_EXTERNAL_CALL], what: 'drop SafeERC20', apply: cut(/.*using SafeERC20.*\n/) },
    { expect: [F.RISK_CAPS_AND_PAUSE_REVERTS], what: 'drop the pause guard', apply: swapAll('whenNotPaused', '') },
    { expect: [F.VAULT_NO_ESCAPE_HATCH], what: 'remove the escape hatch', apply: swap('function sweep(', 'function swp(') },
    { expect: [F.SWAP_MISSING_MIN_AMOUNT_OUT], what: 'drop the slippage floor', apply: cut(/.*revert MissingSlippageBound.*\n/) },
  ],
  'aave-v3-erc4626-vault': [
    { expect: [F.VAULT_ATOKEN_BALANCE_DENOMINATOR], what: 'balance as denominator', apply: swap('return _managedAssets;', 'return ATOKEN.balanceOf(address(this));') },
    { expect: [F.VAULT_ATOKEN_BALANCE_DENOMINATOR], what: 'drop virtual shares', apply: swapAll('_decimalsOffset', '_offsetX') },
    { expect: [F.VAULT_WITHDRAW_RETURN_IGNORED], what: 'ignore the withdraw return', apply: swap(/uint256 received = POOL\.withdraw\(([^;]*)\);/, 'POOL.withdraw($1);\n        uint256 received = assets;') },
    { expect: [F.VAULT_RECEIVER_OWNER_CONFLATED], what: 'conflate receiver and owner', apply: swap('super._withdraw(caller, receiver, owner,', 'super._withdraw(caller, receiver, receiver,') },
    { expect: [F.VAULT_REWARDS_UNCLAIMABLE], what: 'drop the reward claim', apply: cut(/.*\.claimAllRewards\(.*\n/) },
    { expect: [F.RISK_CAPS_AND_PAUSE_REVERTS], what: 'drop the pause guard', apply: (s) => swapAll('whenNotPaused', '')(swapAll('getSupplyCap', 'getX')(s)) },
    { expect: [F.VAULT_NO_ESCAPE_HATCH], what: 'remove the escape hatch', apply: swap('function sweep(', 'function swp(') },
    { expect: [F.UNCHECKED_EXTERNAL_CALL], what: 'drop SafeERC20', apply: cut(/.*using SafeERC20.*\n/) },
  ],
  'morpho-blue-vault': [
    { expect: [F.MORPHO_ASSETS_SHARES_EXCLUSIVE], what: 'pass shares alongside assets', apply: swapAll('SHARES_UNSET', 'shares') },
    { expect: [F.MORPHO_CALLBACK_UNGATED], what: 'pass callback data', apply: swapAll('NO_CALLBACK', 'callbackData') },
    { expect: [F.MORPHO_MARKET_PARAMS_UNPINNED], what: 'unpin the market', apply: swap('uint256 public immutable LLTV;', 'uint256 public LLTV;') },
    { expect: [F.VAULT_ATOKEN_BALANCE_DENOMINATOR], what: 'drop virtual shares', apply: swapAll('_decimalsOffset', '_offsetX') },
    { expect: [F.VAULT_WITHDRAW_RETURN_IGNORED], what: 'ignore the withdraw return', apply: swap(/\(withdrawn,\) =\s*\n\s*MORPHO\.withdraw\(([^;]*)\);/, 'MORPHO.withdraw($1);\n            withdrawn = assets;') },
    { expect: [F.VAULT_RECEIVER_OWNER_CONFLATED], what: 'conflate receiver and owner', apply: swap('super._withdraw(caller, receiver, owner,', 'super._withdraw(caller, receiver, receiver,') },
    { expect: [F.RISK_CAPS_AND_PAUSE_REVERTS], what: 'drop the pause guard', apply: swapAll('whenNotPaused', '') },
    { expect: [F.VAULT_NO_ESCAPE_HATCH], what: 'remove the escape hatch', apply: swap('function sweep(', 'function swp(') },
    { expect: [F.UNCHECKED_EXTERNAL_CALL], what: 'drop SafeERC20', apply: cut(/.*using SafeERC20.*\n/) },
  ],
  'compound-v3-vault': [
    { expect: [F.COMET_WITHDRAW_OPENS_BORROW], what: 'drop the position cap and borrow check', apply: (s) => cut(/.*revert PositionWentNegative.*\n/)(cut(/.*revert WithdrawExceedsPosition\(assets, held\);\n/)(s)) },
    { expect: [F.COMET_WITHDRAW_OPENS_BORROW], what: 'skip the base-token check', apply: swapAll('baseToken()', 'base_()') },
    { expect: [F.COMET_PRESENT_VALUE_ROUNDING], what: 'book the requested amount', apply: swap('_managedAssets += COMET.balanceOf(address(this)) - heldBefore;', '_managedAssets += assets;') },
    { expect: [F.COMET_REWARDS_UNCLAIMABLE], what: 'drop the claim path', apply: cut(/.*\.claimTo\(.*\n/) },
    { expect: [F.VAULT_ATOKEN_BALANCE_DENOMINATOR], what: 'balance as denominator', apply: swap('return _managedAssets;', 'return COMET.balanceOf(address(this));') },
    { expect: [F.VAULT_WITHDRAW_RETURN_IGNORED], what: 'stop measuring the payout', apply: swap(/COMET\.withdrawTo\(to, asset\(\), assets\);\s*\n\s*uint256 received = [^;]*;/, 'COMET.withdrawTo(to, asset(), assets);\n        received = assets;') },
    { expect: [F.VAULT_RECEIVER_OWNER_CONFLATED], what: 'conflate receiver and owner', apply: swap('super._withdraw(caller, receiver, owner,', 'super._withdraw(caller, receiver, receiver,') },
    { expect: [F.RISK_CAPS_AND_PAUSE_REVERTS], what: 'drop the pause guard', apply: (s) => swapAll('whenNotPaused', '')(swapAll('isSupplyPaused', 'isX')(s)) },
    { expect: [F.VAULT_NO_ESCAPE_HATCH], what: 'remove the escape hatch', apply: swap('function sweep(', 'function swp(') },
  ],
  'token-sale-launchpad': [
    { expect: [F.SALE_FUNDS_BEFORE_FINALIZE], what: 'let the raise out before finalize', apply: swap(/function withdrawRaised\(\)([^{]*)\{\s*\n\s*if \(!finalized\) revert NotFinalized\(\);\s*\n\s*if \(!succeeded\) revert SaleFailed\(\);/, 'function withdrawRaised()$1{') },
    { expect: [F.SALE_FUNDS_BEFORE_FINALIZE], what: 'add a treasury setter', apply: swap('function finalize()', 'function setTreasury(address t) external { }\n    function finalize()') },
    { expect: [F.SALE_CLAIM_BEFORE_FINALIZE], what: 'claim before finalize', apply: swap(/function claim\(\)([^{]*)\{\s*\n\s*if \(!finalized\) revert NotFinalized\(\);\s*\n\s*if \(!succeeded\) revert SaleFailed\(\);/, 'function claim()$1{') },
    { expect: [F.SALE_PUSH_REFUNDS_REENTRANCY], what: 'unguard refund', apply: swap(/(function refund\(\)[^{]*?)nonReentrant/, '$1') },
    { expect: [F.SALE_CAPS_UNENFORCED], what: 'drop the hard cap check', apply: cut(/.*revert HardCapExceeded.*\n/) },
    { expect: [F.SALE_WHITELIST_REPLAY], what: 'unbind the leaf from the sender', apply: swap('abi.encode(msg.sender)', 'abi.encode(proof[0])') },
    { expect: [F.SALE_PRICE_DECIMALS_MISMATCH], what: 'assume 18 decimals', apply: (s) => swapAll('TOKEN_UNIT', '1e18')(swap('10 ** IERC20Metadata(address(token_)).decimals()', '1e18')(s)) },
    { expect: [F.SALE_FEE_ON_TRANSFER_TOKEN], what: 'book the requested funding', apply: swap('uint256 received = TOKEN.balanceOf(address(this)) - before;', 'uint256 received = amount;') },
    { expect: [F.SALE_VESTING_MATH], what: 'drop the cliff', apply: swapAll('VESTING_CLIFF', '0') },
    { expect: [F.RISK_CAPS_AND_PAUSE_REVERTS], what: 'drop the pause guard', apply: swapAll('whenNotPaused', '') },
    { expect: [F.VAULT_NO_ESCAPE_HATCH], what: 'remove the escape hatch', apply: swap('function sweep(', 'function swp(') },
  ],
  'bonding-curve-launchpad': [
    { expect: [F.CURVE_TRANSFERS_BEFORE_GRADUATION], what: 'unlock transfers', apply: swap('!ILaunch(LAUNCH).graduated()', 'false') },
    { expect: [F.CURVE_PAIR_PRESEEDED, F.CURVE_LP_RETAINED], what: 'graduate through the router', apply: swap('uint256 liquidity = IUniswapV2Pair(PAIR).mint(DEAD);', 'uint256 liquidity = IRouter(ROUTER).addLiquidityETH(address(TOKEN), tokensForPool, 0, 0, DEAD, block.timestamp);') },
    { expect: [F.CURVE_NO_SLIPPAGE_OR_DEADLINE], what: 'drop the deadline', apply: swapAll('deadline', 'dl') },
    { expect: [F.CURVE_SELL_REENTRANCY], what: 'unguard sell', apply: swap(/(function sell\([^{]*?)nonReentrant/, '$1') },
    { expect: [F.CURVE_ROUNDING_FAVOURS_TRADER], what: 'floor the residual reserve', apply: swapAll('_ceilDiv', '_div') },
    { expect: [F.CURVE_LP_RETAINED], what: 'keep the LP', apply: swap('.mint(DEAD)', '.mint(owner())') },
    { expect: [F.CURVE_NO_WALLET_CAP], what: 'drop the wallet cap', apply: cut(/.*revert WalletCapExceeded.*\n/) },
    { expect: [F.CURVE_TRADING_AFTER_GRADUATION], what: 'keep trading after graduation', apply: swapAll('if (graduated) revert CurveGraduated();', '') },
    { expect: [F.RISK_CAPS_AND_PAUSE_REVERTS], what: 'drop the pause guard', apply: swapAll('whenNotPaused', '') },
  ],
};

let bad = 0;
const fired = (src: string, p: Preset) =>
  audit(src, p).findings.filter((f) => f.status === 'triggered').map((f) => f.id as FindingId).sort();

for (const preset of PRESET_LIST) {
  const src = printPreset(PRESET_DEFAULTS[preset]);
  const clean = fired(src, preset);
  console.log(`\n${preset}: clean -> ${clean.length ? clean.join(', ') : 'nothing triggered'}`);
  if (clean.length) bad++;
  for (const m of MUTATIONS[preset]) {
    let mutated: string;
    try {
      mutated = m.apply(src);
    } catch (e) {
      console.log(`  SETUP-FAIL ${m.what}: ${(e as Error).message}`);
      bad++;
      continue;
    }
    const got = fired(mutated, preset);
    const want = [...m.expect].sort();
    const ok = got.join() === want.join();
    if (!ok) bad++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${m.what.padEnd(40)} -> ${got.join(', ') || '-'}${ok ? '' : `   (wanted ${want.join(', ')})`}`);
  }
}
process.exit(bad ? 1 : 0);
