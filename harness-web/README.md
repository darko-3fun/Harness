# harness-web

The HARNESS app: a Next.js wizard that generates hardened DeFi contracts, audits Solidity
against a corpus of documented findings, and exports a runnable Foundry project. See the
[root README](../README.md) for what it is and why.

## Run

```bash
npm install
npm run dev          # http://localhost:3000
```

No environment variables are required. Optional:

| Variable | Effect |
|---|---|
| `HARNESS_RPC_URL` | RPC the settings advisor reads live market state from (default: a free public endpoint) |
| `NEXT_PUBLIC_API_BASE` | Send compiles to a running `harness-api` instead of the local solc route |

## Check

```bash
npm run typecheck     # tsc
npm run lint          # eslint
npm run verify        # every preset compiles with solc; audit rules pass the mutation test
npm run verify:emit   # write every exported project to .harness-out/ for forge
npm run preview -- <preset> [contract|attacks|properties|deploy] [json-overrides]
```

To run a generated project's suites on a mainnet fork, emit it and follow its README —
`setup.sh`, then `forge test`. Foundry is not a dependency of the app itself.

## Layout

```
src/types.ts                  copy of ../contract/types.ts (never edit here; run sync:shared)
src/generator/
  index.ts                    preset dispatch, labels, blurbs, defaults
  shared.ts                   validation, access gates, print polish
  markets.ts                  the on-chain catalogue: assets, Aave, Morpho markets, Comets, Uniswap
  aave/ morpho/ compound/     one generator per vault; aave/ also has the flash-loan receiver
  launchpad/                  token sale, bonding curve
  vaults/                     ERC-4626 limits and yield booking shared by every vault
  attacks/                    attack-test assembler + per-preset test/deploy scaffolds
  properties/                 fuzz + invariant assembler
  deployScript.ts             Foundry deploy script from the same builder as the contract
src/audit/                    findings corpus + rule engine (masked, concept-based, mutation-tested)
src/lib/exportProject.ts      zip layout, foundry.toml, setup.sh, README, Remix link
src/app/api/                  generate, audit, compile (solc), vault-analysis (live market reads)
src/components/               editor, preset menus, audit / advice / tests panels
scripts/                      compile-all, mutate-audit, emit-projects, preview, sync-shared
```

Adding a preset means: a case in `generator/index.ts`, a scaffold in
`attacks/scaffold.ts`, snippets in `../fixtures/attack-snippets.json`, a body in
`properties/assemblePropertyTests.ts`, findings in `audit/findings.ts`, mutations in
`scripts/mutate-audit.ts`. The `Preset` union is exhaustive, so anything missed is a
compile error.
