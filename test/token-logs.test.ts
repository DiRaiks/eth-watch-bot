import { encodeAbiParameters, pad, toHex, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import {
  decodeTokenLog,
  logParties,
  mayConcern,
  PERMIT2,
  TOKEN_TOPICS,
  type RawLog,
} from '../src/scanner/token-logs.js';
import { ALICE, BOB, CAROL, txHash, USDC } from './helpers.js';

const raw = (topics: Hex[], data: Hex = '0x'): RawLog => ({
  address: USDC.toLowerCase() as RawLog['address'],
  topics,
  data,
  transactionHash: txHash(1),
  logIndex: 4,
});
const uint = (value: bigint) =>
  encodeAbiParameters([{ type: 'uint256' }], [value]);
const base = { token: USDC, transactionHash: txHash(1), logIndex: 4 };

describe('decodeTokenLog', () => {
  it('decodes ERC-20 transfers and approvals', () => {
    expect(
      decodeTokenLog(
        raw([TOKEN_TOPICS.transfer, pad(ALICE), pad(BOB)], uint(5n)),
      ),
    ).toEqual({ ...base, type: 'erc20', from: ALICE, to: BOB, value: 5n });
    expect(
      decodeTokenLog(
        raw([TOKEN_TOPICS.approval, pad(ALICE), pad(BOB)], uint(7n)),
      ),
    ).toEqual({
      ...base,
      type: 'approval',
      owner: ALICE,
      spender: BOB,
      value: 7n,
    });
  });

  it('tells ERC-721 events apart by the indexed token id', () => {
    expect(
      decodeTokenLog(
        raw([TOKEN_TOPICS.transfer, pad(ALICE), pad(BOB), pad(toHex(9))]),
      ),
    ).toEqual({
      ...base,
      type: 'nft',
      from: ALICE,
      to: BOB,
      tokenIds: [9n],
      amounts: null,
    });
    expect(
      decodeTokenLog(
        raw([TOKEN_TOPICS.approval, pad(ALICE), pad(BOB), pad(toHex(9))]),
      ),
    ).toEqual({
      ...base,
      type: 'nft-approval',
      owner: ALICE,
      spender: BOB,
      tokenId: 9n,
    });
  });

  it('decodes operator approvals and ERC-1155 transfers', () => {
    expect(
      decodeTokenLog(
        raw(
          [TOKEN_TOPICS.approvalForAll, pad(ALICE), pad(BOB)],
          encodeAbiParameters([{ type: 'bool' }], [true]),
        ),
      ),
    ).toEqual({
      ...base,
      type: 'approval-for-all',
      owner: ALICE,
      operator: BOB,
      approved: true,
    });

    expect(
      decodeTokenLog(
        raw(
          [TOKEN_TOPICS.transferSingle, pad(CAROL), pad(ALICE), pad(BOB)],
          encodeAbiParameters(
            [{ type: 'uint256' }, { type: 'uint256' }],
            [3n, 10n],
          ),
        ),
      ),
    ).toEqual({
      ...base,
      type: 'nft',
      from: ALICE,
      to: BOB,
      tokenIds: [3n],
      amounts: [10n],
    });

    expect(
      decodeTokenLog(
        raw(
          [TOKEN_TOPICS.transferBatch, pad(CAROL), pad(ALICE), pad(BOB)],
          encodeAbiParameters(
            [{ type: 'uint256[]' }, { type: 'uint256[]' }],
            [
              [1n, 2n],
              [5n, 6n],
            ],
          ),
        ),
      ),
    ).toEqual({
      ...base,
      type: 'nft',
      from: ALICE,
      to: BOB,
      tokenIds: [1n, 2n],
      amounts: [5n, 6n],
    });
  });

  it('ignores other and malformed events', () => {
    expect(decodeTokenLog(raw([pad(toHex(1)), pad(ALICE)]))).toBeNull();
    expect(decodeTokenLog(raw([TOKEN_TOPICS.transfer, pad(ALICE)]))).toBeNull();
    expect(decodeTokenLog(raw([TOKEN_TOPICS.approval, pad(ALICE)]))).toBeNull();
    expect(
      decodeTokenLog(
        raw([TOKEN_TOPICS.transfer, pad(ALICE), pad(BOB)], '0x12'),
      ),
    ).toBeNull();
  });
});

describe('logParties', () => {
  it('names both sides of transfers and only the owner of approvals', () => {
    const transfer = decodeTokenLog(
      raw([TOKEN_TOPICS.transfer, pad(ALICE), pad(BOB)], uint(1n)),
    )!;
    const approval = decodeTokenLog(
      raw([TOKEN_TOPICS.approval, pad(ALICE), pad(BOB)], uint(1n)),
    )!;
    expect(logParties(transfer)).toEqual([ALICE, BOB]);
    expect(logParties(approval)).toEqual([ALICE]);
  });
});

describe('Permit2', () => {
  const data = encodeAbiParameters(
    [{ type: 'uint160' }, { type: 'uint48' }],
    [1000n, 1_800_000_000],
  );
  const topics = [
    TOKEN_TOPICS.permit2Approval,
    pad(ALICE),
    pad(USDC),
    pad(BOB),
  ];

  it('decodes allowances emitted by Permit2', () => {
    expect(decodeTokenLog({ ...raw(topics, data), address: PERMIT2 })).toEqual({
      ...base,
      token: PERMIT2,
      type: 'permit2',
      owner: ALICE,
      asset: USDC,
      spender: BOB,
      amount: 1000n,
      expiration: 1_800_000_000,
    });
  });

  it('ignores the same event from any other contract', () => {
    expect(decodeTokenLog(raw(topics, data))).toBeNull();
  });
});

describe('mayConcern', () => {
  it('looks at indexed addresses before decoding', () => {
    const isAlice = (address: string) =>
      address.toLowerCase() === ALICE.toLowerCase();
    expect(
      mayConcern(
        { topics: [TOKEN_TOPICS.transfer, pad(BOB), pad(ALICE)] },
        isAlice,
      ),
    ).toBe(true);
    expect(
      mayConcern(
        { topics: [TOKEN_TOPICS.transfer, pad(BOB), pad(CAROL)] },
        isAlice,
      ),
    ).toBe(false);
  });
});
