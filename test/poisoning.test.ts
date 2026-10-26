import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createPublicClient,
  http,
  type Address,
  type PublicClient,
} from 'viem';
import { mainnet } from 'viem/chains';
import { afterEach, describe, expect, it } from 'vitest';

import { imitatedTicker, looksLike } from '../src/enrich/lookalike.js';
import { viemReader } from '../src/scanner/viem-reader.js';
import {
  ALICE,
  BOB,
  buildTestApp,
  CAROL,
  message,
  tx,
  txHash,
} from './helpers.js';

describe('look-alikes', () => {
  it('sees through symbols dressed up as popular tickers', () => {
    // Real fake USDC symbols, with word joiners and Lisu, Cyrillic, accented letters
    expect(imitatedTicker('U⁠S⁠Dꓚ')).toBe('USDC');
    expect(imitatedTicker('ÚЅDС')).toBe('USDC');
    expect(imitatedTicker('UЅDТ')).toBe('USDT');
    expect(imitatedTicker('USDC')).toBeNull();
    expect(imitatedTicker('usdc')).toBeNull();
    expect(imitatedTicker('PEPE')).toBeNull();
  });

  it('matches addresses that look the same in a wallet', () => {
    expect(
      looksLike(
        '0x816493befa326c78738cc427d843bdfe21cac50b',
        '0x81641ADF223607B9676BDD588B5C01327BCDC50B',
      ),
    ).toBe(true);
    expect(looksLike(BOB, BOB.toLowerCase())).toBe(false);
    expect(looksLike(BOB, ALICE)).toBe(false);
  });
});

describe('balanceOf of fake tokens', () => {
  const server = (answer: (id: number) => unknown) => {
    const s = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        const { id } = JSON.parse(body) as { id: number };
        response
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end(
            JSON.stringify({ jsonrpc: '2.0', id, ...(answer(id) as object) }),
          );
      });
    });
    return new Promise<{ url: string; close: () => void }>((resolve) =>
      s.listen(0, '127.0.0.1', () =>
        resolve({
          url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`,
          close: () => s.close(),
        }),
      ),
    );
  };
  const reader = (url: string) =>
    viemReader(
      createPublicClient({
        chain: mainnet,
        transport: http(url, { retryCount: 0 }),
      }) as PublicClient,
    );
  const token = '0xabb119ac535c740b18d809ebba3fd4bd233160c5' as Address;

  it('counts a reverting or empty balanceOf as holding nothing', async () => {
    const reverts = await server(() => ({
      error: { code: 3, message: 'execution reverted', data: '0x' },
    }));
    const empty = await server(() => ({ result: '0x' }));
    try {
      expect(await reader(reverts.url).getTokenBalance(token, ALICE, 1)).toBe(
        0n,
      );
      expect(await reader(empty.url).getTokenBalance(token, ALICE, 1)).toBe(0n);
    } finally {
      reverts.close();
      empty.close();
    }
  });

  it('keeps an unreachable RPC unknown', async () => {
    expect(
      await reader('http://127.0.0.1:9').getTokenBalance(token, ALICE, 1),
    ).toBeNull();
  });
});

type TestApp = Awaited<ReturnType<typeof buildTestApp>>;
let current: TestApp | undefined;
afterEach(async () => {
  await current?.app.close();
  current = undefined;
});

describe('a poisoning attempt, as seen on mainnet', () => {
  const fakeUsdc = '0xAbb119Ac535C740B18d809ebBa3FD4bd233160C5' as Address;
  // Same first and last four hex characters as BOB, another address
  const lookalike = '0x0000aaaa219ab540356cbb839cbe05303d7705fa' as Address;

  it('shows a forged transfer of a fake USDC quietly, naming the look-alike', async () => {
    current = await buildTestApp();
    const t = current;
    t.chain.setHead(100);
    await t.scanner.tick();
    await t.app.tg.bot.handleUpdate(message(`/watch ${ALICE} Receiver`));
    await t.app.tg.bot.handleUpdate(message(`/watch ${BOB} Main`));
    t.chain.setToken(fakeUsdc, { symbol: '', decimals: 6, imitates: 'USDC' });
    // Its balanceOf gives no answer at all: unknown, yet the symbol gives it away
    t.chain.setBalance(fakeUsdc, ALICE, null);
    t.api.clear();

    t.chain.addBlock(
      101,
      [tx(1, { from: CAROL, to: fakeUsdc })],
      [
        {
          type: 'erc20',
          token: fakeUsdc,
          from: ALICE,
          to: lookalike,
          value: 4_000_000_000n,
          transactionHash: txHash(1),
        },
      ],
    );
    t.chain.setHead(101);
    await t.scanner.tick();

    const text = t.api.texts().at(-1) ?? '';
    expect(text.startsWith('🔔')).toBe(true);
    expect(text).not.toContain('🚨');
    expect(text).toContain('подделка под USDC');
    expect(text).toContain('похож на');
    expect(text).toContain('ничего не пропало');
  });
});
