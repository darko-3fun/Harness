# HARNESS

**OpenZeppelin Wizard, but for DeFi.** Pick a preset, tick some options, get a hardened
contract — plus the attacks on it, the properties it must keep, and the proof it survives
them on a fork of real mainnet.

**Live:** https://harness-web-livid.vercel.app

---

## The gap

OpenZeppelin's Contracts Wizard generates production-shaped Solidity for tokens, NFTs
and governance. Its Solidity kinds are exactly `erc20`, `erc721`, `erc1155`,
`stablecoin`, `realWorldAsset`, `account`, `governor`, `custom`. **No ERC-4626, no
vault, no launchpad, no DeFi.**

The frontend side is thoroughly covered — Aave Kit, the Morpho SDK. Nobody generates the
**on-chain integration contract**, which is precisely where every Critical-severity
finding in the public audit corpus actually lives. Every audit source converges on the
same remedy: fork tests with hostile inputs. That checklist is mechanical, and nobody
ships it. Mechanical means generatable.

---

## Presets

Three categories, six presets, one dropdown each.

| Category | Preset | What it hardens against |
|---|---|---|
| **Vaults** | Aave V3 Vault | aToken donation as share-price denominator (PoolTogether), withdraw return ignored (Connext), LTV-0 poison dust, unclaimable incentives |
| | Morpho Blue Vault | assets/shares both set (`inconsistent input`), an ungated callback, market parameters that can be repointed |
| | Compound V3 Vault | `withdraw()` past the balance **silently borrows** against collateral anyone can gift the vault, present-value rounding drift, `claimTo` permission model |
| **Launchpads** | Token Sale | funds movable before finalize (BetaPresale), claim before close (AISOTH), push refunds, replayable allowlist proofs (vVv), decimals mismatch (Rova) |
| | Bonding Curve | tokens reaching the DEX pair before graduation (Four.meme, twice), router-quoted liquidity on a pre-seeded pair, sell-side reentrancy (Decent), LP kept by the deployer (DxSale) |
| **Flash-loan receivers** | Aave V3 Flash Loan Receiver | callback not gated to the initiator (DODO, Mimo), attacker calldata from `params`, idle funds repaying someone else's loan |

Every vault is ERC-4626 with honest limits: `maxDeposit` is zero while paused or while the
market refuses supply, `maxWithdraw` is bounded by what the market can pay out right now.
The bonding curve graduates into a **real Uniswap V2 pool** by minting on the pair
directly, with the LP burned.

Vault presets take any catalogued asset (USDC, WETH, USDT, DAI, WBTC, wstETH for Aave;
whichever have a Morpho market or a Comet). Morpho vaults pin one of the deepest live
markets for the asset; the picker shows collateral and LLTV.

---

## Three pillars

| | You do | You get |
|---|---|---|
| **Generate** | Pick a preset, tick options | A hardened contract + a runnable Foundry project |
| **Audit** | Edit the code, or paste your own | 38 findings mapped to real hacks, each citing a runnable exploit PoC |
| **Simulate** | Run the suite | The contract attacked on a fork of **real mainnet**, against **real Aave / Morpho / Compound / Uniswap** |

Generation is **deterministic template composition, not AI.** That is the point: it is
why OpenZeppelin's output is trusted, and it means the output compiles every time.

---

## Two test suites, and why

Tests that only check the code we wrote would be decoration: the generated contract
passes them by construction. So each download ships two suites with two different jobs.

**`test/<Name>.attack.t.sol` — the regression suite for the mitigations.** One test per
mitigation, each derived from a documented incident. It does not prove the code is
safe; it proves the defences it shipped with are still there after you change it.
Delete a mitigation and the matching test goes red:

| Removed | Test that fails |
|---|---|
| `revert NotSelfInitiated` | `test_RejectsThirdPartyInitiator` |
| `revert MissingSlippageBound` | `test_RejectsZeroMinAmountOut` |
| `whenNotPaused` | `test_Paused…RevertsCleanly` |
| internal accounting → live balance | `test_Resists…Donation` |
| the position cap in `_withdrawFromComet` | `test_WithdrawCannotOpenBorrow` |
| the transfer lock in `LaunchToken._update` | `test_TokensLockedUntilGraduation` |

**`test/<Name>.props.t.sol` — for what you add.** Fuzz tests and a stateful invariant
handler over properties that hold for the generated contract and must keep holding for
any strategy, hook or feature layered on top: round trips never profit, previews match
execution, donations of any size do not move the share price, harvest never lowers the
price, the book never exceeds the market position, every holder can always leave in full.
For the flash-loan receiver the headline property is *a loan initiated by the operator
either reverts or costs at most the premium* — the property to keep when
`_executeStrategy()` is filled in.

