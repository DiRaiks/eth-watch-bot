import { erc20Abi, getAbiItem, type Address, type PublicClient } from 'viem';

import type { ChainReader, TokenInfo } from './types.js';

const transferEvent = getAbiItem({ abi: erc20Abi, name: 'Transfer' });
const MAX_CACHED_TOKENS = 5000;

// Token metadata is written by whoever deployed the token: allow short ticker-like
// symbols only, so a spam token cannot put a phishing text or a huge string into a message
const SAFE_SYMBOL = /^[\p{L}\p{N}$._+-]{1,12}$/u;
export const safeSymbol = (symbol: string) => {
  const trimmed = symbol.trim();
  return SAFE_SYMBOL.test(trimmed) ? trimmed : '';
};

export const viemReader = (client: PublicClient): ChainReader => {
  const tokens = new Map<Address, Promise<TokenInfo>>();

  const loadTokenInfo = async (
    token: Address,
  ): Promise<TokenInfo & { complete: boolean }> => {
    const [symbol, decimals] = await Promise.allSettled([
      client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'symbol',
      }),
      client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'decimals',
      }),
    ]);
    return {
      // Old tokens with bytes32 symbols and unsafe symbols show up as the address
      symbol: symbol.status === 'fulfilled' ? safeSymbol(symbol.value) : '',
      decimals: decimals.status === 'fulfilled' ? decimals.value : null,
      complete:
        symbol.status === 'fulfilled' && decimals.status === 'fulfilled',
    };
  };

  return {
    getChainId: () => client.getChainId(),

    getBlockNumber: async () =>
      Number(await client.getBlockNumber({ cacheTime: 0 })),

    async getBlock(number) {
      const block = await client.getBlock({
        blockNumber: BigInt(number),
        includeTransactions: true,
      });
      return {
        number: Number(block.number),
        hash: block.hash,
        timestamp: Number(block.timestamp),
        transactions: block.transactions.map((tx) => ({
          hash: tx.hash,
          from: tx.from,
          to: tx.to ?? null,
          value: tx.value,
          input: tx.input,
        })),
      };
    },

    async getTransferLogs(blockHash) {
      // ERC-721 shares the event signature but indexes the token id (4 topics);
      // strict decoding drops those logs
      const logs = await client.getLogs({
        blockHash,
        event: transferEvent,
        strict: true,
      });
      return logs
        .filter((log) => log.topics.length === 3)
        .map((log) => ({
          token: log.address,
          from: log.args.from,
          to: log.args.to,
          value: log.args.value,
          transactionHash: log.transactionHash,
          logIndex: log.logIndex,
        }));
    },

    getTokenInfo(token) {
      const cached = tokens.get(token);
      if (cached) return cached;
      if (tokens.size >= MAX_CACHED_TOKENS) tokens.clear();
      const info = loadTokenInfo(token).then(({ complete, ...rest }) => {
        // A failed call may be a passing RPC error: ask again next time
        if (!complete) tokens.delete(token);
        return rest;
      });
      tokens.set(token, info);
      return info;
    },
  };
};
