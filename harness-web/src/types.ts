/**
 * ██ SHARED INTERFACE CONTRACT ██
 *
 * One source of truth, copied verbatim into both apps:
 *   harness-web/src/types.ts
 *   harness-api/src/types.ts
 *
 * Every change here is additive: a preset, a finding ID or an option is only ever
 * added, never renamed or removed, so a consumer that was built against an older
 * copy keeps working. `npm run sync:shared` (harness-web) copies this file out, and runs before every build.
 *
 * Covers:
 *   1. the HTTP wire format          -> the interfaces below
 *   2. the preset catalogue          -> PRESET_LIST / PRESET_CATEGORY
 *   3. the finding ID vocabulary     -> FINDING_IDS
 *   4. remappings + import paths     -> REMAPPINGS / IMPORT_PATHS
 *   5. API base URL + route names    -> API_ROUTES
 */

// ---------------------------------------------------------------------------
// 1. Presets
// ---------------------------------------------------------------------------

export type Preset =
  // Vaults — ERC-4626 over a lending market.
  | 'aave-v3-erc4626-vault'
  | 'morpho-blue-vault'
  | 'compound-v3-vault'
  // Launchpads — token distribution.
  | 'token-sale-launchpad'
  | 'bonding-curve-launchpad'
  // Flash-loan receivers.
  | 'aave-v3-flashloan-receiver';

/**
 * The single enumeration of Preset. Every whitelist derives from this.
 *
 * A const array typed as Preset[] fails to compile if a member is dropped, and
 * cannot silently go stale when one is added — which is what happened when the
 * union grew and three hand-written copies of it did not.
 */
export const PRESET_LIST: Preset[] = [
  'aave-v3-erc4626-vault',
  'morpho-blue-vault',
  'compound-v3-vault',
  'token-sale-launchpad',
  'bonding-curve-launchpad',
  'aave-v3-flashloan-receiver',
];

export type PresetCategory = 'vault' | 'launchpad' | 'flashloan';

export const PRESET_CATEGORY: Record<Preset, PresetCategory> = {
  'aave-v3-erc4626-vault': 'vault',
  'morpho-blue-vault': 'vault',
  'compound-v3-vault': 'vault',
  'token-sale-launchpad': 'launchpad',
  'bonding-curve-launchpad': 'launchpad',
  'aave-v3-flashloan-receiver': 'flashloan',
};

export const CATEGORY_LABELS: Record<PresetCategory, string> = {
  vault: 'Vaults',
  launchpad: 'Launchpads',
  flashloan: 'Flash-loan receivers',
};

export const isVaultPreset = (p: Preset): boolean => PRESET_CATEGORY[p] === 'vault';
export const isLaunchpadPreset = (p: Preset): boolean => PRESET_CATEGORY[p] === 'launchpad';

// ---------------------------------------------------------------------------
// 2. Wire format
// ---------------------------------------------------------------------------

export interface GenerateOptions {
  preset: Preset;
  name: string;                  // ^[A-Za-z_][A-Za-z0-9_]*$
  access: 'none' | 'ownable' | 'roles';
  pausable: boolean;
  /**
   * Underlying ERC20. Vaults: the asset deposited. Flash-loan receiver: the asset
   * borrowed. Launchpads: unused (the sale token is a constructor argument, the
   * bonding curve mints its own).
   */
  asset?: `0x${string}`;
  routerAllowlist: boolean;      // flash-loan receiver only
  claimRewards: boolean;         // Aave + Compound vaults, flash-loan receiver
  sweepEscapeHatch: boolean;

  // ---- vault settings ----
  depositCap?: string;           // decimal string, raw units
  feeBps?: number;               // 0..1000, performance fee on yield
  decimalsOffset?: number;       // 0..12. Virtual-share exponent defending the
                                 // empty-vault inflation attack; the single most
                                 // consequential vault setting. Default 6.
  /**
   * Morpho Blue only. A market is the hash of five parameters, so the vault pins
   * one at construction (MRPH-MKT-018). Undefined picks the deepest known market
   * for `asset`; the generator refuses assets it has no market for.
   */
  morphoMarketId?: `0x${string}`;

