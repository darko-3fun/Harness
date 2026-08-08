// Proves the solc pipeline resolves @openzeppelin imports off disk and produces an artifact.
// Separate from smoke.ts because this one needs `npm i` to have pulled the Solidity sources.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileContract } from '../routes/compile.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const samplesDir = path.resolve(here, '../../contracts/samples');

const targets = [
  { file: 'HardenedAaveV3Vault.sol', contractName: 'HardenedAaveV3Vault' },
  { file: 'HardenedAaveFlashLoanReceiver.sol', contractName: 'HardenedAaveFlashLoanReceiver' },
];

let failed = false;
for (const { file, contractName } of targets) {
  const result = compileContract({
    source: fs.readFileSync(path.join(samplesDir, file), 'utf8'),
    contractName,
  });
  for (const e of result.errors.filter((x) => x.severity === 'error')) {
    console.log(`  [error] line ${e.line ?? '?'}: ${e.message.split('\n')[0]}`);
  }
  if (result.ok) {
    console.log(`OK   ${contractName} — ${result.sizeBytes} bytes deployed, ${result.abi?.length ?? 0} ABI entries`);
  } else {
    console.error(`FAIL ${contractName} — compilation failed`);
    failed = true;
  }
}

// Agent A's generator imports the real Aave and OpenZeppelin packages rather than declaring
// interfaces inline, so prove those remappings actually resolve before the h10 rejoin.
const importProbe = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IPool} from "@aave/core-v3/contracts/interfaces/IPool.sol";
import {IPoolAddressesProvider} from "@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol";
import {IFlashLoanSimpleReceiver} from "@aave/core-v3/contracts/flashloan/interfaces/IFlashLoanSimpleReceiver.sol";
import {DataTypes} from "@aave/core-v3/contracts/protocol/libraries/types/DataTypes.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";

contract ImportProbe {
    using SafeERC20 for IERC20;
    IPool public immutable POOL;

    constructor(address provider) {
        POOL = IPool(IPoolAddressesProvider(provider).getPool());
    }

    function config(address asset) external view returns (uint256) {
        DataTypes.ReserveConfigurationMap memory m = POOL.getConfiguration(asset);
        return m.data;
    }
}
`;

const probe = compileContract({ source: importProbe, contractName: 'ImportProbe' });
for (const e of probe.errors.filter((x) => x.severity === 'error')) {
  console.log(`  [error] ${e.message.split('\n')[0]}`);
}
if (probe.ok) {
  console.log(`OK   ImportProbe — real @aave/core-v3 + @openzeppelin imports resolve`);
} else {
  console.error('FAIL ImportProbe — the advertised remappings do NOT resolve');
  failed = true;
}

process.exit(failed ? 1 : 0);
