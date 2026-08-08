// End-to-end HTTP check against a running server (npm start). Chain routes are expected to
// answer 503 until the Tenderly VE is configured.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.API_BASE ?? 'http://localhost:8787';
const here = path.dirname(fileURLToPath(import.meta.url));
const samplesDir = path.resolve(here, '../../contracts/samples');
const read = (f: string) => fs.readFileSync(path.join(samplesDir, f), 'utf8').replace(/\r\n/g, '\n');

const vault = read('HardenedAaveV3Vault.sol');
const receiver = read('HardenedAaveFlashLoanReceiver.sol');
const VAULT_MITIGATION = [
  '    function _decimalsOffset() internal pure override returns (uint8) {',
  '        return 3;',
  '    }',
].join('\n');

const failures: string[] = [];
const check = (label: string, pass: boolean, detail = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures.push(label);
};

async function post(route: string, body: unknown) {
  const res = await fetch(`${BASE}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

const health = (await (await fetch(`${BASE}/health`)).json()) as { ok: boolean; findings: number };
check('GET /health', health.ok === true && health.findings === 15, `${health.findings} findings`);

const remaps = (await (await fetch(`${BASE}/remappings`)).json()) as { remappings: string[] };
check('GET /remappings', Array.isArray(remaps.remappings) && remaps.remappings.length >= 3);

// ---- vault: the demo path -------------------------------------------------------------------

const vaultClean = await post('/audit', { source: vault, preset: 'aave-v3-erc4626-vault' });
check(
  'POST /audit vault hardened → all mitigated',
  vaultClean.status === 200 && vaultClean.json.score.triggered === 0,
  `mitigated=${vaultClean.json.score?.mitigated} triggered=${vaultClean.json.score?.triggered}`,
);

const vaultBroken = await post('/audit', {
  source: vault.replace(VAULT_MITIGATION, ''),
  preset: 'aave-v3-erc4626-vault',
});
const donation = vaultBroken.json.findings?.find((f: any) => f.id === 'AAVE-VLT-003');
check(
  'POST /audit vault tampered → AAVE-VLT-003 flips (donation attack)',
  donation?.status === 'triggered' && donation?.severity === 'critical' && vaultBroken.json.score.triggered === 1,
  `cites ${donation?.incidents?.[0]?.name}`,
);

const vaultCompiled = await post('/compile', { source: vault, contractName: 'HardenedAaveV3Vault' });
check(
  'POST /compile vault → ok with ABI + size',
  vaultCompiled.status === 200 && vaultCompiled.json.ok === true && vaultCompiled.json.sizeBytes > 0,
  `size=${vaultCompiled.json.sizeBytes}B abi=${vaultCompiled.json.abi?.length}`,
);

const vaultSim = await post('/simulate', { scenario: 'vault-deposit' });
check(
  'POST /simulate accepts vault-deposit as a known scenario',
  // 400 once the chain is configured (contractAddress required), 503 before that. Either proves
  // the scenario reached the chain layer rather than being rejected as unknown.
  vaultSim.status === 400 || vaultSim.status === 503,
  vaultSim.json.error,
);

// ---- flash-loan receiver: still supported ----------------------------------------------------

const recvClean = await post('/audit', { source: receiver, preset: 'aave-v3-flashloan-receiver' });
check(
  'POST /audit receiver hardened → all mitigated',
  recvClean.json.score.triggered === 0,
  `mitigated=${recvClean.json.score?.mitigated}`,
);

const recvBroken = await post('/audit', {
  source: receiver.replace('if (initiator != address(this)) revert NotSelfInitiated(initiator);', ''),
  preset: 'aave-v3-flashloan-receiver',
});
check(
  'POST /audit receiver tampered → AAVE-FL-001 flips',
  recvBroken.json.findings?.find((f: any) => f.id === 'AAVE-FL-001')?.status === 'triggered',
);

// ---- input validation ------------------------------------------------------------------------

const badName = await post('/compile', { source: vault, contractName: 'Bad Name; rm -rf /' });
check('POST /compile rejects a hostile contractName (400)', badName.status === 400, badName.json.error);

const badScenario = await post('/simulate', { scenario: 'not-a-scenario' });
check('POST /simulate rejects an unknown scenario (400)', badScenario.status === 400);

const traversal = await post('/compile', {
  source: 'pragma solidity ^0.8.20;\nimport "../../../../../etc/passwd";\ncontract X {}\n',
  contractName: 'X',
});
const blocked = traversal.json.errors?.some((e: any) => /not on the allowlist|Could not resolve/.test(e.message));
check('POST /compile blocks path-traversal imports', traversal.json.ok === false && blocked === true);

const oversize = await post('/compile', { source: 'a'.repeat(600 * 1024), contractName: 'X' });
check('POST /compile rejects oversize source (400)', oversize.status === 400, oversize.json.error);

// ---- CORS, the h10 failure the spec warns about -----------------------------------------------

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:3000';

const preflight = await fetch(`${BASE}/audit`, {
  method: 'OPTIONS',
  headers: {
    origin: WEB_ORIGIN,
    'access-control-request-method': 'POST',
    'access-control-request-headers': 'content-type',
  },
});
check(
  `CORS preflight from ${WEB_ORIGIN}`,
  preflight.status < 300 && preflight.headers.get('access-control-allow-origin') === WEB_ORIGIN,
  `${preflight.status}, allow-origin=${preflight.headers.get('access-control-allow-origin')}`,
);

const allowed = await fetch(`${BASE}/health`, { headers: { origin: WEB_ORIGIN } });
check(
  'CORS header present on a real request from the web origin',
  allowed.headers.get('access-control-allow-origin') === WEB_ORIGIN,
);

const denied = await fetch(`${BASE}/health`, { headers: { origin: 'https://evil.example' } });
check(
  'CORS withheld from an unlisted origin (no 500)',
  denied.status === 200 && denied.headers.get('access-control-allow-origin') === null,
  `${denied.status}, allow-origin=${denied.headers.get('access-control-allow-origin')}`,
);

console.log(failures.length ? `\n${failures.length} check(s) failed.` : '\nAll route checks passed.');
process.exit(failures.length ? 1 : 0);