  // ---- launchpad: fixed-price token sale ----
  tokenPriceWei?: string;        // wei per one whole sale token (10^decimals units)
  hardCapWei?: string;           // total ETH the sale accepts
  softCapWei?: string;           // below this at close, the sale fails and refunds
  minContributionWei?: string;   // per transaction floor; 0 disables
  maxContributionWei?: string;   // per wallet ceiling; 0 disables
  whitelist?: boolean;           // Merkle-root allowlist, root set by the owner
  vestingCliffDays?: number;     // 0..365
  vestingDurationDays?: number;  // 0..1460; 0 means everything unlocks at the cliff

  // ---- launchpad: bonding curve ----
  curveSupply?: string;          // whole tokens sold on the curve (18 decimals)
  graduationEth?: string;        // wei of ETH raised that triggers graduation
  tradingFeeBps?: number;        // 0..500, taken on the ETH side of every trade
  maxWalletBps?: number;         // 0..10000, cap per wallet as bps of curveSupply; 0 disables
}

/** A file in the generated project besides the three headline ones. */
export interface GeneratedFile { path: string; content: string }

export interface GeneratedProject {
  preset: Preset;                // which preset produced this; consumers should not infer it
  contractName: string;
  contractSource: string;        // src/<Name>.sol
  attackTestSource: string;      // test/<Name>.attack.t.sol — the incident-cited regressions
  propertyTestSource?: string;   // test/<Name>.props.t.sol — fuzz + invariants over the user's changes
  deployScriptSource: string;    // script/<Name>.s.sol
  extraFiles?: GeneratedFile[];  // anything else the project needs (a handler, an interface)
  remappings: string[];
  appliedFindingIds: string[];   // which findings the generated code mitigates
}

export interface Finding {
  id: string;                    // e.g. 'AAVE-FL-001'
  title: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  vulnClasses: string[];         // AuditVault slugs, e.g. ['vuln/access-control/missing-auth']
  summary: string;               // one sentence, plain English
  detail: string;                // 2-4 sentences
  incidents: { name: string; loss?: string; url: string; pocFolder?: string }[];
  detect: { kind: 'regex' | 'absence'; pattern: string; appliesTo: Preset[] }[];
  remediation: string;
}

export interface AuditResult {
  findings: (Finding & { status: 'mitigated' | 'triggered'; line?: number })[];
  score: { mitigated: number; triggered: number };
}

export interface CompileResult {
  ok: boolean;
  abi?: unknown[];
  bytecode?: `0x${string}`;
  sizeBytes?: number;
  errors: { severity: string; message: string; line?: number }[];
}

export interface DeployResult {
  address: `0x${string}`;
  txHash: string;
  /**
   * Absent on a local fork, which has nowhere to publish to. Present only when an
   * explorer is pointed at the chain (EXPLORER_BASE), so a missing link means
   * "no explorer here", never "the deploy failed".
   */
  explorerUrl?: string;
}

export type Scenario =
  | 'supply-borrow'
  | 'flashloan-simple'
  | 'leverage-loop'
  | 'vault-deposit';
export interface SimulateResult {
  ok: boolean;
  scenario: Scenario;
  trace: { depth: number; from: string; to: string; fn: string; value?: string }[];
  balanceChanges: { token: string; delta: string }[];
  explorerUrl?: string;
}

// ---------------------------------------------------------------------------
// 3. Finding ID vocabulary. The generator tags `appliedFindingIds` with these; the
//    audit corpus and the attack snippets are keyed by them. Never renamed.
// ---------------------------------------------------------------------------

