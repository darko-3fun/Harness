# harness-api

Compile, audit, deploy and simulate. The deploy and simulate half talks to a **local
Anvil fork of Ethereum mainnet** — no account, no key, no bill. See the
[root README](../README.md) for what the project is.

## Run

```bash
npm install

# a fork of real mainnet, pinned so runs are reproducible.
# On Windows run this inside WSL; the port is reachable from Windows as-is.
anvil --fork-url https://eth.drpc.org --fork-block-number 25710954

npm start        # http://localhost:8787/health
```

`npm run fork` prints that command and tells you whether a usable fork is already up.

Nothing needs configuring. Every value in `.env.example` is also the built-in default,
including the deployer key — Anvil's first dev account, which is published in Anvil's own
documentation and only ever holds play money on a local chain.

| Variable | Default | |
|---|---|---|
| `RPC_URL` | `http://127.0.0.1:8545` | the fork to talk to |
| `FORK_BLOCK` | `25710954` | pinned so a green run stays green; shared with the generated Foundry projects |
| `DEPLOYER_PRIVATE_KEY` | Anvil account 0 | replace it if `RPC_URL` points anywhere else |
| `EXPLORER_BASE` | empty | set only if you run an explorer against the fork (Otterscan, say) |
| `WEB_ORIGIN` | `http://localhost:3000` | CORS allowlist |

`TENDERLY_ADMIN_RPC`, `TENDERLY_FORK_BLOCK` and `TENDERLY_EXPLORER_BASE` are still read
as fallbacks, so an old `.env` keeps working.

## Check

```bash
npm run typecheck
npm run smoke            # offline: audit rules flip on edited code, fixtures are consistent
npm run compile:check    # solc against the real OZ + Aave sources
npm run route:check      # every HTTP route, including CORS   (needs the server running)
npm run seed             # real USDC and WETH on the fork     (needs a fork)
npm run chain:check      # deploy both samples, run all four scenarios (needs a fork)
npm run verify:generated # put the generator's own output through compile → audit → deploy → simulate
```

## Endpoints

| | |
|---|---|
| `GET /health` | findings loaded, RPC in use, fork block |
| `GET /remappings` | the import prefixes generated Solidity uses |
| `GET /findings` | the whole audit corpus |
| `POST /compile` | solc standard-JSON, OZ and Aave resolved from `node_modules` |
| `POST /audit` | findings for a source + preset |
| `POST /deploy` | compile, then deploy to the fork |
| `POST /simulate` | run a scenario against the real Aave Pool on the fork |

## How the fork is driven

`src/chain.ts` is the only module that talks to the chain. Three things are worth knowing.

**Balances are written, not begged for.** `anvil_setBalance` handles ETH. ERC-20 has no
cheatcode, so the balance slot is *discovered*: write a value at a candidate slot, ask the
token what it now reports, keep the slot that agrees and roll back every other write. Both
Solidity and Vyper mapping layouts are tried, and the answer is cached per token. This is
what Foundry's `deal` does, and it works on USDC, WETH, DAI and WBTC without a table.

**Scenarios are isolated from each other and from previous runs.** Each one starts from a
snapshot taken after deployment and seeding, and `chain:check` resets the fork before it
begins. Without that, scenarios share a deployer and the same Aave reserves, so an earlier
position decides whether a later borrow is collateralised — a scenario that passes alone
and fails in company.

**The vault scenario needs two parties.** A donation cannot rob a sole shareholder, it
just gifts the money back, so the attacker and the victim are separate addresses driven by
`anvil_autoImpersonateAccount` rather than by keys.

## The audit corpus is generated

`knowledge/findings.json` is written by `harness-web`'s `npm run sync:findings` from
`harness-web/src/audit/findings.ts`, where the rules are type-checked against the finding-ID
vocabulary and mutation-tested. Do not edit it by hand: the two copies had already drifted
once, leaving this service knowing 15 findings and two presets while the generator had
moved on to 37 and six.
