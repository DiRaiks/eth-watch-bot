import type { FastifyBaseLogger } from 'fastify';

import type { ChainName } from '../chains.js';
import type { BlockHandler, ChainReader, CheckpointStore } from './types.js';

export type ScannerStatus = {
  chain: ChainName;
  /** Latest block seen on the chain */
  head: number | null;
  /** Last block every handler has processed */
  lastBlock: number | null;
  /** Blocks between the head and the last processed block */
  lag: number | null;
  error: string | null;
  stopped: boolean;
};

export type BlockScannerOptions = {
  chain: ChainName;
  chainId: number;
  reader: ChainReader;
  checkpoints: CheckpointStore;
  handlers: BlockHandler[];
  confirmations: number;
  maxBlocksPerTick: number;
  /** After a long outage older blocks are skipped, so the bot reports the present */
  maxLagBlocks: number;
  log: FastifyBaseLogger;
};

/**
 * A short reason safe to show publicly: viem's full messages include the RPC URL,
 * which often carries an API key
 */
const describeError = (error: unknown) => {
  if (error && typeof error === 'object' && 'shortMessage' in error) {
    return String(error.shortMessage);
  }
  return error instanceof Error ? error.name : 'Unknown error';
};

/**
 * Polls one chain and feeds confirmed blocks to the handlers in order. The checkpoint
 * moves only after every handler finished a block, so a crash or an RPC error repeats
 * that block instead of skipping it. A new chain starts at its current head.
 */
export class BlockScanner {
  readonly chain: ChainName;
  private readonly options: BlockScannerOptions;
  private head: number | null = null;
  private lastBlock: number | null = null;
  private error: string | null = null;
  private chainChecked = false;
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<unknown> | undefined;

  constructor(options: BlockScannerOptions) {
    this.options = options;
    this.chain = options.chain;
  }

  status(): ScannerStatus {
    return {
      chain: this.chain,
      head: this.head,
      lastBlock: this.lastBlock,
      lag:
        this.head !== null && this.lastBlock !== null
          ? Math.max(0, this.head - this.lastBlock)
          : null,
      error: this.error,
      stopped: this.stopped,
    };
  }

  /** Processes the next batch of confirmed blocks; resolves with how many were processed */
  async tick(): Promise<number> {
    const { chain, reader, checkpoints, handlers, log } = this.options;

    if (!this.chainChecked) {
      const chainId = await reader.getChainId();
      if (chainId !== this.options.chainId) {
        this.stop();
        this.error = `RPC returns chain id ${chainId}, expected ${this.options.chainId}`;
        log.error({ chain }, this.error);
        return 0;
      }
      this.chainChecked = true;
    }

    this.head = await reader.getBlockNumber();
    const safe = this.head - this.options.confirmations;

    let last = this.lastBlock ?? (await checkpoints.get(chain));
    if (last === null) {
      await checkpoints.set(chain, safe);
      this.lastBlock = safe;
      log.info({ chain, block: safe }, 'scanner starts at the current block');
      return 0;
    }
    if (safe - last > this.options.maxLagBlocks) {
      const resume = safe - this.options.maxLagBlocks;
      log.warn(
        { chain, from: last + 1, to: resume },
        'scanner is too far behind, skipping old blocks',
      );
      last = resume;
      await checkpoints.set(chain, last);
    }
    this.lastBlock = last;
    if (safe <= last) return 0;

    const active = handlers.filter((handler) => handler.wants(chain));
    if (!active.length) {
      // Nothing to look for: skip ahead without fetching blocks
      await checkpoints.set(chain, safe);
      this.lastBlock = safe;
      return 0;
    }

    const to = Math.min(safe, last + this.options.maxBlocksPerTick);
    let processed = 0;
    while (last < to && !this.stopped) {
      const block = await reader.getBlock(last + 1);
      for (const handler of active) {
        await handler.handleBlock(chain, block, reader);
      }
      last = block.number;
      await checkpoints.set(chain, last);
      this.lastBlock = last;
      processed += 1;
    }
    return processed;
  }

  start(intervalMs: number) {
    this.stopped = false;
    const loop = async () => {
      let processed = 0;
      try {
        processed = await this.tick();
        // A stopped scanner keeps the reason it stopped
        if (!this.stopped) this.error = null;
      } catch (error) {
        this.error = describeError(error);
        this.options.log.warn(
          { err: error, chain: this.chain },
          'scanner tick failed',
        );
      }
      if (this.stopped) return;
      // A full batch means more blocks are waiting: continue right away
      const delay = processed >= this.options.maxBlocksPerTick ? 0 : intervalMs;
      this.timer = setTimeout(() => {
        this.running = loop();
      }, delay);
    };
    this.running = loop();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  /** Stops the loop and waits for the block in progress */
  async close() {
    this.stop();
    await this.running;
  }
}
