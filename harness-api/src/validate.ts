// Spec §5.4 (CVE-2026-48054): every user-controlled value is strictly validated and REJECTED,
// never sanitized.

import type { Preset, Scenario } from './types.js';

export class ValidationError extends Error {}

const CONTRACT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const HEX_BYTES = /^0x([a-fA-F0-9]{2})*$/;
const UINT_DECIMAL = /^[0-9]{1,78}$/;
const FN_SIGNATURE = /^[A-Za-z_][A-Za-z0-9_]*\((|[a-z0-9\[\],]+)\)$/;

export const MAX_SOURCE_BYTES = 512 * 1024;
export const MAX_CONTRACT_NAME_LENGTH = 64;

const PRESETS: Preset[] = ['aave-v3-flashloan-receiver', 'aave-v3-erc4626-vault'];
const SCENARIOS: Scenario[] = ['supply-borrow', 'flashloan-simple', 'leverage-loop', 'vault-deposit'];

export function assertContractName(value: unknown, field = 'contractName'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CONTRACT_NAME_LENGTH) {
    throw new ValidationError(`${field} must be a string of 1..${MAX_CONTRACT_NAME_LENGTH} chars`);
  }
  if (!CONTRACT_NAME.test(value)) {
    throw new ValidationError(`${field} must match ^[A-Za-z_][A-Za-z0-9_]*$`);
  }
  return value;
}

export function assertAddress(value: unknown, field = 'address'): `0x${string}` {
  if (typeof value !== 'string' || !ADDRESS.test(value)) {
    throw new ValidationError(`${field} must match ^0x[a-fA-F0-9]{40}$`);
  }
  return value as `0x${string}`;
}

export function assertHexBytes(value: unknown, field = 'params'): `0x${string}` {
  if (typeof value !== 'string' || !HEX_BYTES.test(value) || value.length > 8192) {
    throw new ValidationError(`${field} must be even-length hex (0x…), max 4KB`);
  }
  return value as `0x${string}`;
}

export function assertSource(value: unknown, field = 'source'): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${field} is required`);
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_SOURCE_BYTES) {
    throw new ValidationError(`${field} exceeds ${MAX_SOURCE_BYTES} bytes`);
  }
  if (value.includes('\0')) throw new ValidationError(`${field} contains a NUL byte`);
  // Editors and Windows tooling prepend a BOM; solc reports it as a line-1 ParserError.
  return value.replace(/^\uFEFF/, '');
}

export function assertPreset(value: unknown, field = 'preset'): Preset {
  if (typeof value !== 'string' || !PRESETS.includes(value as Preset)) {
    throw new ValidationError(`${field} must be one of ${PRESETS.join(' | ')}`);
  }
  return value as Preset;
}

export function assertScenario(value: unknown, field = 'scenario'): Scenario {
  if (typeof value !== 'string' || !SCENARIOS.includes(value as Scenario)) {
    throw new ValidationError(`${field} must be one of ${SCENARIOS.join(' | ')}`);
  }
  return value as Scenario;
}

/** Bounded uint as a decimal string, so bigints never cross the wire as JSON numbers. */
export function assertUintString(value: unknown, field: string, max: bigint): bigint {
  const raw = typeof value === 'number' ? String(value) : value;
  if (typeof raw !== 'string' || !UINT_DECIMAL.test(raw)) {
    throw new ValidationError(`${field} must be a non-negative integer decimal string`);
  }
  const parsed = BigInt(raw);
  if (parsed > max) throw new ValidationError(`${field} exceeds the allowed maximum (${max})`);
  return parsed;
}

export function assertFunctionSignature(value: unknown, field = 'entrypoint'): string {
  if (typeof value !== 'string' || value.length > 128 || !FN_SIGNATURE.test(value)) {
    throw new ValidationError(`${field} must look like myFunction(address,uint256,bytes)`);
  }
  return value;
}

/** Constructor args are restricted to the shapes the generator can actually emit. */
export function assertConstructorArgs(value: unknown): (string | bigint | boolean)[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 12) {
    throw new ValidationError('constructorArgs must be an array of at most 12 items');
  }
  return value.map((arg, i) => {
    if (typeof arg === 'boolean') return arg;
    if (typeof arg === 'string' && ADDRESS.test(arg)) return arg;
    if (typeof arg === 'string' && UINT_DECIMAL.test(arg)) return BigInt(arg);
    if (typeof arg === 'number' && Number.isSafeInteger(arg) && arg >= 0) return BigInt(arg);
    throw new ValidationError(
      `constructorArgs[${i}] must be an address, a non-negative integer decimal string, or a boolean`,
    );
  });
}
