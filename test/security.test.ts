import type { Address } from 'viem';
import { encodeFunctionData, maxUint256, parseAbiItem } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';

import type { PriceLookup } from '../src/enrich/prices.js';
import type { SignatureLookup } from '../src/enrich/signatures.js';
import type { ChatPrefs } from '../src/watch/prefs.js';
import {
  ALICE,
  BOB,
  buildTestApp,
  callback,
  CAROL,
  erc20,
  message,
  testConfig,
  tx,
  txHash,
  USDC,
  type NewLog,
} from './helpers.js';

type TestApp = Awaited<ReturnType<typeof buildTestApp>>;
let current: TestApp | undefined;
afterEach(async () => {
  await current?.app.close();
  current = undefined;
});

const PRICES: PriceLookup = async (_chain, tokens) =>
  new Map(
    tokens.flatMap((token): [Address | null, number][] =>
      token === null ? [[null, 2000]] : token === USDC ? [[USDC, 1]] : [],
    ),
  );

/** A chat (id 10) watching ALICE, with optional settings and a fixed clock */
const start = async ({
  prefs,
  prices = PRICES,
  methods,
  now = () => Date.UTC(2026, 9, 25, 12),
  config,
}: {
  prefs?: Partial<ChatPrefs>;
  prices?: PriceLookup | null;
  methods?: SignatureLookup;
  now?: () => number;
  config?: Parameters<typeof testConfig>[0];
} = {}) => {
  current = await buildTestApp({
    prices,
    methods,
    now,
    config: testConfig(config),
  });
  current.chain.setHead(100);
  await current.scanner.tick();
  await current.watches.add(10, ALICE, 'Wallet');
  if (prefs) await current.watches.setPrefs(10, prefs);
  current.api.clear();
  return current;
};

const mine = async (
  t: TestApp,
  transactions: ReturnType<typeof tx>[],
  logs: NewLog[] = [],
) => {
  const number = (t.scanner.status().lastBlock ?? 100) + 1;
  t.chain.addBlock(number, transactions, logs);
  t.chain.setHead(number);
  await t.scanner.tick();
};

const approval = (n: number, value: bigint): NewLog => ({
  type: 'approval',
  token: USDC,
  owner: ALICE,
  spender: CAROL,
  value,
  transactionHash: txHash(n),
});

