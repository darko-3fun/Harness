#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
/**
 * HARNESS as an MCP server.
 *
 * The point is `harness_audit`. An LLM asked for an Aave flash-loan receiver
 * reliably writes the tutorial pattern — a callback gated only on
 * `msg.sender == POOL` — which is the Critical that drained DODO and Mimo. An
 * agent can call this and be told, deterministically, which documented findings
 * its own code has, with the incident and a runnable PoC for each.
 *
 * Generation is deliberately the *second* tool: OpenZeppelin already ships
 * `@openzeppelin/wizard-mcp`, so a generate-only server would be a me-too.
 *
 * Thin by design — it calls the deployed HTTP API rather than embedding the
 * generator, so an agent never needs a local build and the server can't drift
 * from what the site serves.
 */
const API_BASE = (process.env.HARNESS_API_BASE ?? 'https://harness-web-livid.vercel.app').replace(/\/$/, '');
// Kept in step with PRESET_LIST in contract/types.ts. This package does not share
// that module, so the API validates the preset too — a stale copy here is a bad
// error message, never an accepted request for a preset the server rejects.
const PRESETS = [
    'aave-v3-erc4626-vault',
    'morpho-blue-vault',
    'compound-v3-vault',
    'token-sale-launchpad',
    'bonding-curve-launchpad',
    'aave-v3-flashloan-receiver',
];
const VAULT_PRESETS = ['aave-v3-erc4626-vault', 'morpho-blue-vault', 'compound-v3-vault'];
async function callApi(path, body) {
    const res = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    const parsed = await res.json().catch(() => null);
    if (!res.ok) {
        const message = parsed?.error ?? `${res.status} ${res.statusText}`;
        throw new Error(`${path} failed: ${message}`);
    }
    return parsed;
}
/** MCP tool results are content blocks; every tool here returns one text block. */
const text = (s) => ({ content: [{ type: 'text', text: s }] });
const server = new McpServer({ name: 'harness', version: '0.1.0' });
server.registerTool('harness_audit', {
    title: 'Audit DeFi Solidity',
    description: 'Audit Solidity against a corpus of documented DeFi integration findings: ERC-4626 ' +
        'vaults over Aave v3, Morpho Blue and Compound v3, token-sale and bonding-curve ' +
        'launchpads, and Aave flash-loan receivers. Returns each finding as mitigated or ' +
        'triggered, with the historical incident it derives from and a link to a runnable ' +
        'exploit PoC. Every rule is mutation-tested. Call this on any contract of one of ' +
        'these shapes before presenting it as finished.',
    inputSchema: {
        source: z.string().describe('The full Solidity source to audit.'),
        preset: z
            .enum(PRESETS)
            .describe('Which shape the code is. The corpus applies the rules that fit that shape.'),
    },
}, async ({ source, preset }) => {
    const r = await callApi('/api/audit', { source, preset });
    const triggered = r.findings.filter((f) => f.status === 'triggered');
    const lines = [
        `${r.score.mitigated} mitigated, ${r.score.triggered} triggered.`,
        '',
    ];
    if (triggered.length === 0) {
        lines.push('No findings triggered against this corpus.');
    }
    else {
        for (const f of triggered) {
            lines.push(`[${f.severity.toUpperCase()}] ${f.id} — ${f.title}`);
            lines.push(`  ${f.summary}`);
            lines.push(`  Fix: ${f.remediation}`);
            for (const i of f.incidents) {
                lines.push(`  Incident: ${i.name} — ${i.url}`);
                if (i.pocFolder) {
                    lines.push(`  Runnable PoC: https://github.com/sanbir/evm-hack-registry/tree/main/${i.pocFolder}`);
                }
            }
            lines.push('');
        }
    }
    const mitigated = r.findings.filter((f) => f.status === 'mitigated').map((f) => f.id);
    if (mitigated.length)
        lines.push(`Mitigated: ${mitigated.join(', ')}`);
    return text(lines.join('\n'));
});
server.registerTool('harness_generate', {
    title: 'Generate a hardened DeFi contract',
    description: 'Generate a DeFi contract that is already hardened against the documented findings — ' +
        'an ERC-4626 vault over Aave v3, Morpho Blue or Compound v3, a fixed-price token sale, ' +
        'a bonding-curve launch that graduates into Uniswap V2, or an Aave flash-loan receiver — ' +
        'together with two Foundry suites that run on a mainnet fork: attack tests that fail ' +
        'when a mitigation is removed, and fuzz/invariant properties that must keep holding ' +
        'for anything built on top. Deterministic template composition: the same options ' +
        'always produce the same code. Prefer this over writing one of these from scratch.',
    inputSchema: {
        preset: z.enum(PRESETS).describe('Which contract to generate.'),
        name: z
            .string()
            .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
            .optional()
            .describe('Contract name. Must be a valid Solidity identifier.'),
        asset: z
            .string()
            .regex(/^0x[a-fA-F0-9]{40}$/)
            .optional()
            .describe('Underlying ERC20 address (vaults and the flash-loan receiver). Defaults to mainnet USDC. ' +
            'Morpho: USDC, USDT, WETH or DAI. Compound: USDC, WETH or USDT.'),
        access: z.enum(['none', 'ownable', 'roles']).optional(),
        pausable: z.boolean().optional(),
        routerAllowlist: z.boolean().optional().describe('Flash-loan preset only.'),
        claimRewards: z.boolean().optional().describe('Aave and Compound presets.'),
        sweepEscapeHatch: z.boolean().optional(),
        depositCap: z.string().optional().describe('Vaults. Raw token units, decimal string.'),
        feeBps: z.number().int().min(0).max(1000).optional().describe('Vaults. Performance fee on yield.'),
        decimalsOffset: z
            .number()
            .int()
            .min(0)
            .max(12)
            .optional()
            .describe('Vaults. Virtual-share exponent defending the inflation attack.'),
        morphoMarketId: z
            .string()
            .regex(/^0x[a-fA-F0-9]{64}$/)
            .optional()
            .describe('Morpho vault. A catalogued market id; defaults to the deepest market for the asset.'),
        tokenPriceWei: z.string().optional().describe('Token sale. Wei per whole token.'),
        hardCapWei: z.string().optional().describe('Token sale. Total ETH accepted, in wei.'),
        softCapWei: z.string().optional().describe('Token sale. Below this at close the sale refunds, in wei.'),
        minContributionWei: z.string().optional().describe('Token sale. Per-transaction floor in wei; 0 disables.'),
        maxContributionWei: z.string().optional().describe('Token sale. Per-wallet ceiling in wei; 0 disables.'),
        whitelist: z.boolean().optional().describe('Token sale. Merkle allowlist bound to the caller.'),
        vestingCliffDays: z.number().int().min(0).max(365).optional().describe('Token sale.'),
        vestingDurationDays: z.number().int().min(0).max(1460).optional().describe('Token sale. Linear after the cliff.'),
        curveSupply: z.string().optional().describe('Bonding curve. Whole tokens sold on the curve.'),
        graduationEth: z.string().optional().describe('Bonding curve. Wei raised at which it graduates into Uniswap V2.'),
        tradingFeeBps: z.number().int().min(0).max(500).optional().describe('Bonding curve.'),
        maxWalletBps: z.number().int().min(0).max(5000).optional().describe('Bonding curve. 0, or 50..5000 bps of the curve per wallet.'),
    },
}, async (args) => {
    const r = await callApi('/api/generate', args);
    return text([
        `Generated ${r.contractName}, hardened against ${r.appliedFindingIds.length} findings: ${r.appliedFindingIds.join(', ')}`,
        '',
        `// src/${r.contractName}.sol`,
        r.contractSource,
        '',
        `// test/${r.contractName}.attack.t.sol — ${r.testNames.length} attack tests, each fails when its mitigation is removed: ${r.testNames.join(', ')}`,
        r.attackTestSource,
        '',
        `// test/${r.contractName}.props.t.sol — ${r.propertyTests.length} properties that must keep holding for anything built on top`,
        r.propertyTestSource,
        '',
        `// script/${r.contractName}.s.sol`,
        r.deployScriptSource,
    ].join('\n'));
});
server.registerTool('harness_vault_settings', {
    title: 'Check vault settings against a live lending market',
    description: "Judge an ERC-4626 vault's deposit cap, performance fee and virtual-share offset " +
        "against a lending market's live state, sweep neighbouring values to show where " +
        'each verdict flips, and stress the deposit cap against rising utilisation. Use ' +
        'this before committing to vault parameters — the correct values depend on current ' +
        'market headroom, liquidity and APY, not on taste. Supports Aave v3, Morpho Blue and ' +
        'Compound v3, which answer differently: Morpho and Compound have no supply cap on ' +
        'the asset at all, so liquidity is the only ceiling.',
    inputSchema: {
        preset: z
            .enum(VAULT_PRESETS)
            .default('aave-v3-erc4626-vault')
            .describe('Which lending market to judge against.'),
        morphoMarketId: z
            .string()
            .regex(/^0x[a-fA-F0-9]{64}$/)
            .optional()
            .describe('Morpho only. A catalogued market id; defaults to the deepest market for the asset.'),
        asset: z
            .string()
            .regex(/^0x[a-fA-F0-9]{40}$/)
            .describe('Underlying ERC20 address, e.g. mainnet USDC.'),
        depositCap: z.string().optional().describe('Raw token units, decimal string.'),
        feeBps: z.number().int().min(0).max(1000).optional(),
        decimalsOffset: z.number().int().min(0).max(12).optional(),
    },
}, async (args) => {
    // The preset was hardcoded here, so asking about Morpho returned Aave's
    // reserve — the wrong market, rendered confidently. It is a parameter now.
    const r = await callApi('/api/vault-analysis', args);
    const m = r.market;
    const lines = [
        `${m.protocol} right now — supply cap ${m.supplyCap}, supplied ${m.supplied}, ` +
            `headroom ${m.headroom}, available liquidity ${m.availableLiquidity}, ` +
            `supply APY ${Number(m.supplyApyPct).toFixed(2)}%, ` +
            `${m.protocolFeeLabel.toLowerCase()} ${m.protocolFeePct.toFixed(0)}%` +
            (m.extra.length ? `, ${m.extra.map((e) => `${e.label.toLowerCase()} ${e.value}`).join(', ')}` : '') +
            '.',
        '',
    ];
    for (const a of r.advice) {
        lines.push(`[${a.verdict.toUpperCase()}] ${a.label}: ${a.current}` +
            (a.recommended ? ` → recommended ${a.recommended}` : '') +
            (a.finding ? ` (${a.finding})` : ''));
        lines.push(`  ${a.detail}`);
    }
    lines.push('', 'Where each verdict flips:');
    for (const s of r.sweeps)
        lines.push(`  ${s.label}: ${s.frontier}`);
    if (r.stress)
        lines.push('', `${r.stress.title}: ${r.stress.summary}`);
    return text(lines.join('\n'));
});
await server.connect(new StdioServerTransport());