export const FINDING_IDS = {
  FLASHLOAN_CALLBACK_UNGATED: 'AAVE-FL-001',
  FLASHLOAN_ATTACKER_PARAMS: 'AAVE-FL-002',
  VAULT_ATOKEN_BALANCE_DENOMINATOR: 'AAVE-VLT-003',
  VAULT_WITHDRAW_RETURN_IGNORED: 'AAVE-VLT-004',
  RISK_ENGINE_REIMPLEMENTED: 'AAVE-RISK-005',
  RISK_LTV0_POISON_DUST: 'AAVE-RISK-006',
  ORACLE_EMODE_PRICE_SOURCE: 'AAVE-ORC-007',
  VAULT_REWARDS_UNCLAIMABLE: 'AAVE-VLT-008',
  VAULT_NO_ESCAPE_HATCH: 'AAVE-VLT-009',
  RISK_CAPS_AND_PAUSE_REVERTS: 'AAVE-RISK-010',
  VAULT_RECEIVER_OWNER_CONFLATED: 'AAVE-VLT-011',
  ORACLE_SCALE_MISMATCH: 'AAVE-ORC-012',
  FLASHLOAN_IDLE_FUNDS: 'AAVE-FL-013',
  SWAP_MISSING_MIN_AMOUNT_OUT: 'AAVE-SWP-014',
  UNCHECKED_EXTERNAL_CALL: 'AAVE-DEP-015',
  // Morpho Blue. The protocol has footguns Aave does not.
  MORPHO_ASSETS_SHARES_EXCLUSIVE: 'MRPH-VLT-016',
  MORPHO_CALLBACK_UNGATED: 'MRPH-CB-017',
  MORPHO_MARKET_PARAMS_UNPINNED: 'MRPH-MKT-018',
  // Compound v3 (Comet).
  COMET_WITHDRAW_OPENS_BORROW: 'CMPD-VLT-019',
  COMET_PRESENT_VALUE_ROUNDING: 'CMPD-VLT-020',
  COMET_REWARDS_UNCLAIMABLE: 'CMPD-VLT-021',
  // Launchpad: fixed-price token sale.
  SALE_FUNDS_BEFORE_FINALIZE: 'LPAD-SALE-030',
  SALE_CLAIM_BEFORE_FINALIZE: 'LPAD-SALE-031',
  SALE_PUSH_REFUNDS_REENTRANCY: 'LPAD-SALE-032',
  SALE_CAPS_UNENFORCED: 'LPAD-SALE-033',
  SALE_WHITELIST_REPLAY: 'LPAD-SALE-034',
  SALE_PRICE_DECIMALS_MISMATCH: 'LPAD-SALE-035',
  SALE_FEE_ON_TRANSFER_TOKEN: 'LPAD-SALE-036',
  SALE_VESTING_MATH: 'LPAD-SALE-037',
  // Launchpad: bonding curve with DEX graduation.
  CURVE_TRANSFERS_BEFORE_GRADUATION: 'LPAD-CURVE-040',
  CURVE_PAIR_PRESEEDED: 'LPAD-CURVE-041',
  CURVE_NO_SLIPPAGE_OR_DEADLINE: 'LPAD-CURVE-042',
  CURVE_SELL_REENTRANCY: 'LPAD-CURVE-043',
  CURVE_ROUNDING_FAVOURS_TRADER: 'LPAD-CURVE-044',
  CURVE_LP_RETAINED: 'LPAD-CURVE-045',
  CURVE_NO_WALLET_CAP: 'LPAD-CURVE-046',
  CURVE_TRADING_AFTER_GRADUATION: 'LPAD-CURVE-047',
} as const;

export type FindingId = (typeof FINDING_IDS)[keyof typeof FINDING_IDS];

