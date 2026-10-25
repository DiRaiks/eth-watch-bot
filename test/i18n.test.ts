import { encodeFunctionData, maxUint256, parseAbiItem } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';

import { en } from '../src/i18n/en.js';
import { setLanguage } from '../src/i18n/index.js';
import { ru } from '../src/i18n/ru.js';
import { formatAmount, formatTime } from '../src/format.js';
import type { Activity } from '../src/watch/activity.js';
import { formatDigest } from '../src/watch/digest.js';
import { activityLine, type Enrichment } from '../src/watch/messages.js';
import { DEFAULT_PREFS } from '../src/watch/prefs.js';
import { settingsText } from '../src/watch/settings.js';
import {
  ALICE,
  BOB,
  buildTestApp,
  CAROL,
  erc20,
  message,
  testConfig,
  tx,
  txHash,
  USDC,
} from './helpers.js';

type TestApp = Awaited<ReturnType<typeof buildTestApp>>;
let current: TestApp | undefined;
afterEach(async () => {
  await current?.app.close();
  current = undefined;
  setLanguage('ru');
});

/** A chat (id 10) watching ALICE, in English */
const start = async () => {
  current = await buildTestApp({
    config: testConfig({ language: 'en' }),
    prices: async (_chain, tokens) =>
      new Map(tokens.map((token) => [token, token === null ? 2000 : 1])),
  });
  current.chain.setHead(100);
  await current.scanner.tick();
  await current.watches.add(10, ALICE, 'Wallet');
  current.api.clear();
  return current;
};

const mine = async (
  t: TestApp,
  transactions: ReturnType<typeof tx>[],
  logs: Parameters<TestApp['chain']['addBlock']>[2] = [],
) => {
  const number = (t.scanner.status().lastBlock ?? 100) + 1;
  t.chain.addBlock(number, transactions, logs);
  t.chain.setHead(number);
  await t.scanner.tick();
};

describe('languages', () => {
  it('has every text in both languages', () => {
    expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort());
  });

  it('has no Russian left in the English texts', () => {
    const render = (text: unknown): string =>
      typeof text === 'function'
        ? // Every parameter is a number, a string or markup: 1 renders as any of them
          render(text(...Array.from({ length: text.length }, () => 1)))
        : String(text);
    for (const [key, text] of Object.entries(en)) {
      expect(render(text), key).not.toMatch(/[А-Яа-яЁё]/u);
    }
    for (const [key, text] of Object.entries(ru)) {
      expect(render(text), key).not.toBe('');
    }
  });

  it('formats numbers and dates for the language', () => {
    const at = Date.UTC(2026, 9, 25, 14, 5);
    setLanguage('en');
    expect(formatAmount(1_234_567n, 0)).toBe('1,234,567');
    expect(formatTime(at)).toBe('25 Oct 14:05 UTC');
    setLanguage('ru');
    expect(formatAmount(1_234_567n, 0)).toBe('1 234 567');
    expect(formatTime(at)).toBe('25.10 14:05 UTC');
  });

  it('speaks English with LANGUAGE=en: commands and alerts', async () => {
    const t = await start();
    await t.app.tg.bot.handleUpdate(message(`/watch ${BOB} Bob`));
    expect(t.api.texts().at(-1)).toContain('👀 Watching <b>Bob</b>');
    // The kit's own /help is in English too, including its own line
    await t.app.tg.bot.handleUpdate(message('/help'));
    const help = t.api.texts().at(-1)!;
    expect(help).toMatch(/^Commands:\n/);
    expect(help).toContain('/help — List of commands');
    expect(help).not.toMatch(/[А-Яа-яЁё]/u);
    t.api.clear();

    const approve = encodeFunctionData({
      abi: [parseAbiItem('function approve(address,uint256)')],
      args: [CAROL, maxUint256],
    });
    await mine(
      t,
      [
        tx(1, { from: ALICE, to: BOB, value: 10n ** 18n }),
        tx(2, { from: ALICE, to: USDC, input: approve }),
      ],
      [
        {
          type: 'approval',
          token: USDC,
          owner: ALICE,
          spender: CAROL,
          value: maxUint256,
          transactionHash: txHash(2),
        },
        erc20(3, { from: CAROL, to: ALICE, value: 2_500_000_000n }),
      ],
    );
    const texts = t.api.texts();
    const alert = texts.find((text) => text.startsWith('🚨'))!;
    expect(alert).toContain('can spend <b>all</b> your');
    expect(alert).toContain('· ⚠️ <b>approve</b>(spender <a href=');
    expect(alert).toContain('amount <b>all</b>)');
    expect(alert).toContain('If this was not you');
    expect(alert).toMatch(/>Transaction<\/a> · block 101/);
    expect(texts.join('\n')).toContain('⬆️ Sent <b>1 ETH</b> ($2,000)');
    expect(texts.join('\n')).toContain('⬇️ Received <b>2,500</b>');
    const buttons = JSON.stringify(
      t.api.sent().map((call) => call.payload.reply_markup),
    );
    expect(buttons).toContain('Mute for 24 h');
  });
});

