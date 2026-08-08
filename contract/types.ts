/**
 * ██ FROZEN INTERFACE CONTRACT ██
 *
 * Frozen at h0 per HARNESS-BUILD-SPEC §5.6. Copied verbatim into BOTH apps:
 *   harness-web/src/types.ts   (Agent A)
 *   harness-api/src/types.ts   (Agent B)
 *
 * DO NOT EDIT without both agents present. A change here that only one side
 * copies is the failure mode this file exists to prevent.
 *
 * Covers all four frozen artifacts from §5.6:
 *   1. the HTTP wire format          -> the interfaces below
 *   2. the finding ID vocabulary     -> FINDING_IDS
 *   3. remappings + import paths     -> REMAPPINGS / IMPORT_PATHS
 *   4. API base URL + route names    -> API_ROUTES
 */

// ---------------------------------------------------------------------------
// 1. Wire format (§6)
// ---------------------------------------------------------------------------

export type Preset = 'aave-v3-flashloan-receiver' | 'aave-v3-erc4626-vault';

export interface GenerateOptions {
  preset: Preset;
  name: string;                  // ^[A-Za-z_][A-Za-z0-9_]*$
  access: 'none' | 'ownable' | 'roles';
  pausable: boolean;
  asset?: `0x${string}`;         // underlying ERC20
  routerAllowlist: boolean;
  claimRewards: boolean;
  sweepEscapeHatch: boolean;
  depositCap?: string;           // decimal string, vault preset only
  feeBps?: number;               // 0..1000, vault preset only
}

export interface GeneratedProject {
  preset: Preset;                // which preset produced this; consumers should not infer it
  contractName: string;
  contractSource: string;        // src/<Name>.sol
  attackTestSource: string;      // test/<Name>.attack.t.sol
  deployScriptSource: string;    // script/<Name>.s.sol
  remappings: string[];
  appliedFindingIds: string[];   // which knowledge/findings.json rules are mitigated
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

export interface DeployResult { address: `0x${string}`; explorerUrl: string; txHash: string; }

export type Scenario =
  | 'supply-borrow'
  | 'flashloan-simple'
  | 'leverage-loop'
  | 'vault-deposit'; // added with Agent B for the ERC-4626 preset; purely additive
export interface SimulateResult {
  ok: boolean;
  scenario: Scenario;
  trace: { depth: number; from: string; to: string; fn: string; value?: string }[];
  balanceChanges: { token: string; delta: string }[];
  explorerUrl?: string;
}

// ---------------------------------------------------------------------------
// 2. Frozen finding ID vocabulary (§5.6). Maps 1:1 to §8.1.
//    Agent A tags `appliedFindingIds` with these.
//    Agent B keys knowledge/findings.json and fixtures/attack-snippets.json with these.
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
} as const;

export type FindingId = (typeof FINDING_IDS)[keyof typeof FINDING_IDS];

/** Human-readable titles, frozen alongside the IDs so both apps label identically. */
export const FINDING_TITLES: Record<FindingId, string> = {
  'AAVE-FL-001': 'Flash-loan callback not gated to Pool + initiator',
  'AAVE-FL-002': 'Attacker-controlled calldata executed from callback params',
  'AAVE-VLT-003': 'aToken.balanceOf used as share-price denominator',
  'AAVE-VLT-004': 'Aave withdraw() return value ignored',
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
};

// ---------------------------------------------------------------------------
// 3. Remappings + import paths (§5.6 item 3)
//    Agent A emits Solidity containing exactly the IMPORT_PATHS strings below.
//    Agent B's solc must resolve exactly those strings.
// ---------------------------------------------------------------------------

/** Written verbatim to remappings.txt in the exported Foundry project. */
export const REMAPPINGS: string[] = [
  '@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/',
  '@aave/core-v3/=lib/aave-v3-core/',
  '@aave/periphery-v3/=lib/aave-v3-periphery/',
  'forge-std/=lib/forge-std/src/',
];

/** Every import string the generator is allowed to emit. Agent B resolves these. */
export const IMPORT_PATHS = {
  FLASH_LOAN_SIMPLE_RECEIVER_BASE:
    '@aave/core-v3/contracts/flashloan/base/FlashLoanSimpleReceiverBase.sol',
  POOL_ADDRESSES_PROVIDER: '@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol',
  POOL: '@aave/core-v3/contracts/interfaces/IPool.sol',
  AAVE_ORACLE: '@aave/core-v3/contracts/interfaces/IAaveOracle.sol',
  ATOKEN: '@aave/core-v3/contracts/interfaces/IAToken.sol',
  DATA_TYPES: '@aave/core-v3/contracts/protocol/libraries/types/DataTypes.sol',
  REWARDS_CONTROLLER: '@aave/periphery-v3/contracts/rewards/interfaces/IRewardsController.sol',
  IERC20: '@openzeppelin/contracts/token/ERC20/IERC20.sol',
  IERC20_METADATA: '@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol',
  SAFE_ERC20: '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol',
  ERC4626: '@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol',
  ERC20: '@openzeppelin/contracts/token/ERC20/ERC20.sol',
  OWNABLE: '@openzeppelin/contracts/access/Ownable.sol',
  ACCESS_CONTROL: '@openzeppelin/contracts/access/AccessControl.sol',
  PAUSABLE: '@openzeppelin/contracts/utils/Pausable.sol',
  REENTRANCY_GUARD: '@openzeppelin/contracts/utils/ReentrancyGuard.sol',
  MATH: '@openzeppelin/contracts/utils/math/Math.sol',
  FORGE_TEST: 'forge-std/Test.sol',
} as const;

/** Pinned so generated pragma, solc, and the Foundry project never disagree. */
export const SOLC_VERSION = '0.8.27';
export const SOLIDITY_PRAGMA = '^0.8.27';
/** Pinned, not inherited from the solc default, which has moved between releases. */
export const EVM_VERSION = 'cancun';

// ---------------------------------------------------------------------------
// 4. API surface (§5.6 item 4). Agent A keeps the base URL in one env var.
// ---------------------------------------------------------------------------

export const API_ROUTES = {
  compile: '/compile',
  audit: '/audit',
  deploy: '/deploy',
  simulate: '/simulate',
} as const;

export interface CompileRequest { contractName: string; source: string; remappings?: string[] }
export interface AuditRequest { preset: Preset; source: string }
export interface DeployRequest { contractName: string; abi: unknown[]; bytecode: `0x${string}`; constructorArgs?: unknown[] }
export interface SimulateRequest { scenario: Scenario; address: `0x${string}` }

// ---------------------------------------------------------------------------
// Validation (§5.4 — CVE-2026-48054). Reject, do not sanitize.
// ---------------------------------------------------------------------------

export const CONTRACT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
