import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';

import { memoryContacts, pgContacts } from '../src/watch/contacts.js';
import {
  ALICE,
  BOB,
  buildTestApp,
  CAROL,
  message,
  tx,
  txHash,
} from './helpers.js';

type TestApp = Awaited<ReturnType<typeof buildTestApp>>;
let current: TestApp | undefined;

const start = async () => {
  current = await buildTestApp();
  current.chain.setHead(100);
  await current.scanner.tick();
  await current.app.tg.bot.handleUpdate(message(`/watch ${ALICE} Alice`));
  current.api.clear();
  return current;
};

const mine = async (t: TestApp, transactions: ReturnType<typeof tx>[]) => {
  const number = (t.scanner.status().lastBlock ?? 100) + 1;
  t.chain.addBlock(number, transactions);
  t.chain.setHead(number);
  await t.scanner.tick();
  return t.api.texts().at(-1) ?? '';
};

afterEach(async () => {
  await current?.app.close();
  current = undefined;
});

describe('what the alert tells about the transaction', () => {
  it('marks a failed transaction and shows the fee it still cost', async () => {
    const t = await start();
    t.chain.setReceipt(txHash(1), {
      success: false,
      fee: 210_000_000_000_000n,
    });
    const text = await mine(t, [
      tx(1, { from: ALICE, to: BOB, value: 10n ** 15n }),
    ]);
    expect(text.split('\n')[0]).toContain('исходящая · ❌ не прошла');
    expect(text).toContain('❌ <b>Транзакция не прошла</b>');
    expect(text).toContain('⛽ Комиссия 0.00021 ETH');
  });

  it('shows the balance after the block and the block time in the chat zone', async () => {
    const t = await start();
    t.chain.setReceipt(txHash(1), { success: true, fee: 10n ** 13n });
    t.chain.setNativeBalance(ALICE, 512n * 10n ** 15n);
    const text = await mine(t, [
      tx(1, { from: ALICE, to: BOB, value: 10n ** 15n }),
    ]);
    expect(text).not.toContain('не прошла');
    expect(text).toContain('💰 Баланс: 0.512 ETH');
    // 1_700_000_101 s is 14 Nov 2023 22:15 UTC, 01:15 next day in Moscow
    expect(text).toMatch(/блок 101 · 15\.11 01:15/);
  });

  it('names known contracts, marks other contracts and first dealings', async () => {
    const t = await start();
    const first = await mine(t, [
      tx(1, { from: ALICE, to: CAROL, value: 10n ** 15n }),
    ]);
    // CAROL is Lido stETH: its name, no contract note
    expect(first).toContain('>Lido stETH</a>');
    expect(first).not.toContain('(контракт)');
    expect(first).toContain('🆕 впервые');

    t.chain.addContract(BOB);
    const toContract = await mine(t, [
      tx(2, { from: ALICE, to: BOB, value: 10n ** 15n }),
    ]);
    expect(toContract).toContain('(контракт) · 🆕 впервые');

    const again = await mine(t, [
      tx(3, { from: ALICE, to: BOB, value: 10n ** 15n }),
    ]);
    expect(again).not.toContain('впервые');
  });

  it('leaves the lines out when the RPC does not answer', async () => {
    const t = await start();
    const text = await mine(t, [
      tx(1, { from: ALICE, to: BOB, value: 10n ** 15n }),
    ]);
    expect(text).not.toContain('Комиссия');
    expect(text).not.toContain('Баланс');
  });
});

describe('contact stores', () => {
  it('tell a first dealing from a repeated one, whatever the letter case', async () => {
    const db = await PGlite.create();
    for (const store of [memoryContacts(), await pgContacts(db)]) {
      expect(await store.remember(ALICE, BOB)).toBe(true);
      expect(
        await store.remember(
          ALICE.toLowerCase() as typeof ALICE,
          BOB.toLowerCase() as typeof BOB,
        ),
      ).toBe(false);
      expect(await store.remember(BOB, ALICE)).toBe(true);
    }
    await db.close();
  });
});
