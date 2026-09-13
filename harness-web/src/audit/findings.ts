import {
  FINDING_IDS,
  FINDING_TITLES,
  SEVERITY_BY_FINDING,
  type Finding,
  type FindingId,
  type Preset,
} from '@/types';

/**
 * The findings corpus: every documented integration bug the generators harden
 * against, with the rules the audit engine uses to decide whether a given source
 * still mitigates it.
 *
 * Rules describe the CONCEPT of a mitigation, not the generator's own identifier
 * for it, because the audit runs on code the user has edited or pasted. Where the
 * risky operation is optional, an absence rule is written as
 * `(mitigation)|^(?![\s\S]*trigger)` — mitigated, or not exposed at all — so a
 * contract that never touches an oracle is not asked for oracle scaling.
 *
 * Every rule is mutation-tested (`npm run verify`): the clean output of each
 * preset triggers nothing, and removing one mitigation triggers exactly the
 * finding that names it.
 */

const FLASH: Preset[] = ['aave-v3-flashloan-receiver'];
const AAVE_VAULT: Preset[] = ['aave-v3-erc4626-vault'];
const MORPHO: Preset[] = ['morpho-blue-vault'];
const COMPOUND: Preset[] = ['compound-v3-vault'];
const SALE: Preset[] = ['token-sale-launchpad'];
const CURVE: Preset[] = ['bonding-curve-launchpad'];
const AAVE: Preset[] = [...FLASH, ...AAVE_VAULT];
const VAULTS: Preset[] = [...AAVE_VAULT, ...MORPHO, ...COMPOUND];
const LAUNCHPADS: Preset[] = [...SALE, ...CURVE];
const ALL: Preset[] = [...AAVE, ...MORPHO, ...COMPOUND, ...LAUNCHPADS];

const REGISTRY = 'https://github.com/sanbir/evm-hack-registry';
const DHL = 'https://github.com/SunWeb3Sec/DeFiHackLabs';

type Rule = Finding['detect'][number];
const absence = (pattern: string, appliesTo: Preset[]): Rule => ({ kind: 'absence', pattern, appliesTo });
const regex = (pattern: string, appliesTo: Preset[]): Rule => ({ kind: 'regex', pattern, appliesTo });

function finding(
  id: FindingId,
  rest: Omit<Finding, 'id' | 'title' | 'severity'>,
): Finding {
  return { id, title: FINDING_TITLES[id], severity: SEVERITY_BY_FINDING[id], ...rest };
}

/** `balanceOf(address(this)) - <something>Before`: the position was measured, not assumed. */
const MEASURED_DELTA = 'balanceOf\\s*\\(.*?\\)\\s*-\\s*\\w*[bB]efore';