describe('risky activity', () => {
  it('raises an alert for an unlimited approval, with advice', async () => {
    const t = await start();
    await mine(
      t,
      [tx(1, { from: ALICE, to: USDC, input: '0x095ea7b3' })],
      [approval(1, maxUint256)],
    );
    const [text] = t.api.texts();
    expect(text).toContain('🚨 <b>Wallet</b> · Ethereum');
    expect(text).toContain('· ⚠️ <b>approve</b>');
    expect(text).toContain('может тратить <b>все</b> ваши');
    expect(text).toContain('revoke.cash');
  });

  it('shows limited approvals and revocations', async () => {
    const t = await start();
    await mine(t, [], [approval(1, 5_000_000n), approval(2, 0n)]);
    const [limited, revoked] = t.api.texts();
    expect(limited).toContain('⚠️ Разрешение');
    expect(limited).toContain('<b>5</b>');
    expect(revoked).toContain('✅ Разрешение на');
    expect(revoked).toContain('отозвано');
    expect(revoked).not.toContain('🚨');
  });

  it('alerts when tokens leave the wallet in someone else’s transaction, even while muted', async () => {
    const t = await start({
      prefs: { quiet: { from: 0, to: 23 }, timeZone: 'UTC' },
    });
    await t.watches.mute(10, ALICE, Date.UTC(2027, 0, 1));
    await mine(
      t,
      [tx(1, { from: CAROL, to: USDC })],
      [erc20(1, { from: ALICE, to: CAROL, value: 1_000_000_000n })],
    );
    const [sent] = t.api.sent();
    expect(sent?.payload.text).toContain('🚨 Списано <b>1 000</b>');
    expect(sent?.payload.text).toContain('($1 000)');
    expect(sent?.payload.text).toContain('транзакцию отправил');
    // Alerts ring even in quiet hours
    expect(sent?.payload.disable_notification).toBe(false);
  });

  it('warns about address poisoning and hides it when asked', async () => {
    const t = await start();
    const poison = [tx(1, { from: CAROL, to: CAROL })];
    await mine(t, poison, [erc20(1, { from: ALICE, to: BOB, value: 0n })]);
    expect(t.api.texts()[0]).toContain('⚠️ Поддельный перевод');
    expect(t.api.texts()[0]).toContain('address poisoning');

    await t.watches.setPrefs(10, { spam: 'hide' });
    t.api.clear();
    await mine(t, poison, [erc20(1, { from: ALICE, to: BOB, value: 0n })]);
    expect(t.api.sent()).toEqual([]);
  });

  it('reports NFTs and collection-wide approvals', async () => {
    const t = await start();
    await mine(
      t,
      [tx(4, { from: CAROL, to: CAROL })],
      [
        {
          type: 'nft',
          token: CAROL,
          from: BOB,
          to: ALICE,
          tokenIds: [1n, 2n, 3n, 4n],
          amounts: [1n, 2n, 1n, 1n],
          transactionHash: txHash(1),
        },
        {
          type: 'approval-for-all',
          token: CAROL,
          owner: ALICE,
          operator: BOB,
          approved: true,
          transactionHash: txHash(2),
        },
        {
          type: 'nft-approval',
          token: CAROL,
          owner: ALICE,
          spender: BOB,
          tokenId: 9n,
          transactionHash: txHash(3),
        },
        {
          type: 'nft',
          token: CAROL,
          from: ALICE,
          to: BOB,
          tokenIds: [5n],
          amounts: null,
          transactionHash: txHash(4),
        },
      ],
    );
    const texts = t.api.texts();
    // Alerts go first, in block order: two approvals and the NFT taken in Carol's transaction
    expect(texts[0]).toContain('может забрать <b>все</b> NFT коллекции');
    expect(texts[1]).toContain('может забрать NFT');
    expect(texts[2]).toContain('🚨 Списан NFT');
    expect(texts[3]).toContain('🖼 Получен NFT');
    expect(texts[3]).toContain('#1, #2 ×2, #3 и ещё 1');
  });
});

describe('message details', () => {
  it('shows dollar amounts and flags tokens without a price', async () => {
    const t = await start();
    const spamToken = '0x1111111111111111111111111111111111111111';
    await mine(
      t,
      [tx(1, { from: BOB, to: ALICE, value: 10n ** 18n })],
      [erc20(2, { from: BOB, to: ALICE, value: 5n, token: spamToken })],
    );
    const [native, unpriced] = t.api.texts();
    expect(native).toContain('<b>1 ETH</b> ($2 000)');
    expect(unpriced).toContain('⚠️ токен без цены, возможно спам');
  });

  it('does not call a token spam when prices are unavailable', async () => {
    const t = await start({ prices: async () => null });
    await mine(t, [], [erc20(2, { from: BOB, to: ALICE, value: 5n })]);
    expect(t.api.texts()[0]).not.toContain('спам');
    expect(t.api.texts()[0]).not.toContain('$');
  });

  it('decodes call parameters, with amounts in the called token', async () => {
    const t = await start();
    const transfer = encodeFunctionData({
      abi: [parseAbiItem('function transfer(address,uint256)')],
      args: [CAROL, 2_500_000n],
    });
    const permit2 = encodeFunctionData({
      abi: [parseAbiItem('function approve(address,address,uint160,uint48)')],
      args: [USDC, CAROL, 2n ** 160n - 1n, 1_800_000_000],
    });
    await mine(t, [
      tx(1, { from: ALICE, to: USDC, input: transfer }),
      tx(2, { from: ALICE, to: BOB, input: permit2 }),
    ]);
    const [sent, approved] = t.api.texts();
    expect(sent).toContain('<b>transfer</b>(to <a href=');
    expect(sent).toContain('amount 2.5 USDC)');
    // Permit2 counts the amount in the token named by the first argument
    expect(approved).toContain('>USDC</a>, spender');
    expect(approved).toContain('amount <b>все</b>, expiration');
  });

  it('marks method names from the public database as hints', async () => {
    const t = await start({
      methods: async (selector) =>
        selector === '0x12345678'
          ? { name: 'claim', trusted: false, signature: null }
          : null,
    });
    await mine(t, [
      tx(1, { from: ALICE, to: CAROL, input: '0x12345678' }),
      tx(2, { from: ALICE, to: CAROL, input: '0x99999999' }),
    ]);
    const [hint, unknown] = t.api.texts();
    expect(hint).toContain('метод <code>0x12345678</code> (похоже на claim)');
    expect(unknown).toContain('метод <code>0x99999999</code>');
  });
});