The suites are **asset-agnostic**: the aToken, decimals and amounts are resolved on the
fork, so the same suite is valid for USDC and WETH.

---

## What's actually verified

Not aspirations — these were executed, against dRPC's free archive endpoint at block
25,710,954, with Foundry 1.7.1.

```
6 of 6 presets compile         solc 0.8.27, 0 errors, 0 warnings
6 of 6 exported projects       setup.sh → forge build → forge test, from a clean unzip

MyAaveVault        7 attack + 6 fuzz + 4 invariants   17/17
MyMorphoVault      7 attack + 6 fuzz + 4 invariants   17/17
MyCompoundVault    8 attack + 6 fuzz + 4 invariants   18/18
MyTokenSale       10 attack + 3 fuzz + 3 invariants   16/16
MyLaunch           9 attack + 3 fuzz + 5 invariants   17/17
MyFlashLoanReceiver 7 attack + 3 fuzz + 2 invariants  12/12
                                                      97/97
Same four asset-bound presets with WETH instead of USDC: green.

Audit corpus: 38 findings, 53 mutations. Every preset's clean output triggers
nothing; each mutation triggers exactly the finding that names it.
```

The property suite earned its place before it shipped: run against the real markets it
found a one-wei drift in the Aave vault's fee path (Aave's scaled-balance rounding can
leave the aToken balance a unit below the book, which fails the last redeemer), and a
harvest that would revert on a dust-sized fee. Both are fixed in the generator — fees
accrue and are collected separately, and every path that moves the position clamps the
book to it.

---

## Run it

```bash
# the app
cd harness-web && npm install && npm run dev

# a generated project — download the zip from the UI, then
./setup.sh
cp .env.example .env      # the default RPC is free and serves the pinned block
forge test -vv
```

`.env.example` points at a free archive RPC. If it times out under the invariant runs,
add `--fork-retries 10 --fork-retry-backoff 1000 --compute-units-per-second 25` to the
forge command, or use your own endpoint.

Developer checks, from `harness-web/`:

```bash
npm run verify        # compile every preset with solc, then mutation-test the audit corpus
npm run verify:emit   # write every exported project to .harness-out/, ready for forge
npm run preview -- morpho-blue-vault properties   # print a generated file
```

---

## Layout

```
contract/types.ts       the shared interface contract — wire format, presets, finding
                        IDs, remappings, API routes. Copied into both apps by
                        harness-web's sync:shared script before every build.
fixtures/               attack-test snippets, keyed by finding ID
harness-web/            Next.js app: generators, audit engine, preview, export
  src/generator/        one module per preset, plus the shared market catalogue
  src/audit/            the findings corpus and the rule engine
  src/generator/attacks/     attack-test assembler and per-preset scaffolds
  src/generator/properties/  fuzz + invariant assembler
harness-api/            compile, deploy, simulate (Tenderly)
harness-mcp/            the same generate / audit / advise tools, as an MCP server
```

`harness-web/src/app/api/compile` is a real solc compile running server-side; the audit
engine runs in the app and needs no network.

---

## Honest status

Built and verified: six generators, the audit corpus with mutation tests, both test
assemblers, the settings advisor against live Aave, Morpho and Compound state, project
export, server-side compile, and the MCP server.

Not wired: Tenderly deployment and scenario simulation live in `harness-api` and need a
Virtual Environment of your own; the one this project was built on is rate-limited.

We do not claim the generated code is audit-grade. We claim it starts from the hardened
pattern rather than the tutorial pattern, and ships the tests that prove the difference.

---

## Attribution

- [sanbir/evm-hack-registry](https://github.com/sanbir/evm-hack-registry) — ~845
  offline-runnable exploit PoCs, the source of most incident citations
- [SunWeb3Sec/DeFiHackLabs](https://github.com/SunWeb3Sec/DeFiHackLabs) — the corpus it
  derives from, and the 2025–2026 launchpad PoCs
- [AuditWare/AuditVault](https://github.com/AuditWare/AuditVault) — the `vuln/*` taxonomy
- [OpenZeppelin Contracts](https://github.com/OpenZeppelin/openzeppelin-contracts) and
  `@openzeppelin/wizard`, whose `ContractBuilder` and `printContract` this is built on
- [@bgd-labs/aave-address-book](https://github.com/bgd-labs/aave-address-book),
  [Morpho's API](https://blue-api.morpho.org/graphql) and
  [compound-finance/comet](https://github.com/compound-finance/comet) — canonical addresses

## License

HARNESS is **AGPL-3.0-only**, inherited from `@openzeppelin/wizard`. §13 is a network
copyleft: hosting this obliges you to offer the corresponding source. Generated
contracts are unaffected — they carry their own MIT SPDX header.