export const FINDINGS: Finding[] = [
  // ------------------------------------------------------------------ Aave
  finding(FINDING_IDS.FLASHLOAN_CALLBACK_UNGATED, {
    vulnClasses: ['vuln/access-control/missing-auth', 'vuln/logic/missing-check'],
    summary:
      'Anyone can call Pool.flashLoan naming your contract as receiver, so Aave invokes your callback for them.',
    detail:
      'Checking msg.sender == Pool is not sufficient, because the Pool genuinely is the caller. The loan must additionally be one this contract initiated, which means asserting initiator == address(this). Without that second gate an attacker drives your callback with parameters of their choosing.',
    incidents: [
      {
        name: 'DODO MarginTrading (Sherlock #150)',
        url: 'https://github.com/sherlock-audit/2023-01-derby-judging/issues/150',
        pocFolder: '2021-03-dodo_flashloan_exp',
      },
      { name: 'Mimo SuperVault (Code4rena H-02)', url: 'https://code4rena.com/reports/2022-08-mimo' },
    ],
    detect: [
      absence('initiator\\s*[!=]=\\s*address\\(\\s*this\\s*\\)', FLASH),
      absence('msg\\.sender\\s*[!=]=\\s*address\\(\\s*(POOL|pool|_pool|_POOL)\\s*\\)', FLASH),
    ],
    remediation: 'Revert unless msg.sender == address(POOL) AND initiator == address(this).',
  }),
  finding(FINDING_IDS.FLASHLOAN_ATTACKER_PARAMS, {
    vulnClasses: ['vuln/dependency/unsafe-external-call', 'vuln/input-validation/missing-validation'],
    summary: 'Decoding `params` into a call target turns an ungated callback from a revert into a drain.',
    detail:
      'The common tutorial pattern decodes params as (address target, bytes data) and calls it, often after approving the target for the full balance. Decoding into a fixed struct with no bytes payload and no address-to-call removes the primitive entirely.',
    incidents: [
      { name: 'Mimo SuperVault aggregatorSwap(dexTxData)', url: 'https://code4rena.com/reports/2022-08-mimo' },
    ],
    detect: [
      regex('(\\)|\\w)\\s*\\.\\s*call\\s*(\\{[^}]*\\})?\\s*\\(', FLASH),
      regex('approve\\(\\s*\\w+\\s*,\\s*type\\(\\s*uint256\\s*\\)\\.max\\s*\\)', FLASH),
    ],
    remediation: 'Decode params into a strictly typed struct. Never derive a call target from it.',
  }),
  finding(FINDING_IDS.VAULT_ATOKEN_BALANCE_DENOMINATOR, {
    vulnClasses: ['vuln/arithmetic/rounding', 'vuln/defi/fee-manipulation'],
    summary:
      'The market position is donatable (aToken transfer, Morpho supply-on-behalf, Comet supplyTo), so a live balance as denominator lets anyone move the share price.',
    detail:
      'A vault whose totalAssets() reads its own position can be inflated by anyone willing to add to that position, and none of the three markets require touching the vault to do so. Internal accounting plus a decimals offset closes both the donation and the empty-vault rounding attack.',
    incidents: [
      { name: 'PoolTogether AaveV3YieldSource (Code4rena H-01)', url: 'https://code4rena.com/reports/2022-06-poolTogether' },
      { name: 'Thetanuts vault share rounding', url: REGISTRY, pocFolder: '2026-04-ThetanutsVaultShareRounding_exp' },
      { name: 'Generic ERC-4626 vault exploit PoC', url: REGISTRY, pocFolder: '2026-06-Vault4626_exp' },
    ],
    detect: [
      regex(
        'function\\s+totalAssets\\s*\\([^)]*\\)[^{]*\\{[^}]*(balanceOf\\s*\\(\\s*address\\s*\\(\\s*this|expectedSupplyAssets)',
        VAULTS,
      ),
      absence('(_decimalsOffset|_VIRTUAL_SHARES|virtualShares|_DEAD_SHARES|DEAD_SHARES)', VAULTS),
    ],
    remediation: 'Track assets internally and override _decimalsOffset() to a non-zero value.',
  }),
  finding(FINDING_IDS.VAULT_WITHDRAW_RETURN_IGNORED, {
    vulnClasses: ['vuln/logic/state-update', 'vuln/dependency/unchecked-return-value'],
    summary: 'The market pays out what it can, which is less than requested when the reserve is constrained.',
    detail:
      'A capped, frozen, paused or simply illiquid reserve pays out less than asked. Booking the requested figure credits assets that were never received, and the shortfall is discovered by whoever exits last. Use the amount returned (Aave, Morpho) or measure the balance delta (Comet returns nothing).',
    incidents: [
      { name: 'Connext Amarok (Code4rena M-15)', url: 'https://code4rena.com/reports/2022-06-connext' },
    ],
    detect: [
      absence('uint256\\s+\\w+\\s*=\\s*\\w*(POOL|pool)\\w*\\.withdraw\\s*\\(', AAVE_VAULT),
      regex('(^|[;{}])\\s*\\w*(POOL|pool)\\w*\\.withdraw\\s*\\([^;]*\\)\\s*;', AAVE_VAULT),
      absence('\\(\\s*uint256\\s+\\w+\\s*,\\s*\\)\\s*=\\s*\\w*(MORPHO|morpho)\\w*\\.withdraw\\s*\\(', MORPHO),
      regex('(^|[;{}])\\s*\\w*(MORPHO|morpho)\\w*\\.withdraw\\s*\\(', MORPHO),
      absence('withdraw(To)?\\s*\\([^;]*\\);\\s*\\n\\s*uint256\\s+\\w*(received|paid|got|out)\\w*\\s*=', COMPOUND),
    ],
    remediation: 'Use the amount the market says it paid, never the amount requested.',
  }),
  finding(FINDING_IDS.RISK_ENGINE_REIMPLEMENTED, {
    vulnClasses: ['vuln/logic/incorrect-state-transition', 'vuln/defi/liquidation'],
    summary: "Re-implementing Aave's risk checks more permissively than Aave opens positions Aave would refuse.",
    detail:
      'eMode, isolation, siloed borrowing, debt ceilings, LTV-0 and the pause/freeze bitmap are all enforced inside the Pool. A contract that borrows must read the health factor from Aave rather than compute its own.',
    incidents: [
      { name: 'Spearbit — Morpho-Aave v3 risk-parameter divergence', url: 'https://github.com/spearbit/portfolio' },
      { name: 'MorphoBlue exploit PoC', url: REGISTRY, pocFolder: '2024-10-MorphoBlue_exp' },
    ],
    detect: [
      absence(
        '(getUserAccountData|healthFactor|HEALTH_FACTOR)|^(?![\\s\\S]*\\b(borrow|setUserEMode|setUserUseReserveAsCollateral)\\s*\\()',
        AAVE,
      ),
    ],
    remediation: 'If you borrow, read getUserAccountData() and act on the health factor Aave reports.',
  }),
  finding(FINDING_IDS.RISK_LTV0_POISON_DUST, {
    vulnClasses: ['vuln/dos/frozen-funds', 'vuln/logic/missing-check'],
    summary: 'One wei of a zero-LTV aToken, pushed by anyone, can block withdrawals from a borrowing account.',
    detail:
      'Aave enforces the zero-LTV rule while the account carries debt. aTokens are freely transferable, so the dust costs the attacker nothing. A supply-only integration is unaffected; any integration needs a gated escape hatch to move the dust out.',
    incidents: [
      { name: 'StErMi — Aave v3 LTV-0 bug bounty', url: 'https://immunefi.com/bug-bounty/aave/' },
      { name: 'ChainSecurity — Grove ALM zero-LTV review', url: 'https://chainsecurity.com/audits/' },
    ],
    detect: [
      absence(
        '(getConfiguration|ReserveConfiguration|getLtv|zeroLtv|LTV_ZERO|function\\s+(sweep|rescue|rescueTokens|recoverERC20)\\s*\\()|^(?![\\s\\S]*\\bwithdraw\\s*\\()',
        AAVE,
      ),
    ],
    remediation: 'Keep a gated sweep so foreign aTokens can leave, and never borrow against unverified collateral.',
  }),
  finding(FINDING_IDS.ORACLE_EMODE_PRICE_SOURCE, {
    vulnClasses: ['vuln/oracle/wrong-feed', 'vuln/logic/missing-check'],
    summary: 'In eMode Aave may price through a category price source; a contract that reads the base oracle disagrees with the Pool.',
    detail:
      'If you read prices, read them the way the Pool does: check the user eMode category and its price source before using getAssetPrice().',
    incidents: [
      { name: 'Spearbit — eMode price source handling', url: 'https://github.com/spearbit/portfolio' },
    ],
    detect: [
      absence(
        '(getUserEMode|getEModeCategoryData|priceSource)|^(?![\\s\\S]*(getAssetPrice|getPriceOracle|IAaveOracle|IPriceOracle))',
        AAVE,
      ),
    ],
    remediation: 'Resolve the eMode category and its price source before pricing.',
  }),
  finding(FINDING_IDS.VAULT_REWARDS_UNCLAIMABLE, {
    vulnClasses: ['vuln/logic/missing-check'],
    summary: 'Aave base yield is not incentives; without a claim path emissions are lost forever.',
    detail:
      'Rewards accrue to whoever holds the aToken. The claim call must be passed aToken and debtToken addresses, not the underlyings — a mistake that silently claims nothing.',
    incidents: [
      { name: 'Float Capital (Code4rena M-05)', url: 'https://code4rena.com/reports/2022-05-backd' },
      { name: 'Alchemix V3 (Immunefi #57812)', url: 'https://immunefi.com/bug-bounty/alchemix/' },
      { name: 'Rewards unredeemable in an Aave strategy (registry PoC)', url: REGISTRY, pocFolder: '27531-h-41-rewards-compounded-in-aavestrategy-are-unredeemable-cod_exp' },
    ],
    detect: [absence('\\.claim(All)?Rewards\\s*\\(|^(?![\\s\\S]*\\bsupply\\s*\\()', AAVE)],
    remediation: 'Expose a gated claim that forwards aToken addresses to the RewardsController.',
  }),
  finding(FINDING_IDS.VAULT_NO_ESCAPE_HATCH, {
    vulnClasses: ['vuln/dos/frozen-funds'],
    summary: 'Merkl rewards, airdrops and dust arrive unannounced and are stuck without a hatch.',
    detail:
      'The hatch itself must be access-controlled and must exclude the principal — otherwise the recovery function is the vulnerability.',
    incidents: [
      { name: 'Morpho integration checklist', url: 'https://docs.morpho.org/overview/resources/audits/' },
    ],
    detect: [absence('function\\s+(sweep|rescue|rescueTokens|recoverERC20|skim)\\s*\\(', [...AAVE, ...MORPHO, ...COMPOUND, ...SALE])],
    remediation: 'Add a gated sweep that cannot touch principal.',
  }),
  finding(FINDING_IDS.RISK_CAPS_AND_PAUSE_REVERTS, {
    vulnClasses: ['vuln/logic/missing-check', 'vuln/dos/frozen-funds'],
    summary: 'Markets revert when capped, frozen or paused, and callers that assume otherwise brick.',
    detail:
      'Supply and borrow caps, freeze and pause flags all cause the market to revert mid-flow. A local pause lets an operator stop cleanly; honest ERC-4626 limits (maxDeposit returning 0) let integrators see the condition before they hit it.',
    incidents: [
      { name: 'Sherlock Index #267', url: 'https://github.com/sherlock-audit/2023-01-index-judging/issues/267' },
    ],
    detect: [absence('(whenNotPaused|_requireNotPaused|isSupplyPaused|getSupplyCap|supplyCap)', ALL)],
    remediation: 'Add a local pause and report market conditions through the ERC-4626 limits.',
  }),
  finding(FINDING_IDS.VAULT_RECEIVER_OWNER_CONFLATED, {
    vulnClasses: ['vuln/access-control/missing-auth', 'vuln/logic/state-update'],
    summary: 'redeem(shares, receiver, owner) burns from owner and pays receiver; mixing them steals.',
    detail:
      'Overriding the public entry points rather than the internal _deposit/_withdraw hooks is the usual way this gets broken, because the caller/receiver/owner split is re-implemented by hand.',
    incidents: [
      { name: 'Taichi ERC-4626 series, Pt.5', url: 'https://docs.openzeppelin.com/contracts/5.x/erc4626' },
      { name: 'ERC-4626 vault exploit PoC', url: REGISTRY, pocFolder: '2026-06-Vault4626_exp' },
    ],
    detect: [
      absence('super\\._withdraw\\(\\s*caller\\s*,\\s*receiver\\s*,\\s*owner', VAULTS),
      regex('_burn\\(\\s*receiver\\s*,', VAULTS),
    ],
    remediation: 'Override _deposit/_withdraw and delegate to super with the arguments unchanged.',
  }),
  finding(FINDING_IDS.ORACLE_SCALE_MISMATCH, {
    vulnClasses: ['vuln/oracle/price-manipulation', 'vuln/arithmetic/decimal-mismatch'],
    summary: 'Aave prices in 8-decimal base currency units; treating them as 18-decimal mis-sizes every borrow.',
    detail: 'Scale by BASE_CURRENCY_UNIT and the asset decimals before comparing a price to a token amount.',
    incidents: [
      { name: 'UwuLend oracle pricing exploit PoC', url: REGISTRY, pocFolder: '2024-06-UwuLend_First_exp' },
    ],
    detect: [
      absence(
        '(BASE_CURRENCY_UNIT|_scalePrice|10\\s*\\*\\*|\\.decimals\\(\\))|^(?![\\s\\S]*(getAssetPrice|getPriceOracle|IAaveOracle|IPriceOracle))',
        AAVE,
      ),
    ],
    remediation: 'Normalise oracle prices by BASE_CURRENCY_UNIT and token decimals.',
  }),
  finding(FINDING_IDS.FLASHLOAN_IDLE_FUNDS, {
    vulnClasses: ['vuln/logic/missing-check'],
    summary: "A balance left on the receiver is repayment for somebody else's flash loan.",
    detail:
      "An attacker initiates a loan naming your contract as receiver and simply lets your balance cover principal and premium. Aave's own documentation warns about this directly. Gating initiation and holding no balance between calls are the mitigations.",
    incidents: [
      { name: 'Aave flash-loan documentation; ESE 92391', url: 'https://aave.com/docs/developers/smart-contracts/flash-loans' },
      { name: 'Aave repay-adapter registry PoC', url: REGISTRY, pocFolder: '2024-08-AAVE_Repay_Adapter' },
    ],
    detect: [
      absence('(_assertNoIdleFunds|noIdleFunds|IdleFundsForbidden|balanceBefore|initiator\\s*[!=]=\\s*address\\(\\s*this\\s*\\))', FLASH),
    ],
    remediation: 'Restrict initiation and do not leave the underlying on the receiver between loans.',
  }),
  finding(FINDING_IDS.SWAP_MISSING_MIN_AMOUNT_OUT, {
    vulnClasses: ['vuln/defi/slippage', 'vuln/defi/sandwich'],
    summary: 'A swap with no floor on output is a free sandwich for any searcher.',
    detail:
      'Slippage is the single most tagged DeFi class in the exploit corpus at 120 instances. A caller-supplied minAmountOut that is never checked against zero is equivalent to having none at all.',
    incidents: [
      { name: 'vuln/defi/slippage — 120 tagged PoCs', url: REGISTRY },
      { name: 'Aave strategy swapper misconfiguration PoC', url: REGISTRY, pocFolder: '27529-h-39-aavestrategysol-changing-swapper-breaks-the-contract-co_exp' },
    ],
    detect: [
      absence('(revert\\s+MissingSlippageBound|minAmountOut\\s*==\\s*0|amountOutMin\\w*\\s*==\\s*0|require\\s*\\(\\s*\\w*[mM]in\\w*Out\\w*\\s*[>!])|^(?![\\s\\S]*\\b(router|Router|swap)\\b)', FLASH),
      regex('(amountOutMinimum|amountOutMin|minAmountOut|minOut)\\s*[:=,]\\s*0\\b', FLASH),
    ],
    remediation: 'Require a non-zero minAmountOut and enforce it against the amount received.',
  }),
  finding(FINDING_IDS.UNCHECKED_EXTERNAL_CALL, {
    vulnClasses: ['vuln/dependency/unchecked-return-value'],
    summary: 'Non-standard ERC20s return false rather than reverting, so a bare transfer can silently do nothing.',
    detail:
      'USDT and others do not return a bool at all. SafeERC20 normalises both cases; a raw transfer or approve does not, and the failure is silent.',
    incidents: [
      { name: 'vuln/dependency/unchecked-return-value — 90 tagged PoCs', url: REGISTRY },
      { name: 'Aave portal loan repayment not enforced (registry PoC)', url: REGISTRY, pocFolder: '25134-h-05-routers-are-not-enforced-to-repay-aave-portal-loan-code_exp' },
    ],
    detect: [
      absence('using\\s+SafeERC20', ALL),
      regex('(^|\\n)\\s*[A-Za-z_][\\w.\\[\\]()]*\\.\\s*call\\s*(\\{[^}]*\\})?\\s*\\([^;]*\\)\\s*;', ALL),
    ],
    remediation: 'Route every token interaction through SafeERC20 and check every low-level call.',
  }),

  // ---------------------------------------------------------------- Morpho
  finding(FINDING_IDS.MORPHO_ASSETS_SHARES_EXCLUSIVE, {
    vulnClasses: ['vuln/input-validation/missing-validation', 'vuln/logic/rounding'],
    summary: 'supply/withdraw take BOTH an assets and a shares argument, and exactly one must be zero.',
    detail:
      'Setting both, or neither, reverts with "inconsistent input". Which one you pass also decides the rounding direction: supplying by assets converts to shares rounding DOWN, so withdrawing that same asset figure converts back rounding UP and asks for more shares than the position holds. That underflows inside Morpho rather than in your contract, which is why it survives a unit-test suite built on mocks.',
    incidents: [{ name: 'Morpho Blue ErrorsLib.INCONSISTENT_INPUT', url: 'https://docs.morpho.org/' }],
    detect: [
      absence('\\.(supply|withdraw)\\s*\\([^;]*?,\\s*(0|SHARES_UNSET|ASSETS_UNSET|\\w*UNSET|\\w*[Zz]ero\\w*)\\s*,', MORPHO),
    ],
    remediation:
      'Name the zero argument so the intent is visible at every call site, and credit the position delta you measure rather than the amount you requested.',
  }),
  finding(FINDING_IDS.MORPHO_CALLBACK_UNGATED, {
    vulnClasses: ['vuln/access-control/missing-auth', 'vuln/reentrancy/cross-contract'],
    summary: 'A non-empty `data` argument makes Morpho call back into your contract mid-transaction.',
    detail:
      'Morpho supply/repay/supplyCollateral/flashLoan re-enter the caller when data is non-empty. An implemented-but-ungated callback is the same Critical that drained DODO on Aave: the attacker drives it with parameters of their choosing while the position is half-updated. Passing empty bytes and implementing no callback removes the entry point rather than guarding it.',
    incidents: [
      { name: 'DODO MarginTrading (Sherlock #150) — same shape, Aave flashLoan', url: 'https://github.com/sherlock-audit/2023-01-derby-judging/issues/150', pocFolder: '2021-03-dodo_flashloan_exp' },
    ],
    detect: [
      absence('\\.(supply|withdraw|repay|supplyCollateral)\\s*\\([^;]*(NO_CALLBACK|""|hex"")\\s*\\)', MORPHO),
      absence('msg\\.sender\\s*[!=]=\\s*address\\(\\s*(MORPHO|morpho)\\w*\\s*\\)|^(?![\\s\\S]*function\\s+onMorpho)', MORPHO),
    ],
    remediation:
      'Pass empty bytes. If you must implement a callback, require msg.sender == address(MORPHO) and assert the transaction was self-initiated.',
  }),
  finding(FINDING_IDS.MORPHO_MARKET_PARAMS_UNPINNED, {
    vulnClasses: ['vuln/access-control/missing-auth', 'vuln/input-validation/missing-validation'],
    summary: 'A Morpho market IS the hash of its five parameters, so accepting them per call lets a caller repoint the vault.',
    detail:
      'Morpho identifies a market by keccak(loanToken, collateralToken, oracle, irm, lltv). A vault that takes those per call can be aimed at a market with a different oracle or a different LLTV while every function signature stays identical. Pinning them as immutables makes the market fixed for the vault lifetime.',
    incidents: [{ name: 'Morpho Blue MarketParamsLib', url: 'https://docs.morpho.org/' }],
    detect: [
      absence('(immutable\\s+\\w*(LLTV|lltv)|MarketParams\\s+(public\\s+|internal\\s+)?immutable|Id\\s+(public\\s+|internal\\s+)?immutable)', MORPHO),
    ],
    remediation:
      'Take the five fields as constructor arguments, store them as immutables, and expose marketParams() as a view that rebuilds the struct.',
  }),

  // -------------------------------------------------------------- Compound
  finding(FINDING_IDS.COMET_WITHDRAW_OPENS_BORROW, {
    vulnClasses: ['vuln/logic/missing-check', 'vuln/access-control/missing-auth'],
    summary: 'Comet.withdraw() past the supplied balance silently borrows, and anyone can gift the vault the collateral that makes it possible.',
    detail:
      'withdrawBase has no "amount <= balance" check; a negative result is a borrow, refused only if the account is not collateralized. supplyTo(vault, collateral, x) is permissionless, so an attacker can make the vault collateralized and wait for an accounting slip. Cap every withdraw at COMET.balanceOf(this) and assert borrowBalanceOf(this) == 0 afterwards; refuse an asset that is not the Comet base token, since supply() moves base and collateral through the same signature.',
    incidents: [
      { name: 'Comet withdrawBase source — NotCollateralized is the only guard', url: 'https://github.com/compound-finance/comet/blob/main/contracts/CometWithExtendedAssetList.sol' },
      { name: 'ChainSecurity Comet audit §5.1', url: 'https://reports.chainsecurity.com/Compound/ChainSecurity_Compound_Comet_Audit.pdf' },
    ],
    detect: [
      absence('(revert\\s+WithdrawExceedsPosition|assets\\s*>\\s*held|borrowBalanceOf\\s*\\(\\s*address\\s*\\(\\s*this)', COMPOUND),
      absence('baseToken\\s*\\(\\s*\\)', COMPOUND),
    ],
    remediation:
      'Cap withdrawals at COMET.balanceOf(address(this)), assert borrowBalanceOf(address(this)) == 0 after, and require asset == COMET.baseToken() at construction.',
  }),
  finding(FINDING_IDS.COMET_PRESENT_VALUE_ROUNDING, {
    vulnClasses: ['vuln/arithmetic/rounding', 'vuln/logic/state-update'],
    summary: 'Comet balances are present values that round down on every supply and withdraw; booking the requested amount drifts the book above the position.',
    detail:
      'Comet stores a principal and shows principal * index / 1e15, floored, on both conversions. supply(x) can credit x-1 and withdraw(x) can debit x+1. A vault that books x on each side ends up owing more than it holds, and the last redeemer fails inside Comet.',
    incidents: [
      { name: 'Code4rena 2023-07 Reserve M-13 — Comet moves 1-10 wei more than asked', url: 'https://code4rena.com/reports/2023-07-reserve' },
    ],
    detect: [absence('balanceOf\\s*\\(\\s*address\\s*\\(\\s*this\\s*\\)\\s*\\)\\s*-\\s*\\w*[bB]efore', COMPOUND)],
    remediation: 'Credit and debit the measured change in COMET.balanceOf(address(this)), and clamp the book to the position.',
  }),
  finding(FINDING_IDS.COMET_REWARDS_UNCLAIMABLE, {
    vulnClasses: ['vuln/logic/missing-check'],
    summary: 'COMP accrues to the Comet account — the vault — and only the account itself can claim it to a third party.',
    detail:
      'CometRewards.claimTo(comet, src, to, accrue) checks hasPermission(src, msg.sender). The vault is src, so the vault must make the call; nothing else can, short of allow()-ing a keeper, which also grants full withdraw and borrow power over the position.',
    incidents: [
      { name: 'CometRewards.claimTo permission check', url: 'https://github.com/compound-finance/comet/blob/main/contracts/CometRewards.sol' },
    ],
    detect: [absence('\\.claimTo\\s*\\(', COMPOUND)],
    remediation: 'Expose a gated claim that calls CometRewards.claimTo(address(COMET), address(this), to, true).',
  }),

  // ------------------------------------------------------------ Token sale
  finding(FINDING_IDS.SALE_FUNDS_BEFORE_FINALIZE, {
    vulnClasses: ['vuln/access-control/centralization', 'vuln/logic/incorrect-order-of-operations'],
    summary: 'Raised funds that can move before the sale has closed are a rug by construction and make refunds insolvent.',
    detail:
      'BetaPresale forwarded ETH the moment it arrived and let the owner change where. PartyDAO paid fees before refunds were settled. Escrow everything until a permissionless finalize has run and succeeded, and send it to an immutable treasury.',
    incidents: [
      { name: 'BetaPresale (May 2025)', url: `${DHL}/blob/main/src/test/2025-05/BetaPresale_exp.sol`, pocFolder: '2025-05-BetaPresale_exp' },
      { name: 'PartyDAO (Code4rena 2023-04, H-03)', url: 'https://code4rena.com/reports/2023-04-party' },
    ],
    detect: [
      // The function that releases the ETH must check the sale's outcome first. Named
      // by the common conventions; a sale that releases ETH under another name is
      // asked to rename it rather than trusted.
      absence(
        'function\\s+(withdrawRaised|withdrawFunds|withdrawEth|withdrawETH|withdrawProceeds|releaseFunds|claimRaised|forwardFunds)\\s*\\([^{]*\\{[^}]*(finalized|succeeded|Finalized|closed)',
        SALE,
      ),
      regex('function\\s+set\\w*(Treasury|Recipient|Wallet|Beneficiary)\\s*\\(', SALE),
    ],
    remediation: 'Gate every ETH withdrawal on a successful finalize and make the destination immutable.',
  }),
  finding(FINDING_IDS.SALE_CLAIM_BEFORE_FINALIZE, {
    vulnClasses: ['vuln/logic/incorrect-order-of-operations', 'vuln/logic/state-update'],
    summary: 'Tokens claimable before the sale closes are a flash-arbitrage against the pool; claims that are not tracked are claimable twice.',
    detail:
      'AISOTH Presale let a buyer claim in the same transaction and dump into the AMM below the sale price. Gate claims on a successful finalize and track the amount each wallet has taken.',
    incidents: [
      { name: 'AISOTH Presale (June 2026)', url: `${DHL}/blob/main/src/test/2026-06/AISOTHPresale_exp.sol`, pocFolder: '2026-06-AISOTHPresale_exp' },
    ],
    detect: [
      absence('function\\s+claim\\s*\\([^{]*\\{[^}]*(finalized|succeeded)', SALE),
      absence('claimed\\s*\\[', SALE),
    ],
    remediation: 'Require finalized && succeeded in claim() and subtract claimed[msg.sender] from the vested amount.',
  }),
  finding(FINDING_IDS.SALE_PUSH_REFUNDS_REENTRANCY, {
    vulnClasses: ['vuln/reentrancy/single-function', 'vuln/dos/griefing'],
    summary: 'Refunds pushed in a loop can be blocked by one reverting recipient; refunds paid before state is updated can be taken twice.',
    detail:
      'OpenZeppelin 2.x solved this with an escrow and pull-based refunds; the pattern was removed from the library, not fixed. Zero the balance, then transfer, under a reentrancy guard.',
    incidents: [
      { name: 'OpenZeppelin 2.x RefundableCrowdsale', url: 'https://github.com/OpenZeppelin/openzeppelin-contracts/blob/v2.5.1/contracts/crowdsale/distribution/RefundableCrowdsale.sol' },
      { name: 'Decent Crescendo (Feb 2026)', url: 'https://www.darknavy.org/web3/exploits/erc1155-bonding-curve-reentrancy/' },
    ],
    detect: [
      absence('function\\s+refund\\s*\\([^{]*nonReentrant', SALE),
      regex('for\\s*\\([^)]*\\)\\s*\\{[^}]*(refund|\\.call\\s*\\{\\s*value|\\.transfer\\s*\\()', SALE),
    ],
    remediation: 'Make refund() pull-based, zero the balance before the transfer, and guard it.',
  }),
  finding(FINDING_IDS.SALE_CAPS_UNENFORCED, {
    vulnClasses: ['vuln/logic/missing-check'],
    summary: 'A hard cap or per-wallet cap that is declared but not checked on every contribution is decoration.',
    detail:
      'The hard cap bounds what the sale can owe; the per-wallet cap is friction only, since a second wallet is free — BetaPresale was drained through 70 fresh contracts against a per-sender cap.',
    incidents: [
      { name: 'BetaPresale (May 2025)', url: `${DHL}/blob/main/src/test/2025-05/BetaPresale_exp.sol`, pocFolder: '2025-05-BetaPresale_exp' },
      { name: 'PartyDAO (Code4rena 2022-09, M-02)', url: 'https://code4rena.com/reports/2022-09-party' },
    ],
    detect: [absence('(\\+\\s*msg\\.value\\s*>\\s*\\w*(HARD_CAP|hardCap)|>\\s*\\w*(HARD_CAP|hardCap)\\w*\\s*\\)\\s*revert)', SALE)],
    remediation: 'Revert when totalRaised + msg.value exceeds the hard cap, on every contribution.',
  }),
  finding(FINDING_IDS.SALE_WHITELIST_REPLAY, {
    vulnClasses: ['vuln/auth/signature-replay', 'vuln/access-control/missing-auth'],
    summary: 'An allowlist proof or signature not bound to the caller can be presented by anyone who saw it.',
    detail:
      'vVv Launchpad verified the signed parameters but paid msg.sender, so a stranger could front-run a claim. Rova omitted the chain id. A Merkle leaf that is the sender, double-hashed, with the root held by this contract, cannot be replayed anywhere.',
    incidents: [
      { name: 'vVv Launchpad (Sherlock H-1)', url: 'https://github.com/sherlock-protocol/sherlock-reports/blob/main/audits/2024.11.17%20-%20Final%20-%20vVv%20Launchpad%20-%20Investments%20%26%20Token%20distribution%20Audit%20Report.pdf' },
      { name: 'Rova (Sherlock #421)', url: 'https://github.com/sherlock-audit/2025-02-rova-judging/issues/421' },
    ],
    detect: [
      absence('abi\\.encode(Packed)?\\(\\s*msg\\.sender|^(?![\\s\\S]*(MerkleProof|merkleRoot|whitelist|allowlist|ecrecover|ECDSA))', SALE),
    ],
    remediation: 'Bind the leaf or the signed message to msg.sender and to this contract.',
  }),
  finding(FINDING_IDS.SALE_PRICE_DECIMALS_MISMATCH, {
    vulnClasses: ['vuln/arithmetic/decimal-mismatch'],
    summary: 'Allocation math that assumes 18 decimals over- or under-pays every buyer of a 6-decimal token.',
    detail: 'Rova subtracted payment-token units from sale-token units. Read decimals() from the token and scale explicitly.',
    incidents: [{ name: 'Rova (Sherlock #537)', url: 'https://github.com/sherlock-audit/2025-02-rova-judging/issues/537' }],
    detect: [absence('(decimals\\s*\\(\\s*\\)|TOKEN_UNIT)', SALE)],
    remediation: 'Derive one whole token from decimals() and compute allocations against it.',
  }),
  finding(FINDING_IDS.SALE_FEE_ON_TRANSFER_TOKEN, {
    vulnClasses: ['vuln/logic/state-update', 'vuln/dependency/unsafe-external-call'],
    summary: 'A sale that books the tokens it asked for rather than the tokens that arrived can finalize owing more than it holds.',
    detail: 'Measure the balance delta when funding, and refuse to finalize as a success unless funded >= tokens owed.',
    incidents: [
      { name: 'Juicebox (Code4rena 2022-07, #304)', url: 'https://github.com/code-423n4/2022-07-juicebox-findings/issues/304' },
    ],
    detect: [absence(MEASURED_DELTA, SALE), absence('funded\\s*>=', SALE)],
    remediation: 'Book the measured delta on fund() and require funded >= tokensFor(totalRaised) to succeed.',
  }),
  finding(FINDING_IDS.SALE_VESTING_MATH, {
    vulnClasses: ['vuln/arithmetic/rounding', 'vuln/logic/incorrect-state-transition'],
    summary: 'Vesting that releases at the wrong boundary either pays early or strands the tail.',
    detail: 'Nothing before the cliff, linear after it, everything at the end; and the clock starts at finalization, not at the sale end.',
    incidents: [
      { name: 'Tokensoft (Sherlock M-2)', url: 'https://github.com/sherlock-protocol/sherlock-reports/blob/main/audits/2023.07.21%20-%20Final%20-%20Tokensoft%20Audit%20Report.pdf' },
    ],
    detect: [absence('(VESTING_CLIFF|cliff)|^(?![\\s\\S]*(vest|VEST))', SALE)],
    remediation: 'Gate on the cliff, scale linearly by elapsed / duration, and clamp at the end.',
  }),

  // --------------------------------------------------------- Bonding curve
  finding(FINDING_IDS.CURVE_TRANSFERS_BEFORE_GRADUATION, {
    vulnClasses: ['vuln/logic/missing-check', 'vuln/defi/price-manipulation'],
    summary: 'Tokens that can reach the DEX pair before graduation let anyone seed the pool at their own price.',
    detail:
      'Four.meme was drained twice and a family of pump clones once because curve tokens reached the pair early and the launchpad then added its liquidity into a pool the attacker had priced. Refuse every transfer that is not to or from the curve until graduation.',
    incidents: [
      { name: 'Four.meme (Feb 2025)', url: `${DHL}/blob/main/src/test/2025-02/FourMeme_exp.sol`, pocFolder: '2025-02-FourMeme_exp' },
      { name: 'Pump clone tokens (Mar 2025)', url: `${DHL}/blob/main/src/test/2025-03/Pump_exp.sol`, pocFolder: '2025-03-Pump_exp' },
      { name: 'Four.meme (Mar 2025)', url: 'https://www.quillaudits.com/blog/hack-analysis/four-meme-attack-analysis' },
    ],
    detect: [absence('function\\s+_(update|beforeTokenTransfer)\\s*\\([^{]*\\{[^}]*graduat', CURVE)],
    remediation: "Override the token's transfer hook to revert until the curve has graduated.",
  }),
  finding(FINDING_IDS.CURVE_PAIR_PRESEEDED, {
    vulnClasses: ['vuln/defi/price-manipulation', 'vuln/dos/griefing'],
    summary: 'Adding liquidity through the router quotes at whatever ratio the pair already holds, and createPair reverts if the pair exists.',
    detail:
      'Create the pair in the constructor so the launch owns it from block zero, and mint liquidity on the pair directly: the pair prices a first mint from the amounts transferred in, so a pre-seeded WETH balance becomes depth rather than price.',
    incidents: [
      { name: 'Four.meme (Feb 2025)', url: 'https://www.chaincatcher.com/en/article/2167296' },
      { name: 'Virtuals Protocol (Code4rena 2025-04, M-01)', url: 'https://code4rena.com/reports/2025-04-virtuals-protocol' },
    ],
    detect: [
      absence('createPair', CURVE),
      absence('Pair\\s*\\([^)]*\\)\\s*\\.mint\\s*\\(', CURVE),
      regex('addLiquidity(ETH)?\\s*\\(', CURVE),
    ],
    remediation: 'Create the pair at deployment and call pair.mint() directly; never route graduation through addLiquidity.',
  }),
  finding(FINDING_IDS.CURVE_NO_SLIPPAGE_OR_DEADLINE, {
    vulnClasses: ['vuln/defi/slippage', 'vuln/defi/sandwich'],
    summary: 'A buy or sell with no floor on output and no deadline is a free sandwich.',
    detail: 'Both bounds, on both sides of the curve, checked against the actual output rather than computed at execution time.',
    incidents: [
      { name: 'Virtuals Protocol (Code4rena 2025-04, M-02/M-03)', url: 'https://code4rena.com/reports/2025-04-virtuals-protocol' },
      { name: 'Lambo.win (Code4rena 2024-12, M-03)', url: 'https://code4rena.com/reports/2024-12-lambowin' },
    ],
    detect: [
      absence('(minTokensOut|minEthOut|minAmountOut|amountOutMin)', CURVE),
      absence('deadline', CURVE),
    ],
    remediation: 'Take minOut and deadline on buy() and sell() and revert when either is violated.',
  }),
  finding(FINDING_IDS.CURVE_SELL_REENTRANCY, {
    vulnClasses: ['vuln/reentrancy/single-function'],
    summary: 'An ETH payout made before state is final can be re-entered from receive().',
    detail: 'Decent Crescendo paid ETH and only then updated the price. Effects first, then interactions, under a reentrancy guard.',
    incidents: [
      { name: 'Decent Crescendo (Feb 2026)', url: 'https://www.darknavy.org/web3/exploits/erc1155-bonding-curve-reentrancy/' },
    ],
    detect: [absence('function\\s+sell\\s*\\([^{]*nonReentrant', CURVE), absence('function\\s+buy\\s*\\([^{]*nonReentrant', CURVE)],
    remediation: 'Guard buy(), sell() and fee withdrawals, and write state before sending ETH.',
  }),
  finding(FINDING_IDS.CURVE_ROUNDING_FAVOURS_TRADER, {
    vulnClasses: ['vuln/arithmetic/rounding'],
    summary: 'Curve math that rounds the output up, or that pays out differently for a split sale, leaks value to the trader.',
    detail: 'Round the residual reserve up so every output is floored, and keep the constant product as a constant rather than recomputing it from rounded state.',
    incidents: [
      { name: 'USM/FUM (Aug 2026)', url: DHL, pocFolder: '2026-08-USM_exp' },
      { name: 'Uniswap V2 getAmountOut floors the output', url: 'https://github.com/Uniswap/v2-periphery/blob/master/contracts/libraries/UniswapV2Library.sol' },
    ],
    detect: [absence('(ceilDiv|_ceilDiv|Rounding\\.Ceil|mulDivUp|divUp)', CURVE)],
    remediation: 'Compute the residual reserve with a ceiling division on both buy and sell.',
  }),
  finding(FINDING_IDS.CURVE_LP_RETAINED, {
    vulnClasses: ['vuln/access-control/centralization'],
    summary: 'LP tokens held by a deployer, or by a locker with an admin, are a rug waiting for a key.',
    detail: 'DxSale\'s locker had an owner-only backdoor; pump.fun\'s insider used a privileged withdraw. Mint the LP to the dead address in the graduation transaction.',
    incidents: [
      { name: 'DxSale legacy locker (May 2026)', url: `${DHL}/blob/main/src/test/2026-05/DxSale_exp.sol`, pocFolder: '2026-05-DxSale_exp' },
      { name: 'pump.fun (May 2024)', url: 'https://www.theblock.co/post/295029/pump-fun-post-mortem' },
    ],
    detect: [
      absence('\\.mint\\s*\\(\\s*(DEAD|BURN|0x0{35,}[dD][eE][aA][dD]|address\\s*\\(\\s*0xdead\\s*\\))', CURVE),
      regex('\\.mint\\s*\\(\\s*(owner\\s*\\(\\s*\\)|msg\\.sender|feeRecipient|treasury|TREASURY)', CURVE),
    ],
    remediation: 'Mint graduation liquidity to 0x000000000000000000000000000000000000dEaD.',
  }),
  finding(FINDING_IDS.CURVE_NO_WALLET_CAP, {
    vulnClasses: ['vuln/defi/fair-launch'],
    summary: 'Without a per-wallet cap a single buyer can take the curve in one transaction.',
    detail: 'Friction, not security — a second wallet is free — which is why the transfer lock is what actually protects graduation.',
    incidents: [
      { name: 'PartyDAO (Code4rena 2022-09, M-02)', url: 'https://code4rena.com/reports/2022-09-party' },
    ],
    detect: [absence('(revert\\s+WalletCapExceeded|>\\s*\\w*(MAX_WALLET|maxWallet|walletCap))', CURVE)],
    remediation: 'Cap what a wallet may hold while the curve is open.',
  }),
  finding(FINDING_IDS.CURVE_TRADING_AFTER_GRADUATION, {
    vulnClasses: ['vuln/logic/incorrect-state-transition'],
    summary: 'A curve that keeps trading after graduation prices against a pool it no longer backs.',
    detail: 'Graduate inside the buy that crosses the threshold, refund the overshoot, and refuse every trade afterwards. There must be no admin path to the reserves at any point.',
    incidents: [
      { name: 'Virtuals Protocol (Code4rena 2025-04, M-04)', url: 'https://code4rena.com/reports/2025-04-virtuals-protocol' },
    ],
    detect: [absence('(revert\\s+CurveGraduated|require\\s*\\(\\s*!\\s*graduated|if\\s*\\(\\s*graduated\\s*\\)\\s*revert)', CURVE)],
    remediation: 'Set graduated inside the crossing buy and check it first in buy() and sell().',
  }),
];