describe('English alerts', () => {
  const data: Enrichment = {
    tokens: new Map([[USDC, { symbol: 'USDC', decimals: 6 }]]),
    methods: new Map(),
    prices: new Map(),
  };
  const base = {
    address: ALICE,
    hash: txHash(1),
    order: 0,
    importance: 'alert',
    spam: null,
  } as const;
  const text = (activity: Activity) => {
    setLanguage('en');
    return activityLine('ethereum', activity, data).value;
  };
  const sent = {
    ...base,
    kind: 'send-token',
    token: USDC,
    from: ALICE,
    to: CAROL,
    value: 2_500_000_000n,
    sentBy: BOB,
  } as const;

  it('describes drains, poisoning and forged tokens', () => {
    expect(text(sent)).toMatch(
      /^🚨 Pulled out <b>2,500<\/b> <a [^>]+>USDC<\/a> → <a [^>]+>Lido stETH<\/a> in a transaction sent by <a [^>]+>0x0000…05Fa<\/a>$/,
    );
    expect(text({ ...sent, value: 0n, spam: 'fake-transfer' })).toContain(
      'This is address poisoning',
    );
    expect(text({ ...sent, spam: 'fake-token' })).toMatch(
      /^⚠️ Pulled out .* · ⚠️ you do not hold this token, likely a forgery: nothing was lost$/,
    );
    expect(
      text({
        ...base,
        kind: 'send-nft',
        token: USDC,
        from: ALICE,
        to: CAROL,
        tokenIds: [1n, 2n, 3n, 4n],
        amounts: null,
        sentBy: BOB,
      }),
    ).toContain('🚨 Pulled out NFT <a');
  });

  it('describes approvals and their revocation', () => {
    const forAll = {
      ...base,
      kind: 'approval-for-all',
      token: USDC,
      operator: CAROL,
      approved: true,
    } as const;
    expect(text(forAll)).toContain('can take <b>all</b> NFTs of the');
    expect(text({ ...forAll, approved: false })).toMatch(/^✅ .* revoked$/);
    const nft = {
      ...base,
      kind: 'nft-approval',
      token: USDC,
      spender: CAROL,
      tokenId: 7n,
    } as const;
    expect(text(nft)).toContain('can take NFT <a');
    expect(text({ ...nft, importance: 'outgoing' })).toContain('#7 cleared');
  });

  it('writes the digest, settings and overflow lines in English', () => {
    setLanguage('en');
    expect(formatDigest([], String, 'ethereum').value).toBe(
      '📋 <b>Daily digest</b>\nNo incoming transactions.',
    );
    const settings = settingsText(DEFAULT_PREFS, ['ethereum']).value;
    expect(settings).toContain('Incoming threshold: all');
    expect(settings).toContain('Quiet hours: off');
    expect(en.moreAlerts(1, '5', 'Base').value).toContain(
      '…and 1 more alert in',
    );
    expect(en.moreTransactions(2, '5', 'Base').value).toContain(
      '…and 2 more transactions in',
    );
    expect(en.toAddresses(3)).toBe(' → 3 addresses');
    expect(en.items(1)).toBe('[1 item]');
  });
});
