/**
 * Aave v3 Ethereum mainnet, taken from @bgd-labs/aave-address-book rather than
 * recalled. §9.1 says never hardcode the Pool — it is resolved from the provider
 * at runtime, which is why only the provider appears here.
 */
export const MAINNET = {
  POOL_ADDRESSES_PROVIDER: '0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e',
  REWARDS_CONTROLLER: '0x8164Cc65827dcFe994AB23944CBC90e0aa80bFcb',
  USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  aUSDC: '0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c',
  WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  aWETH: '0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8',
} as const;
