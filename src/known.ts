import { getAddress, type Address } from 'viem';

import type { ChainName } from './chains.js';

/**
 * Names shown instead of a bare address for well-known contracts. Matched by exact
 * address only, so a look-alike cannot borrow a name. Checked on chain: each answers
 * name() with the matching token, or holds Permit2's code.
 */
const KNOWN: Record<ChainName, Record<string, string>> = {
  ethereum: {
    '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84': 'Lido stETH',
    '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0': 'Lido wstETH',
    '0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1': 'Lido Withdrawal Queue',
    '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2': 'WETH',
    '0x000000000022D473030F116dDEE9F6B43aC78BA3': 'Uniswap Permit2',
  },
  base: {
    '0x4200000000000000000000000000000000000006': 'WETH',
    '0x000000000022D473030F116dDEE9F6B43aC78BA3': 'Uniswap Permit2',
  },
  arbitrum: {
    '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1': 'WETH',
    '0x000000000022D473030F116dDEE9F6B43aC78BA3': 'Uniswap Permit2',
  },
  optimism: {
    '0x4200000000000000000000000000000000000006': 'WETH',
    '0x000000000022D473030F116dDEE9F6B43aC78BA3': 'Uniswap Permit2',
  },
};

export const knownName = (chain: ChainName, address: Address) =>
  KNOWN[chain][getAddress(address)];
