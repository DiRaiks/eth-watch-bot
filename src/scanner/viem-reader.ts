import {
  erc20Abi,
  hexToNumber,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';

import { decodeTokenLog, mayConcern, TOKEN_TOPICS } from './token-logs.js';
import type { ChainReader, TokenInfo, TxReceipt } from './types.js';

const MAX_CACHED_TOKENS = 5000;
/** Tokens without full metadata (NFTs have no decimals) are asked again after this */
const INCOMPLETE_TTL_MS = 10 * 60_000;

const balanceAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
]);
const erc1155BalanceAbi = parseAbi([
  'function balanceOf(address, uint256) view returns (uint256)',
]);

// Token metadata is written by whoever deployed the token: allow short ticker-like
// symbols only, so a spam token cannot put a phishing text or a huge string into a message
const SAFE_SYMBOL = /^[\p{L}\p{N}$._+-]{1,12}$/u;
export const safeSymbol = (symbol: string) => {
  const trimmed = symbol.trim();
  return SAFE_SYMBOL.test(trimmed) ? trimmed : '';
};

export const viemReader = (
  client: PublicClient,
  rpcHost?: () => string | null,
): ChainReader => {
  const tokens = new Map<
    Address,
    { until: number; info: Promise<TokenInfo> }
  >();

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

    async getReceipt(hash): Promise<TxReceipt> {
      const receipt = await client.getTransactionReceipt({ hash });
      // OP Stack chains (Base, Optimism) also charge for posting the data to L1
      const { l1Fee } = receipt as { l1Fee?: bigint | null };
      return {
        success: receipt.status === 'success',
        fee: receipt.gasUsed * receipt.effectiveGasPrice + (l1Fee ?? 0n),
      };
    },

    getBalance: (address, blockNumber) =>
      client.getBalance({ address, blockNumber: BigInt(blockNumber) }),

    async isContract(address) {
      const code = await client.getCode({ address });
      return code !== undefined && code !== '0x';
    },
    ...(rpcHost && { rpcHost }),

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

    async getTokenLogs(blockHash, isWatched) {
      // Raw logs: ERC-20 and ERC-721 share event signatures and differ only in the
      // number of indexed topics, which typed decoding cannot tell apart
      const logs = await client.request({
        method: 'eth_getLogs',
        params: [{ blockHash, topics: [Object.values(TOKEN_TOPICS)] }],
      });
      return logs.flatMap((log) => {
        if (
          isWatched &&
          !mayConcern({ topics: log.topics as Hex[] }, isWatched)
        ) {
          return [];
        }
        const decoded = decodeTokenLog({
          address: log.address,
          topics: log.topics as Hex[],
          data: log.data,
          transactionHash: log.transactionHash!,
          logIndex: hexToNumber(log.logIndex!),
        });
        return decoded ? [decoded] : [];
      });
    },

    async getTokenBalance(token, owner, blockNumber, tokenId) {
      try {
        return tokenId === undefined
          ? await client.readContract({
              address: token,
              abi: balanceAbi,
              functionName: 'balanceOf',
              args: [owner],
              blockNumber: BigInt(blockNumber),
            })
          : await client.readContract({
              address: token,
              abi: erc1155BalanceAbi,
              functionName: 'balanceOf',
              args: [owner, tokenId],
              blockNumber: BigInt(blockNumber),
            });
      } catch {
        return null;
      }
    },

    getTokenInfo(token) {
      const cached = tokens.get(token);
      if (cached && cached.until > Date.now()) return cached.info;
      if (tokens.size >= MAX_CACHED_TOKENS) tokens.clear();
      const entry = {
        until: Infinity,
        info: Promise.resolve<TokenInfo>({ symbol: '', decimals: null }),
      };
      entry.info = loadTokenInfo(token).then(({ complete, ...rest }) => {
        // A failed call may be a passing RPC error, or an NFT without decimals: ask
        // again later, not on every block
        if (!complete) entry.until = Date.now() + INCOMPLETE_TTL_MS;
        return rest;
      });
      tokens.set(token, entry);
      return entry.info;
    },
  };
};