/** Human-readable titles, frozen alongside the IDs so every consumer labels identically. */
export const FINDING_TITLES: Record<FindingId, string> = {
  'AAVE-FL-001': 'Flash-loan callback not gated to Pool + initiator',
  'AAVE-FL-002': 'Attacker-controlled calldata executed from callback params',
  'AAVE-VLT-003': 'Donatable balance used as share-price denominator',
  'AAVE-VLT-004': 'Lending-market withdraw return value ignored',
  'AAVE-RISK-005': 'Aave risk engine re-implemented more permissively',
  'AAVE-RISK-006': 'LTV-0 aToken poison dust blocks withdrawals',
  'AAVE-ORC-007': 'eMode price-source divergence',
  'AAVE-VLT-008': 'RewardsController rewards permanently unclaimable',
  'AAVE-VLT-009': 'No ERC20 escape hatch for airdrops / stuck tokens',
  'AAVE-RISK-010': 'Supply/borrow cap and pause reverts unhandled',
  'AAVE-VLT-011': 'ERC-4626 receiver and owner conflated',
  'AAVE-ORC-012': 'Oracle scale / decimals mismatch',
  'AAVE-FL-013': 'Idle funds held on the flash-loan receiver',
  'AAVE-SWP-014': 'Missing minAmountOut on the swap leg',
  'AAVE-DEP-015': 'Unchecked external call return value',
  'MRPH-VLT-016': 'Morpho assets/shares not mutually exclusive',
  'MRPH-CB-017': 'Morpho callback not gated to the Morpho singleton',
  'MRPH-MKT-018': 'Market parameters not pinned at construction',
  'CMPD-VLT-019': 'Comet withdraw beyond the supplied balance opens a borrow',
  'CMPD-VLT-020': 'Comet present-value rounding booked as the requested amount',
  'CMPD-VLT-021': 'COMP rewards unclaimable (CometRewards.claim never called by the supplier)',
  'LPAD-SALE-030': 'Raised funds withdrawable before the sale is finalized',
  'LPAD-SALE-031': 'Tokens claimable before finalization, or claimable twice',
  'LPAD-SALE-032': 'Push-based refunds / reentrancy in claim and refund',
  'LPAD-SALE-033': 'Hard cap or per-wallet cap not enforced',
  'LPAD-SALE-034': 'Whitelist proof not bound to this sale (replayable)',
  'LPAD-SALE-035': 'Price / token-decimals mismatch in the allocation math',
  'LPAD-SALE-036': 'Fee-on-transfer sale token breaks allocation accounting',
  'LPAD-SALE-037': 'Vesting unlock math wrong at the cliff',
  'LPAD-CURVE-040': 'Curve tokens transferable before graduation',
  'LPAD-CURVE-041': 'Graduation breaks when the DEX pair was pre-seeded',
  'LPAD-CURVE-042': 'Buy/sell without a slippage bound or deadline',
  'LPAD-CURVE-043': 'Sell-side ETH refund reentrancy',
  'LPAD-CURVE-044': 'Curve rounding favours the trader',
  'LPAD-CURVE-045': 'Graduation LP tokens retained by the deployer',
  'LPAD-CURVE-046': 'No per-wallet cap on the curve',
  'LPAD-CURVE-047': 'Curve still tradable after graduation',
};

export const SEVERITY_BY_FINDING: Record<FindingId, Finding['severity']> = {
  'AAVE-FL-001': 'critical',
  'AAVE-FL-002': 'critical',
  'AAVE-VLT-003': 'critical',
  'AAVE-VLT-004': 'high',
  'AAVE-RISK-005': 'high',
  'AAVE-RISK-006': 'high',
  'AAVE-ORC-007': 'high',
  'AAVE-VLT-008': 'high',
  'AAVE-VLT-009': 'medium',
  'AAVE-RISK-010': 'medium',
  'AAVE-VLT-011': 'medium',
  'AAVE-ORC-012': 'high',
  'AAVE-FL-013': 'medium',
  'AAVE-SWP-014': 'high',
  'AAVE-DEP-015': 'medium',
  'MRPH-VLT-016': 'high',
  'MRPH-CB-017': 'critical',
  'MRPH-MKT-018': 'high',
  'CMPD-VLT-019': 'critical',
  'CMPD-VLT-020': 'medium',
  'CMPD-VLT-021': 'high',
  'LPAD-SALE-030': 'critical',
  'LPAD-SALE-031': 'high',
  'LPAD-SALE-032': 'high',
  'LPAD-SALE-033': 'medium',
  'LPAD-SALE-034': 'high',
  'LPAD-SALE-035': 'high',
  'LPAD-SALE-036': 'medium',
  'LPAD-SALE-037': 'medium',
  'LPAD-CURVE-040': 'critical',
  'LPAD-CURVE-041': 'high',
  'LPAD-CURVE-042': 'high',
  'LPAD-CURVE-043': 'high',
  'LPAD-CURVE-044': 'high',
  'LPAD-CURVE-045': 'medium',
  'LPAD-CURVE-046': 'medium',
  'LPAD-CURVE-047': 'high',
};

// ---------------------------------------------------------------------------
// 4. Remappings + import paths. The generator emits Solidity containing exactly
//    the IMPORT_PATHS strings below; every compiler in the system resolves them.
// ---------------------------------------------------------------------------