describe('chat settings', () => {
  it('skips small incoming transfers but never outgoing ones', async () => {
    const t = await start({ prefs: { minIncomingUsd: 100 } });
    await mine(t, [
      tx(1, { from: BOB, to: ALICE, value: 10n ** 16n }), // $20
      tx(2, { from: BOB, to: ALICE, value: 10n ** 17n }), // $200
      tx(3, { from: ALICE, to: BOB, value: 10n ** 15n }), // $2, outgoing
      tx(4, { from: BOB, to: ALICE }), // an incoming call without value
    ]);
    const texts = t.api.texts();
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain('($200)');
    expect(texts[1]).toContain('⬆️ Отправлено');
  });

  it('keeps incoming transfers whose value is unknown', async () => {
    const t = await start({ prefs: { minIncomingUsd: 100 }, prices: null });
    await mine(t, [tx(1, { from: BOB, to: ALICE, value: 1n })]);
    expect(t.api.sent()).toHaveLength(1);
  });

  it('ignores muted chains', async () => {
    const t = await start({ prefs: { mutedChains: ['ethereum'] } });
    await mine(t, [tx(1, { from: ALICE, to: BOB, value: 1n })]);
    expect(t.api.sent()).toEqual([]);
  });

  it('delivers silently in quiet hours', async () => {
    const t = await start({
      prefs: { quiet: { from: 11, to: 13 }, timeZone: 'UTC' },
    });
    await mine(t, [tx(1, { from: ALICE, to: BOB, value: 1n })]);
    expect(t.api.sent()[0]?.payload.disable_notification).toBe(true);
  });

  it('collects incoming activity for the digest and still sends outgoing at once', async () => {
    let now = Date.UTC(2026, 9, 25, 5);
    const t = await start({
      prefs: { mode: 'digest', digestHour: 9, timeZone: 'Europe/Moscow' },
      now: () => now,
    });
    await mine(t, [
      tx(1, { from: BOB, to: ALICE, value: 10n ** 18n }),
      tx(2, { from: BOB, to: ALICE, value: 10n ** 18n }),
      tx(3, { from: ALICE, to: BOB, value: 1n }),
    ]);
    expect(t.api.texts()).toHaveLength(1);
    expect(t.api.texts()[0]).toContain('⬆️ Отправлено');

    // 05:00 UTC is 08:00 in UTC+3: not yet
    expect(await t.digest.tick()).toEqual([]);
    now = Date.UTC(2026, 9, 25, 6);
    expect(await t.digest.tick()).toEqual([10]);
    const digest = t.api.texts().at(-1)!;
    expect(digest).toContain('📋 <b>Сводка за сутки</b>');
    expect(digest).toContain('<b>Wallet</b>');
    expect(digest).toContain('2 входящих на ~$4 000');
    expect(t.api.sent().at(-1)?.payload.disable_notification).toBe(true);

    // Once a day; the next day says nothing happened
    expect(await t.digest.tick()).toEqual([]);
    now = Date.UTC(2026, 9, 26, 6);
    await t.digest.tick();
    expect(t.api.texts().at(-1)).toContain('Входящих транзакций не было');
  });

  it('changes settings with the /settings buttons', async () => {
    const t = await start({
      config: {
        chains: [
          { name: 'ethereum', rpcUrl: 'http://rpc', confirmations: 0 },
          { name: 'base', rpcUrl: 'http://rpc', confirmations: 0 },
        ],
      },
    });
    await t.app.tg.bot.handleUpdate(message('/settings'));
    const [shown] = t.api.sent();
    expect(String(shown?.payload.text)).toContain(
      '⚙️ <b>Настройки уведомлений</b>',
    );
    expect(JSON.stringify(shown?.payload.reply_markup)).toContain(
      'set:chain:base',
    );

    await t.app.tg.bot.handleUpdate(callback('set:min:100', []));
    await t.app.tg.bot.handleUpdate(callback('set:chain:base', []));
    expect(t.watches.prefs(10)).toMatchObject({
      minIncomingUsd: 100,
      mutedChains: ['base'],
    });
    const edit = t.api.calls.find((c) => c.method === 'editMessageText');
    expect(String(edit?.payload.text)).toContain('Порог для входящих: от $100');
    expect(t.api.calls.at(-1)).toMatchObject({
      method: 'answerCallbackQuery',
      payload: { text: 'Сохранено' },
    });

    await t.app.tg.bot.handleUpdate(callback('set:noop', []));
    await t.app.tg.bot.handleUpdate(callback('set:min:7', []));
    expect(t.watches.prefs(10).minIncomingUsd).toBe(100);
  });

  it('lets only group admins change settings', async () => {
    const t = await start();
    // The fake API answers getChatMember with `true`: not an admin
    await t.app.tg.bot.handleUpdate(
      callback('set:min:100', [], { chatId: -5, chatType: 'group' }),
    );
    expect(t.api.calls.at(-1)?.payload.text).toBe(
      'Это могут сделать только админы чата.',
    );
    expect(t.watches.prefs(-5).minIncomingUsd).toBe(0);
  });
});

