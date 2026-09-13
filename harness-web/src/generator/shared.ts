import {
  ContractBuilder,
  OptionsError,
  printContract,
  requireAccessControl,
} from '@openzeppelin/wizard';

import {
  ADDRESS_RE,
  CONTRACT_NAME_RE,
  UINT_RE,
  type GenerateOptions,
} from '@/types';

/**
 * What every generator shares: the option validator, the access-control gate that
 * respects `access: 'none'`, the library descriptors `printContract` needs for
 * non-OpenZeppelin imports, and the post-print polish.
 */

export const imp = (name: string, path: string) => ({ name, path });

/** Third-party libraries `printContract` must recognise so it keeps their import prefix. */
export const LIBS = {
  aave: { name: 'Aave v3 Core', path: '@aave/core-v3', version: '^1.19.0' },
  aavePeriphery: { name: 'Aave v3 Periphery', path: '@aave/periphery-v3', version: '^2.5.0' },
  morpho: { name: 'Morpho Blue', path: '@morpho-org/morpho-blue', version: '^1.0.0' },
} as const;

export type ValidationMessages = Record<string, string>;

/** §5.4 / CVE-2026-48054 — reject, do not sanitize. */
export function validateCommon(opts: GenerateOptions, messages: ValidationMessages): void {
  if (!CONTRACT_NAME_RE.test(opts.name)) {
    messages.name = 'Not a valid Solidity identifier';
  }
  if (opts.asset !== undefined && !ADDRESS_RE.test(opts.asset)) {
    messages.asset = 'Not a valid 20-byte hex address';
  }
}

export function validateVaultSettings(opts: GenerateOptions, messages: ValidationMessages): void {
  if (opts.depositCap !== undefined && !UINT_RE.test(opts.depositCap)) {
    messages.depositCap = 'Must be a decimal integer in raw token units';
  }
  if (
    opts.feeBps !== undefined &&
    !(Number.isInteger(opts.feeBps) && opts.feeBps >= 0 && opts.feeBps <= 1000)
  ) {
    messages.feeBps = 'Must be an integer between 0 and 1000';
  }
  if (
    opts.decimalsOffset !== undefined &&
    !(Number.isInteger(opts.decimalsOffset) && opts.decimalsOffset >= 0 && opts.decimalsOffset <= 12)
  ) {
    messages.decimalsOffset = 'Must be an integer between 0 and 12';
  }
  if (opts.access === 'none') {
    messages.access = 'A vault holds principal; harvest, sweep and pause must be gated';
  }
}

/** Sends tokens to a caller-chosen address, so each of these needs a gate. */
export function validateGatedFeatures(opts: GenerateOptions, messages: ValidationMessages): void {
  if (opts.access !== 'none') return;
  if (opts.sweepEscapeHatch) {
    messages.sweepEscapeHatch = 'Requires access control — an ungated sweep drains the contract';
  }
  if (opts.claimRewards) {
    messages.claimRewards = 'Requires access control — an ungated claim redirects rewards';
  }
  if (opts.pausable) {
    messages.pausable = 'Requires access control — an ungated pause is a denial of service';
  }
}

export function throwIfInvalid(messages: ValidationMessages): void {
  if (Object.keys(messages).length > 0) throw new OptionsError(messages);
}

export const accessOf = (opts: GenerateOptions) => (opts.access === 'none' ? false : opts.access);

/**
 * `requireAccessControl` silently rewrites `false` to `'ownable'`, on the reasonable
 * assumption that a restricted function must be restricted by *something*. That would
 * make `access: 'none'` emit an Ownable contract while the UI claimed otherwise, so
 * the call is gated instead of the argument.
 */
export function gate(
  c: ContractBuilder,
  fn: Parameters<typeof requireAccessControl>[1],
  opts: GenerateOptions,
  roleIdPrefix: string,
  roleOwner: string | undefined,
): void {
  const access = accessOf(opts);
  if (access === false) return;
  requireAccessControl(c, fn, access, roleIdPrefix, roleOwner);
}

/**
 * Two quirks in `printContract` corrected on the way out:
 *   - blank lines inside a function body are emitted with the body's indentation,
 *     leaving trailing whitespace;
 *   - `printNatspecTags` renders `/// ${key} ${value}` verbatim, and `addNatspecTag`
 *     rejects a leading `@` on anything but `@custom:*`. So the `@` has to go back on;
 *   - an unnamed parameter (`{ type: 'address', name: '' }`) prints as `address )`.
 */
export function polish(source: string): string {
  return source
    .replace(/[ \t]+$/gm, '')
    .replace(/^\/\/\/ (title|notice|dev|author) /gm, '/// @$1 ')
    .replace(/\((address|uint256) \)/g, '($1)');
}

export function print(
  c: ContractBuilder,
  libs: { name: string; path: string; version: string }[] = [],
): string {
  return polish(printContract(c, { additionalCompatibleLibraries: libs }));
}

/**
 * Inserts hand-written top-level declarations (a minimal interface, a helper
 * contract) between the imports and the generated contract. Used where the
 * protocol ships no importable interface at a compatible pragma, so the generated
 * file stays self-contained for Remix, the compile route and Foundry alike.
 */
export function withPreamble(source: string, preamble: string): string {
  const idx = source.search(/^\/\/\/ @title|^contract /m);
  if (idx === -1) throw new Error('withPreamble: could not find the contract declaration');
  return source.slice(0, idx) + preamble.trimEnd() + '\n\n' + source.slice(idx);
}

/** A per-field error message the UI can show next to the offending control. */
export function describeOptionsError(e: unknown): string {
  const err = e as Error & { messages?: Record<string, string> };
  if (err?.messages && Object.keys(err.messages).length > 0) {
    return Object.entries(err.messages)
      .map(([field, msg]) => `${field}: ${msg}`)
      .join('\n');
  }
  return err?.message ?? String(e);
}
