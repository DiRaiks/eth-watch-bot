import { maxUint256, type Address } from 'viem';
import { describe, expect, it } from 'vitest';

import type { TokenLog } from '../src/scanner/token-logs.js';
import type { ScannedBlock } from '../src/scanner/types.js';
import { collectActivity, mostImportant } from '../src/watch/activity.js';
import {
  ALICE,
  BOB,
  blockHash,
  CAROL,
  erc20,
  tx,
  txHash,
  USDC,
  type NewLog,
} from './helpers.js';

const block = (transactions: ScannedBlock['transactions']): ScannedBlock => ({
  number: 1,
  hash: blockHash(1),
  timestamp: 0,
  transactions,
});
const watched =
  (...addresses: Address[]) =>
  (address: Address) =>
    addresses.some((a) => a.toLowerCase() === address.toLowerCase());
const logs = (...items: NewLog[]) =>
  items.map((item, logIndex) => ({ ...item, logIndex }) as TokenLog);

describe('collectActivity', () => {
  it('reports what the watched address sent and received', () => {
    const activity = collectActivity(
      block([
        tx(1, { from: ALICE, to: BOB, value: 5n }),
        tx(2, { from: BOB, to: ALICE, value: 7n }),
        tx(3, { from: ALICE, to: USDC, input: '0xa9059cbb00' }),
        tx(4, { from: ALICE, to: null }),
        tx(5, { from: BOB, to: ALICE }),
      ]),
      [],
      watched(ALICE),
    );
    expect(activity.map((a) => [a.kind, a.importance])).toEqual([
      ['send-native', 'outgoing'],
      ['receive-native', 'incoming'],
      ['call', 'outgoing'],
      ['create', 'outgoing'],
      ['called', 'incoming'],
    ]);
    expect(activity[2]).toMatchObject({
      contract: USDC,
      selector: '0xa9059cbb',
    });
    expect(activity[4]).toMatchObject({ caller: BOB, selector: null });
  });

  it('reports a self-transfer once', () => {
    const activity = collectActivity(
      block([tx(1, { from: ALICE, to: ALICE, value: 1n })]),
      [],
      watched(ALICE),
    );
    expect(activity.map((a) => a.kind)).toEqual(['send-native']);
  });

  it('flags tokens taken by someone else as an alert', () => {
    const [own] = collectActivity(
      block([tx(1, { from: ALICE, to: USDC })]),
      logs(erc20(1, { from: ALICE, to: BOB, value: 10n })),
      watched(ALICE),
    ).filter((a) => a.kind === 'send-token');
    expect(own).toMatchObject({
      importance: 'outgoing',
      sentBy: null,
      spam: null,
    });

    const [taken] = collectActivity(
      block([tx(1, { from: CAROL, to: USDC })]),
      logs(erc20(1, { from: ALICE, to: BOB, value: 10n })),
      watched(ALICE),
    );
    expect(taken).toMatchObject({
      kind: 'send-token',
      importance: 'alert',
      sentBy: CAROL,
    });
  });

  it('marks zero transfers in your name as fake (address poisoning)', () => {
    const activity = collectActivity(
      block([tx(1, { from: CAROL, to: USDC })]),
      logs(erc20(1, { from: ALICE, to: BOB, value: 0n })),
      watched(ALICE, BOB),
    );
    expect(activity.map((a) => [a.kind, a.importance, a.spam])).toEqual([
      ['send-token', 'outgoing', 'fake-transfer'],
      ['receive-token', 'incoming', 'fake-transfer'],
    ]);
  });

  it('turns approvals into alerts and revocations into plain activity', () => {
    const activity = collectActivity(
      block([]),
      logs(
        {
          type: 'approval',
          token: USDC,
          owner: ALICE,
          spender: BOB,
          value: maxUint256,
          transactionHash: txHash(1),
        },
        {
          type: 'approval',
          token: USDC,
          owner: ALICE,
          spender: BOB,
          value: 0n,
          transactionHash: txHash(2),
        },
        {
          type: 'approval',
          token: USDC,
          owner: BOB,
          spender: ALICE,
          value: 5n,
          transactionHash: txHash(3),
        },
        {
          type: 'approval-for-all',
          token: CAROL,
          owner: ALICE,
          operator: BOB,
          approved: true,
          transactionHash: txHash(4),
        },
        {
          type: 'approval-for-all',
          token: CAROL,
          owner: ALICE,
          operator: BOB,
          approved: false,
          transactionHash: txHash(5),
        },
        {
          type: 'nft-approval',
          token: CAROL,
          owner: ALICE,
          spender: BOB,
          tokenId: 1n,
          transactionHash: txHash(6),
        },
        {
          type: 'nft-approval',
          token: CAROL,
          owner: ALICE,
          spender: '0x0000000000000000000000000000000000000000',
          tokenId: 1n,
          transactionHash: txHash(7),
        },
      ),
      watched(ALICE),
    );
    expect(activity.map((a) => [a.kind, a.importance])).toEqual([
      ['approval', 'alert'],
      ['approval', 'outgoing'],
      ['approval-for-all', 'alert'],
      ['approval-for-all', 'outgoing'],
      ['nft-approval', 'alert'],
    ]);
    expect(activity[0]).toMatchObject({ unlimited: true });
  });

  it('reports NFTs sent and received', () => {
    const activity = collectActivity(
      block([tx(1, { from: ALICE, to: CAROL })]),
      logs({
        type: 'nft',
        token: CAROL,
        from: ALICE,
        to: BOB,
        tokenIds: [1n],
        amounts: null,
        transactionHash: txHash(1),
      }),
      watched(ALICE, BOB),
    ).filter((a) => a.kind !== 'call');
    expect(activity.map((a) => [a.kind, a.address])).toEqual([
      ['send-nft', ALICE],
      ['receive-nft', BOB],
    ]);
  });

  it('skips logs that do not involve watched addresses', () => {
    expect(
      collectActivity(
        block([]),
        logs(erc20(1, { from: BOB, to: CAROL, value: 1n })),
        watched(ALICE),
      ),
    ).toEqual([]);
  });
});

describe('mostImportant', () => {
  it('picks alerts over outgoing over incoming', () => {
    expect(mostImportant([])).toBe('incoming');
    expect(
      mostImportant([{ importance: 'incoming' }, { importance: 'outgoing' }]),
    ).toBe('outgoing');
    expect(
      mostImportant([{ importance: 'alert' }, { importance: 'outgoing' }]),
    ).toBe('alert');
  });
});
