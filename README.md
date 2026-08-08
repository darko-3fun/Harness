# HARNESS

**OpenZeppelin Wizard, but for DeFi.** Tick some checkboxes, get a hardened Aave v3
integration contract — plus the attacks on it, and the proof it survives them.

**Live:** https://harness-web-livid.vercel.app

---

## The gap

OpenZeppelin's Contracts Wizard generates production-shaped Solidity for tokens, NFTs
and governance. Its Solidity kinds are exactly `erc20`, `erc721`, `erc1155`,
`stablecoin`, `realWorldAsset`, `account`, `governor`, `custom`. **No ERC-4626, no
vault, no DeFi.** (Their *Stellar* wizard ships a `vault` kind. The Solidity one does
not.)

Meanwhile the frontend side is thoroughly covered — Aave Kit ships `useSupply()` and
`useBorrow()` across 14 chains; the Morpho SDK builds slippage-protected transactions.
Nobody generates the **on-chain integration contract**, which is precisely where every
Critical-severity finding in the public audit corpus actually lives.

Every audit source converges on the same remedy: fork tests with hostile inputs. That
checklist is mechanical, and nobody ships it. Mechanical means generatable.

---

## Three pillars

| | You do | You get |
|---|---|---|
| **Generate** | Pick a preset, tick options | A hardened contract + a runnable Foundry project |
| **Audit** | Edit the code, or paste your own | Findings mapped to real hacks, each citing a runnable exploit PoC |
| **Simulate** | Run the suite | The contract attacked on a fork of **real mainnet**, against **real Aave** |

Generation is **deterministic template composition, not AI.** That is the point: it is
why OpenZeppelin's output is trusted, and it means the output compiles every time.

---

## What's actually verified

Not aspirations — these were executed.

```
132 of 192 option combinations accepted, 132/132 compile
   solc 0.8.27, 0 errors, 0 warnings

MyFlashLoanReceiverAttackTest    6 passed; 0 failed
MyAaveVaultAttackTest            6 passed; 0 failed
   Foundry 1.7.1, forked mainnet, real Aave Pool
```

The 60 rejected combinations are refusals, not failures: `access: 'none'` combined with
a sweep, a reward claim or a pause is ungated theft or denial of service, so the
generator declines to emit it.

**The tests have teeth.** Each mitigation was deleted in turn to confirm the intended
test catches it:

| Removed | Test that fails |
|---|---|
| `revert NotSelfInitiated` | `test_RejectsThirdPartyInitiator` |
| `revert MissingSlippageBound` | `test_RejectsZeroMinAmountOut` |
| `whenNotPaused` | `test_PausedInitiationRevertsCleanly` |
| `onlyOwner` on `sweep` | `test_SweepIsGatedAndRecoversStrayTokens` |
| internal accounting → `aToken.balanceOf` | `AAVE-VLT-003` flips to Critical |

With the router allowlist off, so nothing backstops it, removing the initiator gate lets
an attacker's flash loan **succeed and be repaid out of the contract's idle funds** —
the DODO/Mimo drain, reproduced against live Aave.

---

## Presets

**Aave V3 Flash Loan Receiver.** Three gates in `executeOperation`, all mandatory:
caller is the Pool, the loan was self-initiated, and `params` decodes to a fixed struct
with no call target. Uses `flashLoanSimple` deliberately — the multi-asset `flashLoan`
with `interestRateModes = 2` opens debt instead of repaying.

**Aave V3 ERC-4626 Vault.** `totalAssets()` is internal accounting, never
`aToken.balanceOf(address(this))`, because aTokens are freely transferable and a
donation needs no protocol interaction at all. Backed by a decimals offset for the
empty-vault case. Withdrawals use the amount Aave actually returns.

---

## Run it

```bash
# the app
cd harness-web && npm install && npm run dev

# a generated project — download the zip from the UI, then
./setup.sh
cp .env.example .env      # set MAINNET_RPC_URL
forge test -vv
```

`setup.sh` → `forge test` was verified end to end from a clean unzip.

---

## Layout

```
contract/types.ts       frozen interface contract — wire format, finding IDs,
                        remappings, API routes. Copied verbatim into both apps.
fixtures/               the handshake between the two agents
harness-web/            Next.js app: generators, preview, audit UI, export
harness-api/            compile, audit, deploy, simulate  (Agent B)
```

`harness-web/src/app/api/compile` is a real solc compile running server-side, used as a
fallback until `NEXT_PUBLIC_API_BASE` points at `harness-api`.

---

## Honest status

Built and verified: both generators, the attack-test assembler, the audit UI, project
export, and server-side compile.

Not yet wired: Tenderly deployment and scenario simulation live in `harness-api`. Audit
results currently come from a local mock of the same rule shape — the UI badges them
**mock** so it is never ambiguous which you are looking at.

We do not claim the generated code is audit-grade. We claim it starts from the hardened
pattern rather than the tutorial pattern, and ships the tests that prove the difference.

---

## Attribution

- [sanbir/evm-hack-registry](https://github.com/sanbir/evm-hack-registry) — ~845
  offline-runnable exploit PoCs, the source of every incident citation
- [SunWeb3Sec/DeFiHackLabs](https://github.com/SunWeb3Sec/DeFiHackLabs) — the corpus it
  derives from
- [AuditWare/AuditVault](https://github.com/AuditWare/AuditVault) — the `vuln/*` taxonomy
- [OpenZeppelin Contracts](https://github.com/OpenZeppelin/openzeppelin-contracts) and
  `@openzeppelin/wizard`, whose `ContractBuilder` and `printContract` this is built on
- [@bgd-labs/aave-address-book](https://github.com/bgd-labs/aave-address-book) — canonical
  Aave addresses

## License

HARNESS is **AGPL-3.0-only**, inherited from `@openzeppelin/wizard`. §13 is a network
copyleft: hosting this obliges you to offer the corresponding source. Generated
contracts are unaffected — they carry their own MIT SPDX header.
