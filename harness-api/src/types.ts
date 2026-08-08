// FROZEN SHARED INTERFACE CONTRACT (spec §6). Copy of contract/types.ts.
// Do not edit without Agent A present.

export type Preset = 'aave-v3-flashloan-receiver' | 'aave-v3-erc4626-vault';

export interface GenerateOptions {
  preset: Preset;
  name: string; // ^[A-Za-z_][A-Za-z0-9_]*$
  access: 'none' | 'ownable' | 'roles';
  pausable: boolean;
  asset?: `0x${string}`; // underlying ERC20
  routerAllowlist: boolean;
  claimRewards: boolean;
  sweepEscapeHatch: boolean;
  depositCap?: string; // decimal string, vault preset only
  feeBps?: number; // 0..1000, vault preset only
}

export interface GeneratedProject {
  preset: Preset; // which preset produced this; consumers should not infer it
  contractName: string;
  contractSource: string; // src/<Name>.sol
  attackTestSource: string; // test/<Name>.attack.t.sol
  deployScriptSource: string; // script/<Name>.s.sol
  remappings: string[];
  appliedFindingIds: string[]; // which knowledge/findings.json rules are mitigated
}

export interface Finding {
  id: string; // e.g. 'AAVE-FL-001'
  title: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  vulnClasses: string[]; // AuditVault slugs, e.g. ['vuln/access-control/missing-auth']
  summary: string; // one sentence, plain English
  detail: string; // 2-4 sentences
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
  explorerUrl: string;
  txHash: string;
}

// PROPOSED ADDITIVE CHANGE (agent-b, pending Agent A mirroring it in contract/types.ts):
// 'vault-deposit' was appended for the vault-focused demo. Purely additive — existing values and
// every consumer of them are unaffected.
export type Scenario = 'supply-borrow' | 'flashloan-simple' | 'leverage-loop' | 'vault-deposit';

export interface SimulateResult {
  ok: boolean;
  scenario: Scenario;
  trace: { depth: number; from: string; to: string; fn: string; value?: string }[];
  balanceChanges: { token: string; delta: string }[];
  explorerUrl?: string;
}