describe('review findings', () => {
  const FAKE = '0x9999999999999999999999999999999999999999' as Address;

  it('turns alarms about a token the wallet never held into a note', async () => {
    const t = await start();
    t.chain.setBalance(FAKE, ALICE, 0n);
    await mine(
      t,
      [tx(1, { from: CAROL, to: FAKE })],
      [erc20(1, { from: ALICE, to: CAROL, value: 10n ** 21n, token: FAKE })],
    );
    const [text] = t.api.texts();
    expect(text).toContain('🔔 <b>Wallet</b>');
    expect(text).toContain('у вас нет этого токена, похоже на подделку');
    expect(text).not.toContain('revoke.cash');
    // The balance before the block decides
    expect(t.chain.balanceCalls.at(-1)).toMatchObject({
      token: FAKE,
      owner: ALICE,
      block: 100,
    });
  });

  it('keeps the alarm when the token does not answer', async () => {
    const t = await start();
    t.chain.setBalance(FAKE, ALICE, null);
    await mine(
      t,
      [tx(1, { from: CAROL, to: FAKE })],
      [erc20(1, { from: ALICE, to: CAROL, value: 5n, token: FAKE })],
    );
    expect(t.api.texts()[0]).toContain('🚨 Списано');
  });

  it('never caps alerts at the ordinary limit, nor drops them on a muted chain', async () => {
    const t = await start({ prefs: { mutedChains: ['ethereum'] } });
    await mine(
      t,
      [tx(99, { from: ALICE, to: BOB, value: 1n })],
      Array.from({ length: 7 }, (_, i) => ({
        type: 'approval' as const,
        token: USDC,
        owner: ALICE,
        spender: CAROL,
        value: 5n,
        transactionHash: txHash(i + 1),
      })),
    );
    const texts = t.api.texts();
    // Seven alerts; the ordinary transfer is dropped by the muted chain
    expect(texts).toHaveLength(7);
    expect(texts.every((text) => text.startsWith('🚨'))).toBe(true);
  });

  it('summarises a flood of alerts with a message that rings', async () => {
    const t = await start();
    await mine(
      t,
      [],
      Array.from({ length: 23 }, (_, i) => ({
        type: 'approval' as const,
        token: USDC,
        owner: ALICE,
        spender: CAROL,
        value: 5n,
        transactionHash: txHash(i + 1),
      })),
    );
    const sent = t.api.sent();
    expect(sent).toHaveLength(21);
    expect(String(sent.at(-1)?.payload.text)).toContain('🚨 …и ещё 3 тревог');
    expect(sent.at(-1)?.payload.disable_notification).toBeUndefined();
  });

  it('does not alarm about the allowance a swap spends', async () => {
    const t = await start();
    await mine(
      t,
      [tx(1, { from: ALICE, to: CAROL })],
      [
        erc20(1, { from: ALICE, to: CAROL, value: 5_000_000n }),
        {
          type: 'approval',
          token: USDC,
          owner: ALICE,
          spender: CAROL,
          value: 95_000_000n,
          transactionHash: txHash(1),
        },
      ],
    );
    const [text] = t.api.texts();
    expect(text).toContain('⬆️ Отправлено');
    expect(text).not.toContain('Разрешение');
  });

  it('raises an alert for a Permit2 allowance with its expiry', async () => {
    const t = await start();
    await mine(
      t,
      [],
      [
        {
          type: 'permit2',
          token: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
          owner: ALICE,
          asset: USDC,
          spender: CAROL,
          amount: 2n ** 160n - 1n,
          expiration: Date.UTC(2026, 10, 25, 9) / 1000,
          transactionHash: txHash(1),
        },
      ],
    );
    const [text] = t.api.texts();
    expect(text).toContain('🚨 Разрешение через Permit2 до 25.11 09:00 UTC');
    expect(text).toContain('<b>все</b> ваши');
  });

  it('keeps messages within Telegram limits', async () => {
    const t = await start();
    await mine(
      t,
      [],
      Array.from({ length: 30 }, () =>
        erc20(1, { from: BOB, to: ALICE, value: 1_000_000n }),
      ),
    );
    const [text] = t.api.texts();
    expect(text!.length).toBeLessThan(4096);
    expect(text).toContain('…и ещё 18 в этой транзакции');
  });

  it('shows tokens without a price even when spam is hidden', async () => {
    const t = await start({ prefs: { spam: 'hide' } });
    await mine(
      t,
      [],
      [erc20(1, { from: BOB, to: ALICE, value: 5n, token: FAKE })],
    );
    expect(t.api.texts()[0]).toContain('токен без цены');
  });

  it('sends incoming activity at once when the digest cannot save it', async () => {
    const t = await start({ prefs: { mode: 'digest' } });
    t.stores.digests.add = async () => {
      throw new Error('db down');
    };
    await mine(t, [tx(1, { from: BOB, to: ALICE, value: 1n })]);
    expect(t.api.texts()[0]).toContain('⬇️ Получено');
  });

  it('keeps digest entries when the digest is not delivered, and catches up later', async () => {
    let now = Date.UTC(2026, 9, 25, 5);
    let fail = true;
    current = await buildTestApp({
      prices: PRICES,
      now: () => now,
      respond: (call) => {
        if (
          fail &&
          call.method === 'sendMessage' &&
          String(call.payload.text).includes('Сводка')
        ) {
          throw new Error('telegram down');
        }
        return true;
      },
    });
    const t = current;
    t.chain.setHead(100);
    await t.scanner.tick();
    await t.watches.add(10, ALICE, 'Wallet');
    await t.watches.setPrefs(10, {
      mode: 'digest',
      digestHour: 9,
      timeZone: 'Europe/Moscow',
    });
    await mine(t, [tx(1, { from: BOB, to: ALICE, value: 10n ** 18n })]);

    // 13:00 in Moscow, well after the digest hour: the bot was down at 09:00
    now = Date.UTC(2026, 9, 25, 10);
    expect(await t.digest.tick()).toEqual([]);
    fail = false;
    expect(await t.digest.tick()).toEqual([10]);
    expect(t.api.texts().at(-1)).toContain('1 входящих');
  });

  it('drops collected entries when the chat goes back to every message', async () => {
    const t = await start({ prefs: { mode: 'digest' } });
    await mine(t, [tx(1, { from: BOB, to: ALICE, value: 1n })]);
    await t.app.tg.bot.handleUpdate(callback('set:mode:each', []));
    expect(await t.stores.digests.take(10)).toEqual([]);
  });

  it('applies two quick button presses on top of each other', async () => {
    const t = await start({
      config: {
        chains: [
          { name: 'ethereum', rpcUrl: 'http://rpc', confirmations: 0 },
          { name: 'base', rpcUrl: 'http://rpc', confirmations: 0 },
          { name: 'arbitrum', rpcUrl: 'http://rpc', confirmations: 0 },
        ],
      },
    });
    await Promise.all([
      t.app.tg.bot.handleUpdate(callback('set:chain:base', [])),
      t.app.tg.bot.handleUpdate(callback('set:chain:arbitrum', [])),
    ]);
    expect([...t.watches.prefs(10).mutedChains].sort()).toEqual([
      'arbitrum',
      'base',
    ]);
  });
});
