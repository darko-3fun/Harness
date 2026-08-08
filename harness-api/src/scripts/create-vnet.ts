// B1 — create the Tenderly Virtual Environment ONCE, ahead of time (spec §9.2).
// Never run this live on stage. Results are written straight into .env; the Admin RPC is a
// credential and is never printed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../env.js';
import { deployerAccount } from '../tenderly.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(here, '../../.env');

interface VnetResponse {
  id?: string;
  active_instance?: {
    id?: string;
    vnets?: { id?: string; rpcs?: { name?: string; url?: string }[] }[];
  };
}

function writeEnv(updates: Record<string, string>): void {
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const [key, value] of Object.entries(updates)) {
    const i = lines.findIndex((l) => l.trim().startsWith(`${key}=`));
    if (i >= 0) lines[i] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  fs.writeFileSync(envPath, lines.join('\n'), 'utf8');
}

async function rpc<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: T; error?: { message?: string } };
  if (json.error) throw new Error(`${method}: ${json.error.message ?? 'unknown'}`);
  return json.result as T;
}

async function main(): Promise<void> {
  const missing = ['TENDERLY_ACCOUNT', 'TENDERLY_PROJECT', 'TENDERLY_ACCESS_KEY'].filter(
    (k) => !env[k as keyof typeof env],
  );
  if (missing.length) throw new Error(`Missing env: ${missing.join(', ')}`);

  const address = env.DEPLOYER_PRIVATE_KEY ? deployerAccount().address : undefined;
  if (!address) throw new Error('Set DEPLOYER_PRIVATE_KEY first so the VE can pre-fund it.');

  const url =
    `https://api.tenderly.co/api/public/v1/account/${env.TENDERLY_ACCOUNT}` +
    `/project/${env.TENDERLY_PROJECT}/environments`;

  // Spec §9.2 says explorer_config: { verification_visibility: "source" }; Tenderly rejects that.
  // The API validates a field it calls contract_verification_visibility, so probe the plausible
  // key/value pairs and keep the first it accepts. Explorer-off is the last resort — it still
  // creates a usable VE, it just costs us the verified-source demo artifact.
  const explorerConfigs: Array<Record<string, unknown>> = [
    { enabled: true, contract_verification_visibility: 'src' },
    { enabled: true, contract_verification_visibility: 'full' },
    { enabled: true, contract_verification_visibility: 'abi' },
    { enabled: true, verification_visibility: 'src' },
    { enabled: true },
    { enabled: false },
  ];

  let json: VnetResponse | undefined;
  let accepted = '';
  let lastError = '';

  for (const explorerConfig of explorerConfigs) {
    const body = {
      slug: `harness-mainnet-${Date.now()}`,
      display_name: 'HARNESS mainnet fork',
      network_configs: [
        {
          network_id: '1',
          ...(env.TENDERLY_FORK_BLOCK ? { block_number: env.TENDERLY_FORK_BLOCK } : {}),
          chain_config_overrides: { chain_id: 1 },
          explorer_config: explorerConfig,
          accounts: [{ address, balance: '0x21e19e0c9bab2400000' }],
        },
      ],
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Access-Key': env.TENDERLY_ACCESS_KEY },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      json = (await res.json()) as VnetResponse;
      accepted = JSON.stringify(explorerConfig);
      break;
    }
    lastError = `HTTP ${res.status}: ${await res.text()}`;
    console.log(`  rejected ${JSON.stringify(explorerConfig)} -> ${lastError.slice(0, 120)}`);
  }

  if (!json) throw new Error(`Tenderly rejected every explorer_config. Last: ${lastError}`);
  console.log(`\nexplorer_config accepted: ${accepted}\n`);

  const vnet = json.active_instance?.vnets?.[0];
  const rpcs = vnet?.rpcs ?? [];
  const pick = (name: string) => rpcs.find((r) => r.name?.toLowerCase().includes(name))?.url ?? '';

  const admin = pick('admin');
  const publicRpc = pick('public');
  if (!admin) throw new Error(`No Admin RPC in the response. RPC names seen: ${rpcs.map((r) => r.name).join(', ')}`);

  // Forked at latest, so the head block IS the fork block — record it for Agent A.
  const blockHex = await rpc<string>(admin, 'eth_blockNumber');
  const forkBlock = BigInt(blockHex).toString();

  writeEnv({
    TENDERLY_ADMIN_RPC: admin,
    TENDERLY_PUBLIC_RPC: publicRpc,
    TENDERLY_EXPLORER_BASE: `https://dashboard.tenderly.co/explorer/vnet/${vnet?.id ?? ''}`,
    TENDERLY_FORK_BLOCK: forkBlock,
  });

  console.log('Virtual Environment created and .env updated.\n');
  console.log(`  TENDERLY_ADMIN_RPC      written (masked — this is a credential) [len ${admin.length}]`);
  console.log(`  TENDERLY_PUBLIC_RPC     ${publicRpc || '(none returned)'}`);
  console.log(`  TENDERLY_EXPLORER_BASE  https://dashboard.tenderly.co/explorer/vnet/${vnet?.id ?? ''}`);
  console.log(`  TENDERLY_FORK_BLOCK     ${forkBlock}   <-- give this to Agent A`);
  console.log(`\n  deployer ${address}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

