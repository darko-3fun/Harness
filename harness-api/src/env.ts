import 'dotenv/config';

function optional(key: string, fallback = ''): string {
  return (process.env[key] ?? fallback).trim();
}

export const env = {
  PORT: Number(optional('PORT', '8787')),
  WEB_ORIGIN: optional('WEB_ORIGIN', 'http://localhost:3000')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),

  TENDERLY_ADMIN_RPC: optional('TENDERLY_ADMIN_RPC'),
  TENDERLY_PUBLIC_RPC: optional('TENDERLY_PUBLIC_RPC'),
  TENDERLY_EXPLORER_BASE: optional('TENDERLY_EXPLORER_BASE').replace(/\/+$/, ''),
  TENDERLY_CHAIN_ID: Number(optional('TENDERLY_CHAIN_ID', '1')),

  TENDERLY_ACCOUNT: optional('TENDERLY_ACCOUNT'),
  TENDERLY_PROJECT: optional('TENDERLY_PROJECT'),
  TENDERLY_ACCESS_KEY: optional('TENDERLY_ACCESS_KEY'),
  TENDERLY_FORK_BLOCK: optional('TENDERLY_FORK_BLOCK'),

  DEPLOYER_PRIVATE_KEY: optional('DEPLOYER_PRIVATE_KEY'),
};

export class ConfigError extends Error {}

/** Throws a message safe to return to the client — never echoes the secret itself. */
export function requireChainConfig(): void {
  const missing: string[] = [];
  if (!env.TENDERLY_ADMIN_RPC) missing.push('TENDERLY_ADMIN_RPC');
  if (!env.DEPLOYER_PRIVATE_KEY) missing.push('DEPLOYER_PRIVATE_KEY');
  if (missing.length) {
    throw new ConfigError(
      `Chain features are not configured on this server (missing: ${missing.join(', ')}). ` +
        `See harness-api/.env.example.`,
    );
  }
}

/** Key only — vnet:create needs the deployer address before any RPC exists. */
export function requireDeployerKey(): void {
  if (!env.DEPLOYER_PRIVATE_KEY) {
    throw new ConfigError('DEPLOYER_PRIVATE_KEY is not set. See harness-api/.env.example.');
  }
}

export function explorerTxUrl(hash: string): string | undefined {
  return env.TENDERLY_EXPLORER_BASE ? `${env.TENDERLY_EXPLORER_BASE}/tx/${hash}` : undefined;
}

export function explorerAddressUrl(address: string): string {
  return env.TENDERLY_EXPLORER_BASE
    ? `${env.TENDERLY_EXPLORER_BASE}/address/${address}`
    : `about:blank#${address}`;
}
