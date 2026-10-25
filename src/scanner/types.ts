import type { Address, Hash, Hex } from 'viem';

import type { ChainName } from '../chains.js';

export type ScannedTransaction = {
  hash: Hash;
  from: Address;
  /** null for contract creation */
  to: Address | null;
  value: bigint;
  input: Hex;
};

export type ScannedBlock = {
  number: number;
  hash: Hash;
  /** Unix seconds */
  timestamp: number;
  transactions: ScannedTransaction[];
};

/** An ERC-20 `Transfer(address indexed from, address indexed to, uint256 value)` log */
export type TransferLog = {
  token: Address;
  from: Address;
  to: Address;
  value: bigint;
  transactionHash: Hash;
  logIndex: number;
};

export type TokenInfo = { symbol: string; decimals: number | null };

/** What the bot needs from a chain; the viem implementation lives in viem-reader.ts */
export interface ChainReader {
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<number>;
  getBlock(number: number): Promise<ScannedBlock>;
  getTransferLogs(blockHash: Hash): Promise<TransferLog[]>;
  getTokenInfo(token: Address): Promise<TokenInfo>;
}

export interface BlockHandler {
  name: string;
  /** Whether the handler has anything to do on this chain right now */
  wants(chain: ChainName): boolean;
  handleBlock(
    chain: ChainName,
    block: ScannedBlock,
    reader: ChainReader,
  ): Promise<void>;
}

/** Last fully processed block per chain, so restarts resume where they stopped */
export interface CheckpointStore {
  get(chain: ChainName): Promise<number | null>;
  set(chain: ChainName, block: number): Promise<void>;
}
