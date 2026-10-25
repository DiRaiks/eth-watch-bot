import { maxUint256, type Address, type Hash, type Hex } from 'viem';

import { logParties, type TokenLog } from '../scanner/token-logs.js';
import type { ScannedBlock } from '../scanner/types.js';

/**
 * How urgent an activity is for the owner of the address:
 * - `alert`: someone can now take, or just took, the owner's tokens
 * - `outgoing`: the address sent or called something
 * - `incoming`: the address received something
 */
export type Importance = 'alert' | 'outgoing' | 'incoming';

/**
 * Why an activity may be spam:
 * - `fake-transfer`: a zero transfer in the owner's name (address poisoning)
 * - `fake-token`: an alarming event from a token the owner does not hold, which any
 *   contract can emit to cause panic
 * - `unpriced`: a received token nobody prices, typical of scam airdrops; a hint only
 */
export type Spam = 'fake-transfer' | 'fake-token' | 'unpriced' | null;

type Base = {
  /** The watched address the activity is about */
  address: Address;
  hash: Hash;
  /** Order within the block, so a transaction's lines keep their sequence */
  order: number;
  importance: Importance;
  spam: Spam;
};

export type Activity = Base &
  (
    | { kind: 'send-native'; to: Address; value: bigint }
    | { kind: 'receive-native'; from: Address; value: bigint }
    | { kind: 'call'; contract: Address; selector: Hex; input: Hex }
    | { kind: 'called'; caller: Address; selector: Hex | null; input: Hex }
    | { kind: 'create' }
    | {
        kind: 'send-token' | 'receive-token';
        token: Address;
        from: Address;
        to: Address;
        value: bigint;
        /** The account that sent the transaction, when it is not the watched address */
        sentBy: Address | null;
      }
    | {
        kind: 'send-nft' | 'receive-nft';
        token: Address;
        from: Address;
        to: Address;
        tokenIds: bigint[];
        amounts: bigint[] | null;
        sentBy: Address | null;
      }
    | {
        kind: 'approval';
        token: Address;
        spender: Address;
        value: bigint;
        unlimited: boolean;
        /** Granted through Permit2, often by signing a message rather than a transaction */
        permit2?: { expiration: number };
      }
    | {
        kind: 'nft-approval';
        token: Address;
        spender: Address;
        tokenId: bigint;
      }
    | {
        kind: 'approval-for-all';
        token: Address;
        operator: Address;
        approved: boolean;
      }
  );

/** Wallets and dapps use the maximum value, or a huge one, for "unlimited" */
const UNLIMITED = maxUint256 / 2n;
const UNLIMITED_160 = 2n ** 159n;
const ZERO_ADDRESS = /^0x0{40}$/i;

const same = (a: string | null, b: string | null) =>
  a !== null && b !== null && a.toLowerCase() === b.toLowerCase();

/**
 * Everything the block did to watched addresses: transactions they sent or received,
 * and token transfers and approvals that involve them. `isWatched` takes any letter case.
 */