/** Written verbatim to remappings.txt in the exported Foundry project. */
export const REMAPPINGS: string[] = [
  '@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/',
  '@aave/core-v3/=lib/aave-v3-core/',
  '@aave/periphery-v3/=lib/aave-v3-periphery/',
  'forge-std/=lib/forge-std/src/',
  '@morpho-org/morpho-blue/=lib/morpho-blue/',
];

/** Every import string the generator is allowed to emit. */
export const IMPORT_PATHS = {
  FLASH_LOAN_SIMPLE_RECEIVER_BASE:
    '@aave/core-v3/contracts/flashloan/base/FlashLoanSimpleReceiverBase.sol',
  POOL_ADDRESSES_PROVIDER: '@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol',
  POOL: '@aave/core-v3/contracts/interfaces/IPool.sol',
  AAVE_ORACLE: '@aave/core-v3/contracts/interfaces/IAaveOracle.sol',
  ATOKEN: '@aave/core-v3/contracts/interfaces/IAToken.sol',
  DATA_TYPES: '@aave/core-v3/contracts/protocol/libraries/types/DataTypes.sol',
  RESERVE_CONFIGURATION:
    '@aave/core-v3/contracts/protocol/libraries/configuration/ReserveConfiguration.sol',
  REWARDS_CONTROLLER: '@aave/periphery-v3/contracts/rewards/interfaces/IRewardsController.sol',
  MORPHO: '@morpho-org/morpho-blue/src/interfaces/IMorpho.sol',
  MORPHO_BALANCES_LIB: '@morpho-org/morpho-blue/src/libraries/periphery/MorphoBalancesLib.sol',
  IERC20: '@openzeppelin/contracts/token/ERC20/IERC20.sol',
  IERC20_METADATA: '@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol',
  SAFE_ERC20: '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol',
  ERC4626: '@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol',
  ERC20: '@openzeppelin/contracts/token/ERC20/ERC20.sol',
  OWNABLE: '@openzeppelin/contracts/access/Ownable.sol',
  ACCESS_CONTROL: '@openzeppelin/contracts/access/AccessControl.sol',
  PAUSABLE: '@openzeppelin/contracts/utils/Pausable.sol',
  REENTRANCY_GUARD: '@openzeppelin/contracts/utils/ReentrancyGuard.sol',
  MERKLE_PROOF: '@openzeppelin/contracts/utils/cryptography/MerkleProof.sol',
  ADDRESS: '@openzeppelin/contracts/utils/Address.sol',
  MATH: '@openzeppelin/contracts/utils/math/Math.sol',
  FORGE_TEST: 'forge-std/Test.sol',
  FORGE_SCRIPT: 'forge-std/Script.sol',
} as const;

/** Pinned so generated pragma, solc, and the Foundry project never disagree. */
export const SOLC_VERSION = '0.8.27';
export const SOLIDITY_PRAGMA = '^0.8.27';
/** Pinned, not inherited from the solc default, which has moved between releases. */
export const EVM_VERSION = 'cancun';

// ---------------------------------------------------------------------------
// 5. API surface. The web app keeps the base URL in one env var.
// ---------------------------------------------------------------------------

export const API_ROUTES = {
  compile: '/compile',
  audit: '/audit',
  deploy: '/deploy',
  simulate: '/simulate',
} as const;

export interface CompileRequest {
  contractName: string;
  source: string;
  remappings?: string[];
  /** Extra sources the main file imports by relative path, e.g. a local interface. */
  extraSources?: GeneratedFile[];
}
export interface AuditRequest { preset: Preset; source: string }
export interface DeployRequest { contractName: string; abi: unknown[]; bytecode: `0x${string}`; constructorArgs?: unknown[] }
export interface SimulateRequest { scenario: Scenario; address: `0x${string}` }

// ---------------------------------------------------------------------------
// Validation (CVE-2026-48054). Reject, do not sanitize.
// ---------------------------------------------------------------------------

export const CONTRACT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
export const BYTES32_RE = /^0x[a-fA-F0-9]{64}$/;
/** A bounded decimal integer, the only numeric shape that reaches generated Solidity. */
export const UINT_RE = /^[0-9]{1,40}$/;
