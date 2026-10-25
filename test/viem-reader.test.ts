import {
  createPublicClient,
  custom,
  encodeAbiParameters,
  encodeFunctionResult,
  erc20Abi,
  pad,
  toEventSelector,
  toHex,
  type PublicClient,
} from 'viem';
import { mainnet } from 'viem/chains';
import { describe, expect, it, vi } from 'vitest';

import { TOKEN_TOPICS } from '../src/scanner/token-logs.js';
import { safeSymbol, viemReader } from '../src/scanner/viem-reader.js';
import { ALICE, BOB, blockHash, CAROL, txHash, USDC } from './helpers.js';

const TRANSFER = toEventSelector('Transfer(address,address,uint256)');
const NFT = '0x2222222222222222222222222222222222222222';
const BROKEN = '0x3333333333333333333333333333333333333333';

type Request = { method: string; params?: unknown };

const rpcBlock = {
  number: toHex(100),
  hash: blockHash(100),
  parentHash: blockHash(99),
  timestamp: toHex(1_700_000_000),
  transactions: [
    {
      hash: txHash(1),
      from: ALICE,
      to: BOB,
      value: toHex(10n ** 18n),
      input: '0x68656c6c6f',
      blockHash: blockHash(100),
      blockNumber: toHex(100),
      transactionIndex: '0x0',
      nonce: '0x1',
      gas: '0x5208',
      type: '0x0',
      gasPrice: '0x1',
    },
    {
      hash: txHash(2),
      from: BOB,
      to: null,
      value: '0x0',
      input: '0x6080',
      blockHash: blockHash(100),
      blockNumber: toHex(100),
      transactionIndex: '0x1',
      nonce: '0x2',
      gas: '0x5208',
      type: '0x0',
      gasPrice: '0x1',
    },
  ],
};

const log = (
  address: string,
  topics: string[],
  data: string,
  logIndex: number,
) => ({
  address,
  topics,
  data,
  blockHash: blockHash(100),
  blockNumber: toHex(100),
  transactionHash: txHash(1),
  transactionIndex: '0x0',
  logIndex: toHex(logIndex),
  removed: false,
});

const fakeRpc = (requests: Request[]) =>
  createPublicClient({
    chain: mainnet,
    transport: custom(
      {
        async request({ method, params }: Request) {
          requests.push({ method, params });
          switch (method) {
            case 'eth_chainId':
              return toHex(1);
            case 'eth_blockNumber':
              return toHex(123);
            case 'eth_getBlockByNumber':
              return rpcBlock;
            case 'eth_getLogs':
              return [
                log(
                  USDC,
                  [TRANSFER, pad(ALICE), pad(BOB)],
                  encodeAbiParameters([{ type: 'uint256' }], [5n]),
                  0,
                ),
                // ERC-721: the token id is the 4th topic and there is no data
                log(
                  NFT,
                  [TRANSFER, pad(ALICE), pad(BOB), pad(toHex(7))],
                  '0x',
                  1,
                ),
              ];
            case 'eth_call': {
              const { to, data } = (
                params as [{ to: string; data: string }]
              )[0];
              if (to.toLowerCase() === BROKEN.toLowerCase())
                throw new Error('execution reverted');
              return data.startsWith('0x95d89b41')
                ? encodeFunctionResult({
                    abi: erc20Abi,
                    functionName: 'symbol',
                    result: 'USDC',
                  })
                : encodeFunctionResult({
                    abi: erc20Abi,
                    functionName: 'decimals',
                    result: 6,
                  });
            }
            default:
              throw new Error(`unexpected ${method}`);
          }
        },
      },
      { retryCount: 0 },
    ),
  }) as PublicClient;

describe('viemReader', () => {
  it('reads the chain id and the head', async () => {
    const reader = viemReader(fakeRpc([]));
    expect(await reader.getChainId()).toBe(1);
    expect(await reader.getBlockNumber()).toBe(123);
  });

  it('maps blocks with their transactions', async () => {
    const reader = viemReader(fakeRpc([]));
    expect(await reader.getBlock(100)).toEqual({
      number: 100,
      hash: blockHash(100),
      timestamp: 1_700_000_000,
      transactions: [
        {
          hash: txHash(1),
          from: ALICE,
          to: BOB,
          value: 10n ** 18n,
          input: '0x68656c6c6f',
        },
        { hash: txHash(2), from: BOB, to: null, value: 0n, input: '0x6080' },
      ],
    });
  });

  it('returns token transfers of a block, NFTs included', async () => {
    const requests: Request[] = [];
    const reader = viemReader(fakeRpc(requests));
    expect(await reader.getTokenLogs(blockHash(100))).toEqual([
      {
        type: 'erc20',
        token: USDC,
        from: ALICE,
        to: BOB,
        value: 5n,
        transactionHash: txHash(1),
        logIndex: 0,
      },
      {
        type: 'nft',
        token: NFT,
        from: ALICE,
        to: BOB,
        tokenIds: [7n],
        amounts: null,
        transactionHash: txHash(1),
        logIndex: 1,
      },
    ]);
    expect(requests.at(-1)).toEqual({
      method: 'eth_getLogs',
      params: [
        { blockHash: blockHash(100), topics: [Object.values(TOKEN_TOPICS)] },
      ],
    });
  });

  it('caches token info and survives tokens without metadata', async () => {
    const requests: Request[] = [];
    const reader = viemReader(fakeRpc(requests));
    expect(await reader.getTokenInfo(USDC)).toEqual({
      symbol: 'USDC',
      decimals: 6,
    });
    await reader.getTokenInfo(USDC);
    expect(requests.filter((r) => r.method === 'eth_call')).toHaveLength(2);

    expect(await reader.getTokenInfo(BROKEN)).toEqual({
      symbol: '',
      decimals: null,
    });
  });

  it('keeps incomplete token metadata for a while, not forever', async () => {
    vi.useFakeTimers();
    try {
      const requests: Request[] = [];
      const reader = viemReader(fakeRpc(requests));
      await reader.getTokenInfo(BROKEN);
      await reader.getTokenInfo(BROKEN);
      expect(requests.filter((r) => r.method === 'eth_call')).toHaveLength(2);
      vi.advanceTimersByTime(11 * 60_000);
      await reader.getTokenInfo(BROKEN);
      expect(requests.filter((r) => r.method === 'eth_call')).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('viemReader: balances and filters', () => {
  it('reads balances at a block and answers null when the token cannot', async () => {
    const requests: Request[] = [];
    const reader = viemReader(fakeRpc(requests));
    expect(await reader.getTokenBalance(BROKEN, ALICE, 99)).toBeNull();
    expect(requests.at(-1)).toMatchObject({ method: 'eth_call' });
    expect((requests.at(-1)?.params as unknown[])[1]).toBe(toHex(99));
  });

  it('skips logs of addresses nobody watches', async () => {
    const reader = viemReader(fakeRpc([]));
    const logs = await reader.getTokenLogs(
      blockHash(100),
      (address) => address.toLowerCase() === CAROL.toLowerCase(),
    );
    expect(logs).toEqual([]);
  });
});

describe('safeSymbol', () => {
  it.each([
    ['USDC', 'USDC'],
    [' stETH ', 'stETH'],
    ['$PEPE', '$PEPE'],
    ['Claim at xyz.com', ''],
    ['VERYLONGSYMBOLNAME', ''],
    ['A\u202eB', ''],
  ])('%j -> %j', (symbol, expected) => {
    expect(safeSymbol(symbol)).toBe(expected);
  });
});
