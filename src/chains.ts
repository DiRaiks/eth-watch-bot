import { arbitrum, base, mainnet, optimism, type Chain } from 'viem/chains';

export const CHAIN_NAMES = [
  'ethereum',
  'base',
  'arbitrum',
  'optimism',
] as const;
export type ChainName = (typeof CHAIN_NAMES)[number];

export type ChainInfo = {
  title: string;
  viem: Chain;
  explorer: string;
  nativeSymbol: string;
  /** Blocks to wait before a block counts as final enough to report */
  confirmations: number;
};

export const CHAINS: Record<ChainName, ChainInfo> = {
  ethereum: {
    title: 'Ethereum',
    viem: mainnet,
    explorer: 'https://etherscan.io',
    nativeSymbol: 'ETH',
    confirmations: 3,
  },
  base: {
    title: 'Base',
    viem: base,
    explorer: 'https://basescan.org',
    nativeSymbol: 'ETH',
    confirmations: 10,
  },
  arbitrum: {
    title: 'Arbitrum',
    viem: arbitrum,
    explorer: 'https://arbiscan.io',
    nativeSymbol: 'ETH',
    confirmations: 20,
  },
  optimism: {
    title: 'Optimism',
    viem: optimism,
    explorer: 'https://optimistic.etherscan.io',
    nativeSymbol: 'ETH',
    confirmations: 10,
  },
};

export const isChainName = (value: string): value is ChainName =>
  (CHAIN_NAMES as readonly string[]).includes(value);

export const txUrl = (chain: ChainName, hash: string) =>
  `${CHAINS[chain].explorer}/tx/${hash}`;

export const addressUrl = (chain: ChainName, address: string) =>
  `${CHAINS[chain].explorer}/address/${address}`;
