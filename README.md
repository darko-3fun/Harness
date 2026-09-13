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

Audit corpus: 37 findings, 53 mutations. Every preset's clean output triggers
nothing; each mutation triggers exactly the finding that names it.

harness-api on a local Anvil fork:
  4 of 4 scenarios            deploy + simulate against the real Aave Pool
  twice in a row, same fork   identical results — snapshots and a fork reset
  smoke / compile:check / route:check / verify:generated   all green
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
harness-api/            compile, deploy, simulate against a local Anvil fork
  src/chain.ts          the fork client: cheatcodes, impersonation, snapshots, tracing
harness-mcp/            the same generate / audit / advise tools, as an MCP server
```

`harness-web/src/app/api/compile` is a real solc compile running server-side; the audit
engine runs in the app and needs no network.

---

## Honest status

Built and verified: six generators, the audit corpus with mutation tests, both test
assemblers, the settings advisor against live Aave, Morpho and Compound state, project
export, server-side compile, deploy and simulate against a local fork, and the MCP server.

Known gaps, stated plainly. The simulate scenarios still speak Aave only — the four of
them predate the Morpho, Compound and launchpad presets, which have full test suites but
no scenario. The two hand-written reference contracts in `harness-api/contracts/samples`
are older than the generator and the audit engine reports one real gap in the flash-loan
one, which its own checks name rather than hide.

---

## Does any of this need an account? No.

Nothing here requires a key, a login or a paid plan — including deploy and simulate,
which run against a local [Anvil](https://getfoundry.sh) fork rather than a hosted one.

| | Needs an account? |
|---|---|
| Generate any preset | no |
| Audit, including code you paste or edit | no — the engine runs locally, offline |
| Compile | no — solc runs server-side |
| Settings advisor reading live Aave / Morpho / Compound state | no — a public RPC |
| Download a project and run both suites on a mainnet fork | no — a public archive RPC |
| **Deploy a contract and simulate scenarios against real Aave** | **no — a local Anvil fork** |

The exported project ships `MAINNET_RPC_URL=https://eth.drpc.org` and `FORK_BLOCK`, which
is only a block number. A clean download was verified with every `TENDERLY_*` variable
unset: 17/17 on the Aave vault, the same numbers as any other run.

---

## Deploy and simulate

Start a fork, then start the service. Neither needs anything configured:

```bash
# 1. a fork of real mainnet, pinned so runs are reproducible
anvil --fork-url https://eth.drpc.org --fork-block-number 25710954

# 2. the service
cd harness-api && npm install && npm start     # http://localhost:8787/health
```

`npm run fork` prints that exact command and says whether a usable fork is already
running. On Windows, run Anvil inside WSL — the port is reachable from Windows as-is.

Then:

```bash
npm run seed          # real USDC and WETH on the fork
npm run chain:check   # deploy both samples, run all four scenarios, print traces
```

### What the scenarios prove

`chain:check` deploys the two reference contracts and runs every scenario against the
real Aave Pool on the fork. The headline is `vault-deposit`, which runs the actual
first-depositor inflation attack rather than gesturing at it: an attacker opens a dust
position, donates 100,000 aUSDC straight at the vault, then a victim deposits 25,000.

```
attacker donated (aToken, direct transfer): +99999.999999
victim deposited:                           +25000
victim redeemable after the donation:       +25000
victim value LOST to the attacker:          +0
attacker spend per unit extracted:          infinite — attack extracted nothing
```

Each scenario runs from a snapshot and the fork is reset at the start of every run, so
the four are independent and the suite gives the same answer however many times you run
it. That is not cosmetic: scenarios share a deployer and the same Aave reserves, and
without isolation an earlier position decides whether a later borrow is collateralised.

### Why a local fork loses nothing

A fork copies real mainnet state at one block and gives you a private timeline. That was
equally true of the hosted environment this replaced — neither follows the chain live.
Same contracts, same liquidity, same oracle prices, same EVM.

Three RPC methods had to change, all mechanical:

| Hosted fork | Local Anvil |
|---|---|
| `tenderly_setBalance` | `anvil_setBalance` |
| `tenderly_setErc20Balance` | no equivalent — the balance slot is discovered, then written with `anvil_setStorageAt` |
| `eth_sendTransaction` from any address | `anvil_autoImpersonateAccount`, then the same call |

Token balances are the interesting one. A token's balance mapping sits at a slot number
that is an implementation detail of that token, so the slot is **discovered**: write a
value at a candidate, ask the token what it now reports, keep the slot that agrees and
roll back every other write. That is what Foundry's own `deal` cheatcode does, and it
works on USDC, WETH, DAI and WBTC without a hardcoded table.

The one thing genuinely lost is a public, shareable explorer URL, because a local chain
has nowhere to publish to. `EXPLORER_BASE` is read if you run an explorer against the
fork (Otterscan, say); otherwise deploy and simulate report no link rather than a broken
one.

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
