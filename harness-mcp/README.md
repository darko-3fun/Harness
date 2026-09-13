# harness-mcp

HARNESS as an MCP server, so coding agents can use it directly.

## Why

An LLM asked for an Aave v3 flash-loan receiver reliably writes the tutorial
pattern — a callback gated only on `msg.sender == address(POOL)`. That is the
Critical that drained DODO MarginTrading and Mimo SuperVault: anyone can call
`Pool.flashLoan` naming *your* contract as the receiver, so the Pool genuinely
is the caller and the check passes.

`harness_audit` catches exactly that, deterministically, with the incident and a
runnable exploit PoC attached. Audited against the naive pattern:

```
0 mitigated, 8 triggered.

[CRITICAL] AAVE-FL-001 — Flash-loan callback not gated to Pool + initiator
  Fix: Revert unless msg.sender == address(POOL) AND initiator == address(this).
  Incident: DODO MarginTrading (Sherlock #150)
  Runnable PoC: github.com/sanbir/evm-hack-registry/tree/main/2021-03-dodo_flashloan_exp
```

Generation is deliberately the *second* tool — OpenZeppelin already ships
`@openzeppelin/wizard-mcp`, so a generate-only server would be a me-too.

## Tools

| Tool | What it does |
|---|---|
| `harness_audit` | Solidity + preset → findings, each mitigated or triggered, with incident and PoC. Six shapes: vaults over Aave v3 / Morpho Blue / Compound v3, token sale, bonding curve, flash-loan receiver |
| `harness_generate` | Preset + options → hardened contract, Foundry attack suite, fuzz/invariant property suite, deploy script |
| `harness_vault_settings` | Vault parameters vs the **live** market (Aave, Morpho or Compound), plus a sweep showing where each verdict flips |

## Install

```bash
npm install && npm run build
```

Then register it with your agent. For Claude Code:

```json
{
  "mcpServers": {
    "harness": { "command": "node", "args": ["/absolute/path/to/harness-mcp/dist/index.js"] }
  }
}
```

Set `HARNESS_API_BASE` to point at your own deployment; it defaults to
`https://harness-web-livid.vercel.app`.

The server is thin on purpose — it calls the HTTP API rather than embedding the
generator, so an agent needs no local build and the server cannot drift from
what the site serves.