export const collectActivity = (
  block: ScannedBlock,
  logs: TokenLog[],
  isWatched: (address: Address) => boolean,
): Activity[] => {
  const activity: Activity[] = [];
  const senders = new Map<Hash, Address>();
  let order = 0;

  for (const tx of block.transactions) {
    senders.set(tx.hash, tx.from);
    const base = { hash: tx.hash, spam: null } as const;
    const selector =
      tx.input.length >= 10 ? (tx.input.slice(0, 10) as Hex) : null;

    if (isWatched(tx.from)) {
      const own = {
        ...base,
        address: tx.from,
        importance: 'outgoing',
      } as const;
      if (!tx.to) {
        activity.push({ ...own, order: order++, kind: 'create' });
      } else if (tx.value > 0n) {
        activity.push({
          ...own,
          order: order++,
          kind: 'send-native',
          to: tx.to,
          value: tx.value,
        });
      } else {
        activity.push({
          ...own,
          order: order++,
          kind: 'call',
          contract: tx.to,
          selector: selector ?? '0x',
          input: tx.input,
        });
      }
    }
    if (tx.to && isWatched(tx.to) && !same(tx.to, tx.from)) {
      const theirs = {
        ...base,
        address: tx.to,
        importance: 'incoming',
      } as const;
      activity.push(
        tx.value > 0n
          ? {
              ...theirs,
              order: order++,
              kind: 'receive-native',
              from: tx.from,
              value: tx.value,
            }
          : {
              ...theirs,
              order: order++,
              kind: 'called',
              caller: tx.from,
              selector,
              input: tx.input,
            },
      );
    }
  }

  // ERC-20 contracts emit Approval with the remaining allowance whenever an allowance is
  // spent; the transfer next to it already tells the story
  const spends = new Set(
    logs.flatMap((log) =>
      log.type === 'erc20'
        ? [`${log.transactionHash}:${log.token}:${log.from.toLowerCase()}`]
        : [],
    ),
  );

  for (const log of logs) {
    if (!logParties(log).some(isWatched)) continue;
    const sender = senders.get(log.transactionHash) ?? null;
    const base = { hash: log.transactionHash, order: order++ };

    switch (log.type) {
      case 'erc20':
      case 'nft': {
        const sentBy = (owner: Address) =>
          sender && !same(sender, owner) ? sender : null;
        const zero = log.type === 'erc20' && log.value === 0n;
        const details =
          log.type === 'erc20'
            ? { token: log.token, from: log.from, to: log.to, value: log.value }
            : {
                token: log.token,
                from: log.from,
                to: log.to,
                tokenIds: log.tokenIds,
                amounts: log.amounts,
              };

        if (isWatched(log.from)) {
          const by = sentBy(log.from);
          activity.push({
            ...base,
            ...details,
            address: log.from,
            kind: log.type === 'erc20' ? 'send-token' : 'send-nft',
            sentBy: by,
            // Taken by someone else: a drain through an approval, or a fake transfer
            importance: by && !zero ? 'alert' : 'outgoing',
            spam: by && zero ? 'fake-transfer' : null,
          } as Activity);
        }
        if (isWatched(log.to) && !same(log.to, log.from)) {
          activity.push({
            ...base,
            ...details,
            address: log.to,
            kind: log.type === 'erc20' ? 'receive-token' : 'receive-nft',
            sentBy: sentBy(log.from),
            importance: 'incoming',
            spam: zero ? 'fake-transfer' : null,
          } as Activity);
        }
        break;
      }

      case 'approval':
        if (
          !isWatched(log.owner) ||
          (log.value > 0n &&
            spends.has(
              `${log.transactionHash}:${log.token}:${log.owner.toLowerCase()}`,
            ))
        ) {
          break;
        }
        activity.push({
          ...base,
          address: log.owner,
          kind: 'approval',
          token: log.token,
          spender: log.spender,
          value: log.value,
          unlimited: log.value >= UNLIMITED,
          // Setting the allowance to zero revokes it
          importance: log.value > 0n ? 'alert' : 'outgoing',
          spam: null,
        });
        break;

      case 'nft-approval':
        // Every NFT transfer clears its approval to the zero address: nothing to report
        if (!isWatched(log.owner) || ZERO_ADDRESS.test(log.spender)) break;
        activity.push({
          ...base,
          address: log.owner,
          kind: 'nft-approval',
          token: log.token,
          spender: log.spender,
          tokenId: log.tokenId,
          importance: 'alert',
          spam: null,
        });
        break;

      case 'permit2':
        if (!isWatched(log.owner)) break;
        activity.push({
          ...base,
          address: log.owner,
          kind: 'approval',
          token: log.asset,
          spender: log.spender,
          value: log.amount,
          unlimited: log.amount >= UNLIMITED_160,
          permit2: { expiration: log.expiration },
          importance: log.amount > 0n ? 'alert' : 'outgoing',
          spam: null,
        });
        break;

      case 'approval-for-all':
        if (!isWatched(log.owner)) break;
        activity.push({
          ...base,
          address: log.owner,
          kind: 'approval-for-all',
          token: log.token,
          operator: log.operator,
          approved: log.approved,
          importance: log.approved ? 'alert' : 'outgoing',
          spam: null,
        });
        break;
    }
  }

  return activity;
};

const RANK: Record<Importance, number> = { incoming: 0, outgoing: 1, alert: 2 };

export const mostImportant = (
  items: { importance: Importance }[],
): Importance =>
  items.reduce<Importance>(
    (top, item) => (RANK[item.importance] > RANK[top] ? item.importance : top),
    'incoming',
  );
