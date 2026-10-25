import type { Address, Hash, Hex } from 'viem';

import type { ChainName } from '../chains.js';
import type { TokenLog } from './token-logs.js';

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

export type TokenInfo = { symbol: string; decimals: number | null };

/** What a transaction cost and whether it went through */
export type TxReceipt = {
  success: boolean;
  /** Paid by the sender, in wei: gas, plus the L1 fee on rollups that report it */
  fee: bigint;
};

/** What the bot needs from a chain; the viem implementation lives in viem-reader.ts */
export interface ChainReader {
  getChainId(): Promise<number>;
  /** Host of the RPC in use, for /health; absent in tests */
  rpcHost?(): string | null;
  getBlockNumber(): Promise<number>;
  getBlock(number: number): Promise<ScannedBlock>;
  /** Token transfers and approvals of a block (ERC-20, ERC-721, ERC-1155) */
  getTokenLogs(
    blockHash: Hash,
    /** Skips logs that involve no watched address before decoding them */
    isWatched?: (address: Address) => boolean,
  ): Promise<TokenLog[]>;
  /**
   * Balance of `owner` in a token at a block: ERC-20 and ERC-721 `balanceOf(owner)`,
   * ERC-1155 `balanceOf(owner, tokenId)`. Null when the contract does not answer.
   */
  getTokenBalance(
    token: Address,
    owner: Address,
    blockNumber: number,
    tokenId?: bigint,
  ): Promise<bigint | null>;
  getTokenInfo(token: Address): Promise<TokenInfo>;
  /** Outcome and cost of a transaction; optional, alerts go without them */
  getReceipt?(hash: Hash): Promise<TxReceipt>;
  /** Native coin balance at a block */
  getBalance?(address: Address, blockNumber: number): Promise<bigint>;
  /** Whether the address holds code: a contract rather than a wallet */
  isContract?(address: Address): Promise<boolean>;
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
