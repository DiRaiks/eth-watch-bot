import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { BlockScanner } from '../src/scanner/scanner.js';
import type { BlockHandler } from '../src/scanner/types.js';
import { memoryCheckpoints } from '../src/storage.js';
import { fakeChain } from './helpers.js';

const log = Fastify({ logger: false }).log;

const recorder = (wants = true) => {
  const blocks: number[] = [];
  const handler: BlockHandler = {
    name: 'recorder',
    wants: () => wants,
    handleBlock: async (_chain, block) => {
      blocks.push(block.number);
    },
  };
  return { handler, blocks };
};

const setup = ({
  handlers = [recorder().handler],
  confirmations = 2,
  maxBlocksPerTick = 50,
  maxLagBlocks = 1000,
  chainId = 1,
} = {}) => {
  const chain = fakeChain(chainId);
  const checkpoints = memoryCheckpoints();
  const create = () =>
    new BlockScanner({
      chain: 'ethereum',
      chainId: 1,
      reader: chain.reader,
      checkpoints,
      handlers,
      confirmations,
      maxBlocksPerTick,
      maxLagBlocks,
      log,
    });
  return { chain, checkpoints, create, scanner: create() };
};

describe('BlockScanner', () => {
  it('starts at the confirmed head on the first run', async () => {
    const { handler, blocks } = recorder();
    const { chain, checkpoints, scanner } = setup({ handlers: [handler] });
    chain.setHead(100);
    expect(await scanner.tick()).toBe(0);
    expect(await checkpoints.get('ethereum')).toBe(98);
    expect(blocks).toEqual([]);
  });

  it('processes confirmed blocks in order and saves progress', async () => {
    const { handler, blocks } = recorder();
    const { chain, checkpoints, scanner } = setup({ handlers: [handler] });
    chain.setHead(100);
    await scanner.tick();
    chain.setHead(103);
    expect(await scanner.tick()).toBe(3);
    expect(blocks).toEqual([99, 100, 101]);
    expect(await checkpoints.get('ethereum')).toBe(101);
    expect(scanner.status()).toMatchObject({
      head: 103,
      lastBlock: 101,
      lag: 2,
      error: null,
    });
  });

  it('catches up on blocks missed while it was down', async () => {
    const { handler, blocks } = recorder();
    const { chain, create, checkpoints } = setup({ handlers: [handler] });
    await checkpoints.set('ethereum', 50);
    chain.setHead(57);
    expect(await create().tick()).toBe(5);
    expect(blocks).toEqual([51, 52, 53, 54, 55]);
  });

  it('processes at most maxBlocksPerTick blocks per tick', async () => {
    const { handler, blocks } = recorder();
    const { chain, checkpoints, scanner } = setup({
      handlers: [handler],
      maxBlocksPerTick: 2,
    });
    await checkpoints.set('ethereum', 10);
    chain.setHead(30);
    await scanner.tick();
    expect(blocks).toEqual([11, 12]);
  });

  it('repeats a block whose handler failed instead of skipping it', async () => {
    const seen: number[] = [];
    let fail = true;
    const flaky: BlockHandler = {
      name: 'flaky',
      wants: () => true,
      handleBlock: async (_chain, block) => {
        if (block.number === 12 && fail) {
          fail = false;
          throw new Error('rpc timeout');
        }
        seen.push(block.number);
      },
    };
    const { chain, checkpoints, scanner } = setup({ handlers: [flaky] });
    await checkpoints.set('ethereum', 10);
    chain.setHead(15);
    await expect(scanner.tick()).rejects.toThrow('rpc timeout');
    expect(await checkpoints.get('ethereum')).toBe(11);
    await scanner.tick();
    expect(seen).toEqual([11, 12, 13]);
  });

  it('skips ahead without fetching blocks when no handler needs them', async () => {
    const { chain, checkpoints, scanner } = setup({
      handlers: [recorder(false).handler],
    });
    await checkpoints.set('ethereum', 10);
    chain.setHead(1000);
    await scanner.tick();
    expect(chain.fetched).toEqual([]);
    expect(await checkpoints.get('ethereum')).toBe(998);
  });

  it('stops when the RPC serves another chain', async () => {
    const { chain, scanner } = setup({ chainId: 8453 });
    chain.setHead(100);
    expect(await scanner.tick()).toBe(0);
    expect(scanner.status()).toMatchObject({
      stopped: true,
      error: 'RPC returns chain id 8453, expected 1',
    });
  });

  it('runs in a loop, records errors and stops on close', async () => {
    vi.useFakeTimers();
    try {
      const { handler, blocks } = recorder();
      const { chain, checkpoints, scanner } = setup({ handlers: [handler] });
      await checkpoints.set('ethereum', 10);
      chain.setHead(14);
      const getBlockNumber = chain.reader.getBlockNumber;
      chain.reader.getBlockNumber = async () => {
        throw new Error('rpc down');
      };

      scanner.start(1000);
      await vi.advanceTimersByTimeAsync(0);
      expect(scanner.status().error).toBe('Error');

      chain.reader.getBlockNumber = getBlockNumber;
      await vi.advanceTimersByTimeAsync(1000);
      expect(blocks).toEqual([11, 12]);
      expect(scanner.status().error).toBeNull();

      await scanner.close();
      chain.setHead(20);
      await vi.advanceTimersByTimeAsync(5000);
      expect(blocks).toEqual([11, 12]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('continues right away while a full batch is waiting', async () => {
    vi.useFakeTimers();
    try {
      const { handler, blocks } = recorder();
      const { chain, checkpoints, scanner } = setup({
        handlers: [handler],
        maxBlocksPerTick: 2,
      });
      await checkpoints.set('ethereum', 0);
      chain.setHead(8);
      scanner.start(60_000);
      await vi.advanceTimersByTimeAsync(10);
      expect(blocks).toEqual([1, 2, 3, 4, 5, 6]);
      await scanner.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips old blocks after a long outage', async () => {
    const { handler, blocks } = recorder();
    const { chain, checkpoints, scanner } = setup({
      handlers: [handler],
      maxLagBlocks: 3,
    });
    await checkpoints.set('ethereum', 10);
    chain.setHead(102);
    await scanner.tick();
    expect(blocks).toEqual([98, 99, 100]);
  });

  it('keeps the reason it stopped', async () => {
    vi.useFakeTimers();
    try {
      const { chain, scanner } = setup({ chainId: 10 });
      chain.setHead(100);
      scanner.start(1000);
      await vi.advanceTimersByTimeAsync(0);
      expect(scanner.status()).toMatchObject({
        stopped: true,
        error: 'RPC returns chain id 10, expected 1',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not expose full RPC errors, which may contain the URL with a key', async () => {
    vi.useFakeTimers();
    try {
      const { chain, scanner } = setup();
      chain.reader.getBlockNumber = async () => {
        throw Object.assign(
          new Error(
            'HTTP request failed.\nURL: https://rpc.example/v3/secret-key',
          ),
          { shortMessage: 'HTTP request failed.' },
        );
      };
      scanner.start(1000);
      await vi.advanceTimersByTimeAsync(0);
      expect(scanner.status().error).toBe('HTTP request failed.');

      chain.reader.getBlockNumber = async () => {
        throw new TypeError('fetch failed https://rpc.example/v3/secret-key');
      };
      await vi.advanceTimersByTimeAsync(1000);
      expect(scanner.status().error).toBe('TypeError');
      await scanner.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
