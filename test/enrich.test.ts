import { describe, expect, it, vi } from 'vitest';

import { priceLookup, usdValue } from '../src/enrich/prices.js';
import { signatureLookup } from '../src/enrich/signatures.js';
import { USDC } from './helpers.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('signatureLookup', () => {
  it('knows common methods without a network call', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const lookup = signatureLookup({ fetchImpl });
    expect(await lookup('0x095ea7b3')).toEqual({
      name: 'approve',
      trusted: true,
      signature: 'approve(address spender,uint256 amount)',
    });
    expect(await lookup('0xa22cb465')).toMatchObject({
      name: 'setApprovalForAll',
      trusted: true,
    });
    expect(await lookup('0x6a761202')).toMatchObject({
      name: 'execTransaction',
      trusted: true,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('takes names from verified contracts only and caches them', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      json({
        ok: true,
        result: {
          function: {
            '0x12345678': [
              {
                name: 'claimRewards()',
                filtered: false,
                hasVerifiedContract: false,
              },
              {
                name: 'deposit(uint256)',
                filtered: false,
                hasVerifiedContract: true,
              },
            ],
          },
        },
      }),
    );
    const lookup = signatureLookup({ fetchImpl });
    expect(await lookup('0x12345678')).toEqual({
      name: 'deposit',
      trusted: false,
      signature: 'deposit(uint256)',
    });
    await lookup('0x12345678');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(
      'function=0x12345678&filter=true',
    );
  });

  it('answers null for unknown selectors and pauses after network errors', async () => {
    let fail = true;
    let now = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      if (fail) throw new Error('offline');
      return json({ ok: true, result: { function: { '0xdeadbeef': null } } });
    });
    const lookup = signatureLookup({
      fetchImpl,
      now: () => now,
      retryAfterMs: 1000,
    });
    expect(await lookup('0xdeadbeef')).toBeNull();
    // Within the pause no request is made
    fail = false;
    expect(await lookup('0xdeadbeef')).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now = 2000;
    expect(await lookup('0xdeadbeef')).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const failing = signatureLookup({ fetchImpl: async () => json({}, 500) });
    expect(await failing('0xdeadbeef')).toBeNull();
  });

  it('refuses names that are not plain identifiers', async () => {
    const answer = (name: string) =>
      signatureLookup({
        fetchImpl: async () =>
          json({
            ok: true,
            result: {
              function: {
                '0x12345678': [
                  { name, filtered: false, hasVerifiedContract: true },
                ],
              },
            },
          }),
      })('0x12345678');
    expect(await answer('claim\u202eevil()')).toBeNull();
    expect(await answer(`${'a'.repeat(80)}()`)).toBeNull();
    expect(await answer('safe_Name$1(uint256)')).toEqual({
      name: 'safe_Name$1',
      trusted: false,
      signature: 'safe_Name$1(uint256)',
    });
    // A usable name with odd parameter types: shown, but not decoded with
    expect(await answer('claim(uint256 <b>)')).toEqual({
      name: 'claim',
      trusted: false,
      signature: null,
    });
  });

  it('stays offline when remote lookups are off', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(
      await signatureLookup({ remote: false, fetchImpl })('0xdeadbeef'),
    ).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('priceLookup', () => {
  const coins = {
    'coingecko:ethereum': { price: 2000, confidence: 0.99 },
    [`ethereum:${USDC}`]: { price: 1, confidence: 0.99 },
    'ethereum:0x1111111111111111111111111111111111111111': {
      price: 5,
      confidence: 0.2,
    },
  };

  it('prices the native coin and tokens, skipping guesses', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json({ coins }));
    const lookup = priceLookup({ fetchImpl });
    const spam = '0x1111111111111111111111111111111111111111';
    const prices = await lookup('ethereum', [null, USDC, spam]);
    expect(prices).toEqual(
      new Map<string | null, number>([
        [null, 2000],
        [USDC, 1],
      ]),
    );
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      `https://coins.llama.fi/prices/current/coingecko:ethereum,ethereum:${USDC},ethereum:${spam}`,
    );
  });

  it('caches prices for a while', async () => {
    let now = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () => json({ coins }));
    const lookup = priceLookup({ fetchImpl, now: () => now, ttlMs: 1000 });
    await lookup('ethereum', [null]);
    await lookup('ethereum', [null]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now = 2000;
    await lookup('ethereum', [null]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('answers null when the service fails, and pauses before asking again', async () => {
    let now = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () => json({}, 503));
    const lookup = priceLookup({
      fetchImpl,
      now: () => now,
      retryAfterMs: 1000,
    });
    expect(await lookup('base', [USDC])).toBeNull();
    expect(await lookup('base', [USDC])).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now = 2000;
    await lookup('base', [USDC]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('asks for many tokens in batches', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json({ coins: {} }));
    const tokens = Array.from(
      { length: 45 },
      (_, i) => `0x${String(i).padStart(40, '0')}` as `0x${string}`,
    );
    await priceLookup({ fetchImpl })('ethereum', tokens);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('converts amounts to dollars', () => {
    expect(usdValue(1_500_000n, 6, 2)).toBe(3);
  });
});
