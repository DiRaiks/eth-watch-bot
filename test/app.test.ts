import { GrammyError } from 'grammy';
import { afterEach, describe, expect, it } from 'vitest';

import { memoryStores } from '../src/storage.js';
import {
  ADMIN_ID,
  ALICE,
  BOB,
  buildTestApp,
  callback,
  CAROL,
  erc20,
  fakeChain,
  message,
  testConfig,
  textInput,
  tx,
  USDC,
} from './helpers.js';

type TestApp = Awaited<ReturnType<typeof buildTestApp>>;
let current: TestApp | undefined;

const start = async (options: Parameters<typeof buildTestApp>[0] = {}) => {
  current = await buildTestApp(options);
  // First tick only sets the starting block
  current.chain.setHead(100);
  await current.scanner.tick();
  current.api.clear();
  return current;
};

afterEach(async () => {
  await current?.app.close();
  current = undefined;
});

const send = (t: TestApp, update: ReturnType<typeof message>) =>
  t.app.tg.bot.handleUpdate(update);

/** Adds a block on top of the chain and lets the scanner process it */
const mine = async (
  t: TestApp,
  transactions: ReturnType<typeof tx>[],
  transfers: Parameters<TestApp['chain']['addBlock']>[2] = [],
) => {
  const number = (t.scanner.status().lastBlock ?? 100) + 1;
  t.chain.addBlock(number, transactions, transfers);
  t.chain.setHead(number);
  await t.scanner.tick();
  return number;
};

describe('address watching', () => {
  it('notifies about a transfer whatever the letter case of the address', async () => {
    const t = await start();
    await send(t, message(`/watch ${ALICE.toLowerCase()} Alice`));
    expect(t.api.texts().at(-1)).toContain('Слежу за <b>Alice</b>');

    t.api.clear();
    await mine(t, [
      tx(1, { from: ALICE, to: BOB, value: 1_500_000_000_000_000_000n }),
    ]);
    const [sent] = t.api.sent();
    expect(sent?.payload.chat_id).toBe(10);
    expect(sent?.payload.text).toContain('🔔 <b>Alice</b> · Ethereum');
    expect(sent?.payload.text).toContain('⬆️ Отправлено <b>1.5 ETH</b>');
    expect(sent?.payload.text).toContain('блок 101');
    expect(sent?.payload.reply_markup).toEqual({
      inline_keyboard: [
        [{ text: '🔕 Заглушить на 24 ч', callback_data: `mute:${ALICE}` }],
      ],
    });
  });

  it('notifies every chat watching the address', async () => {
    const t = await start();
    await send(t, message(`/watch ${BOB}`, { chatId: 1 }));
    await send(t, message(`/watch ${BOB}`, { chatId: 2 }));
    t.api.clear();

    await mine(t, [tx(1, { from: ALICE, to: BOB, value: 10n ** 17n })]);
    expect(t.api.sent().map((c) => c.payload.chat_id)).toEqual([1, 2]);
    expect(t.api.texts()[0]).toContain('⬇️ Получено <b>0.1 ETH</b> от');
  });

  it('describes contract calls and ERC-20 transfers in one message per transaction', async () => {
    const t = await start();
    await send(t, message(`/watch ${ALICE} Alice`));
    t.api.clear();

    await mine(
      t,
      [tx(1, { from: ALICE, to: USDC, input: '0xa9059cbb0000' })],
      [erc20(1, { from: ALICE, to: CAROL, value: 250_000_000n })],
    );
    expect(t.api.sent()).toHaveLength(1);
    const text = t.api.texts()[0];
    expect(text).toContain('⚙️ Вызов <a');
    expect(text).toContain('· <b>transfer</b>');
    expect(text).toContain('⬆️ Отправлено <b>250</b>');
    expect(text).toContain('>USDC</a>');
  });

  it('labels each line when one transaction touches several watched addresses', async () => {
    const t = await start();
    await send(t, message(`/watch ${ALICE} Alice`));
    await send(t, message(`/watch ${BOB} Bob`));
    t.api.clear();

    await mine(t, [tx(1, { from: ALICE, to: BOB, value: 10n ** 18n })]);
    const [sent] = t.api.sent();
    expect(sent?.payload.text).toContain('🔔 <b>Alice, Bob</b>');
    expect(sent?.payload.text).toContain('<b>Alice</b>: ⬆️ Отправлено');
    expect(sent?.payload.text).toContain('<b>Bob</b>: ⬇️ Получено');
    expect(sent?.payload.reply_markup).toEqual({
      inline_keyboard: [
        [{ text: '🔕 Alice на 24 ч', callback_data: `mute:${ALICE}` }],
        [{ text: '🔕 Bob на 24 ч', callback_data: `mute:${BOB}` }],
      ],
    });
  });

  it('reports contract creation and incoming calls, and shows unknown tokens by address', async () => {
    const t = await start();
    await send(t, message(`/watch ${ALICE}`));
    t.api.clear();
    const unknown = '0x1111111111111111111111111111111111111111';

    await mine(
      t,
      [
        tx(1, { from: ALICE, to: null }),
        tx(2, { from: BOB, to: ALICE, input: '0x12345678' }),
      ],
      [erc20(3, { token: unknown, from: BOB, to: ALICE, value: 5n })],
    );
    const texts = t.api.texts();
    expect(texts[0]).toContain('🧱 Создание контракта');
    expect(texts[1]).toContain('⚙️ Вызов от');
    expect(texts[2]).toContain('<b>5 ед.</b>');
    expect(texts[2]).toContain('0x1111…1111');
  });

  it('summarises a burst of transactions instead of flooding the chat', async () => {
    const t = await start();
    await send(t, message(`/watch ${ALICE}`));
    t.api.clear();

    await mine(
      t,
      Array.from({ length: 8 }, (_, i) => tx(i, { from: ALICE, value: 1n })),
    );
    const texts = t.api.texts();
    expect(texts).toHaveLength(6);
    expect(texts[5]).toBe('…и ещё 3 транзакций в блоке 101 (Ethereum)');
  });

  it('forgets chats that blocked the bot', async () => {
    const t = await start({
      respond: (call) => {
        if (call.method === 'sendMessage' && call.payload.chat_id === 2) {
          throw new GrammyError(
            'blocked',
            {
              ok: false,
              error_code: 403,
              description: 'Forbidden: bot was blocked by the user',
            },
            'sendMessage',
            {},
          );
        }
        return true;
      },
    });
    await send(t, message(`/watch ${ALICE}`, { chatId: 1 }));
    await t.watches.add(2, ALICE);

    await mine(t, [tx(1, { from: ALICE, value: 1n })]);
    expect(t.watches.watchers(ALICE).map((w) => w.chatId)).toEqual([1]);
  });

  it('mutes and unmutes an address from the notification buttons', async () => {
    const t = await start();
    await send(t, message(`/watch ${ALICE} Alice`));
    const keyboard = [[{ text: '🔕', callback_data: `mute:${ALICE}` }]];

    await send(t, callback(`mute:${ALICE}`, keyboard));
    expect(t.watches.watchers(ALICE)).toEqual([]);
    const edit = t.api.calls.find((c) => c.method === 'editMessageReplyMarkup');
    expect(edit?.payload.reply_markup).toEqual({
      inline_keyboard: [
        [{ text: '🔔 Вернуть Alice', callback_data: `unmute:${ALICE}` }],
      ],
    });
    expect(t.api.calls.at(-1)?.payload.text).toMatch(/^Alice: тишина до /);

    t.api.clear();
    await mine(t, [tx(1, { from: ALICE, value: 1n })]);
    expect(t.api.sent()).toEqual([]);

    await send(t, message('/list'));
    expect(t.api.texts().at(-1)).toContain('🔕 до');

    await send(t, callback(`unmute:${ALICE}`, keyboard));
    expect(t.watches.watchers(ALICE)).toHaveLength(1);
    expect(t.api.calls.at(-1)?.payload.text).toBe(
      'Alice: уведомления снова включены',
    );
  });

  it('answers mute buttons of addresses the chat no longer watches', async () => {
    const t = await start();
    await send(t, callback(`mute:${ALICE}`, []));
    expect(t.api.calls.at(-1)).toMatchObject({
      method: 'answerCallbackQuery',
      payload: { text: 'Чат больше не следит за этим адресом.' },
    });
  });

  it('lets only group admins change the watch list', async () => {
    const t = await start({
      respond: (call) =>
        call.method === 'getChatMember'
          ? {
              status: call.payload.user_id === 30 ? 'administrator' : 'member',
              user: { id: call.payload.user_id },
            }
          : true,
    });
    const group = { chatId: -5, chatType: 'group' as const };

    await send(t, message(`/watch ${ALICE}`, { ...group, userId: 20 }));
    expect(t.api.texts().at(-1)).toBe('Эта команда вам недоступна.');
    await send(t, callback(`mute:${ALICE}`, [], { ...group, userId: 20 }));
    expect(t.api.calls.at(-1)?.payload.text).toBe(
      'Это могут сделать только админы чата.',
    );

    await send(t, message(`/watch ${ALICE}`, { ...group, userId: 30 }));
    expect(await t.watches.list(-5)).toHaveLength(1);
    await send(
      t,
      callback(`mute:${ALICE}`, [], { ...group, userId: ADMIN_ID }),
    );
    expect(t.watches.watchers(ALICE)).toEqual([]);
  });
});

describe('chat changes', () => {
  it('checks channel subscribers who press the mute button', async () => {
    const t = await start({
      respond: (call) =>
        call.method === 'getChatMember'
          ? { status: 'member', user: { id: call.payload.user_id } }
          : true,
    });
    await t.watches.add(-7, ALICE);
    const update = callback(`mute:${ALICE}`, [], { chatId: -7 });
    update.callback_query!.message!.chat = {
      id: -7,
      type: 'channel',
      title: 'C',
    };
    await send(t, update);
    expect(t.api.calls.at(-1)?.payload.text).toBe(
      'Это могут сделать только админы чата.',
    );
    expect(t.watches.watchers(ALICE)).toHaveLength(1);
  });

  it('follows a group that became a supergroup', async () => {
    let migrated = false;
    const t = await start({
      respond: (call) => {
        if (call.method === 'sendMessage' && call.payload.chat_id === -1) {
          migrated = true;
          throw new GrammyError(
            'migrated',
            {
              ok: false,
              error_code: 400,
              description:
                'Bad Request: group chat was upgraded to a supergroup chat',
              parameters: { migrate_to_chat_id: -1001 },
            },
            'sendMessage',
            {},
          );
        }
        return true;
      },
    });
    await t.watches.add(-1, ALICE);
    await mine(t, [tx(1, { from: ALICE, value: 1n })]);
    expect(migrated).toBe(true);
    expect(t.watches.watchers(ALICE).map((w) => w.chatId)).toEqual([-1001]);
  });
});

describe('watch commands', () => {
  it('explains the arguments', async () => {
    const t = await start();
    await send(t, message('/watch'));
    expect(t.api.texts().at(-1)).toContain('Пришлите адрес или ENS-имя');
    await send(t, message('/watch 0x123'));
    expect(t.api.texts().at(-1)).toContain('Это не похоже на адрес');
    await send(t, message('/unwatch'));
    expect(t.api.texts().at(-1)).toContain('Укажите адрес или метку');
  });

  it('resolves ENS names and uses them as labels', async () => {
    const t = await start({
      resolveName: async (name) => (name === 'vitalik.eth' ? ALICE : null),
    });
    await send(t, message('/watch Vitalik.eth'));
    expect(t.api.texts().at(-1)).toContain('Слежу за <b>vitalik.eth</b>');
    expect(await t.watches.list(10)).toEqual([
      { address: ALICE, label: 'vitalik.eth' },
    ]);

    await send(t, message('/watch nobody.eth'));
    expect(t.api.texts().at(-1)).toBe(
      'ENS-имя nobody.eth ни на что не указывает.',
    );
  });

  it('reports ENS failures', async () => {
    const t = await start({
      resolveName: async () => {
        throw new Error('rpc down');
      },
    });
    await send(t, message('/watch vitalik.eth'));
    expect(t.api.texts().at(-1)).toBe(
      'Не удалось разрешить vitalik.eth, попробуйте позже.',
    );
  });

  it('says when ENS is unavailable', async () => {
    const t = await start();
    await send(t, message('/watch vitalik.eth'));
    expect(t.api.texts().at(-1)).toContain('ENS-имена недоступны');
  });

  it('lists, relabels, limits and removes addresses', async () => {
    const t = await start({ config: testConfig({ maxWatchesPerChat: 1 }) });
    await send(t, message('/list'));
    expect(t.api.texts().at(-1)).toContain('Чат пока ни за кем не следит');

    await send(t, message(`/watch ${ALICE}`));
    await send(t, message(`/watch ${ALICE} Main wallet`));
    expect(t.api.texts().at(-1)).toContain(
      'Метка обновлена: <b>Main wallet</b>',
    );
    await send(t, message(`/watch ${BOB}`));
    expect(t.api.texts().at(-1)).toContain('максимум адресов');

    await send(t, message('/list'));
    expect(t.api.texts().at(-1)).toContain('<b>Адреса чата</b> (1)');
    expect(t.api.texts().at(-1)).toContain('<b>Main wallet</b>');

    await send(t, message('/unwatch main wallet'));
    expect(t.api.texts().at(-1)).toBe('Больше не слежу за <b>Main wallet</b>.');
    await send(t, message('/unwatch main wallet'));
    expect(t.api.texts().at(-1)).toContain('Такого адреса нет в списке');
  });
});

describe('block messages', () => {
  it('posts new messages to subscribed chats once', async () => {
    const t = await start();
    await send(t, message('/messages'));
    expect(t.api.texts().at(-1)).toContain('выключены');
    await send(t, message('/messages on'));
    await send(t, message('/messages'));
    expect(t.api.texts().at(-1)).toContain('включены');
    t.api.clear();

    const block = await mine(t, [
      tx(1, { input: textInput('Hello <world> from Alice') }),
      tx(2, { input: '0xa9059cbb0000000000000000' }),
    ]);
    expect(t.api.texts()).toHaveLength(1);
    expect(t.api.texts()[0]).toContain(
      '<blockquote expandable>Hello &lt;world&gt; from Alice</blockquote>',
    );

    // A repeated block (e.g. after a crash) does not post the message again
    t.api.clear();
    await t.stores.checkpoints.set('ethereum', block - 1);
    const again = await buildTestApp({ stores: t.stores, chain: t.chain });
    await again.scanner.tick();
    expect(again.api.texts()).toEqual([]);
    await again.app.close();

    await send(t, message('/messages off'));
    expect(t.api.texts().at(-1)).toBe('Сообщения из транзакций выключены.');
  });

  it('posts a mass mailing of one text once', async () => {
    const t = await start();
    await send(t, message('/messages on'));
    t.api.clear();

    const spam = textInput('Claim your reward at example dot com');
    await mine(t, [
      tx(1, { from: ALICE, to: BOB, input: spam }),
      tx(2, { from: ALICE, to: CAROL, input: spam }),
      tx(3, { from: BOB, to: CAROL, input: spam }),
    ]);
    const texts = t.api.texts();
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain('→ 2 адресам');
    expect(texts[1]).not.toContain('адресам');
    // every transaction stays available in the API
    expect((await t.stores.messages.recent(10)).length).toBe(3);
  });

  it('summarises a block full of messages', async () => {
    const t = await start();
    await send(t, message('/messages on'));
    t.api.clear();
    await mine(
      t,
      Array.from({ length: 8 }, (_, i) =>
        tx(i, {
          from: `0x${String(i + 1).repeat(40)}`,
          input: textInput(`Hello number ${i} friend`),
        }),
      ),
    );
    const texts = t.api.texts();
    expect(texts).toHaveLength(6);
    expect(texts[5]).toContain('…и ещё 3 сообщений в блоке 101');
  });

  it('serves recent messages over HTTP', async () => {
    const t = await start();
    await mine(t, [
      tx(1, { from: ALICE, to: BOB, input: textInput('First message here') }),
    ]);
    await mine(t, [
      tx(2, { from: ALICE, to: null, input: textInput('Second message here') }),
    ]);

    const response = await t.app.inject({ url: '/v1/messages?limit=1' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      messages: [
        {
          chain: 'ethereum',
          blockNumber: 102,
          hash: tx(2).hash,
          from: ALICE,
          to: null,
          text: 'Second message here',
          timestamp: 1_700_000_102,
          url: `https://etherscan.io/tx/${tx(2).hash}`,
        },
      ],
    });
    expect(
      (await t.app.inject({ url: '/v1/messages?limit=500' })).statusCode,
    ).toBe(400);
  });

  it('hides /messages when no chain is searched', async () => {
    const t = await start({ config: testConfig({ messagesChains: [] }) });
    await send(t, message('/messages on'));
    expect(t.api.sent()).toEqual([]);
  });
});

describe('status and health', () => {
  it('shows the chat and the chains', async () => {
    const t = await start();
    await send(t, message(`/watch ${ALICE}`));
    await send(t, message('/status'));
    const text = t.api.texts().at(-1);
    expect(text).toContain('Адресов: 1');
    expect(text).toContain('Сообщения из транзакций: выключены');
    expect(text).toContain('🟢 Ethereum: блок 100');
  });

  it('shows statistics to bot admins only', async () => {
    const t = await start();
    await send(t, message(`/watch ${ALICE}`, { chatId: 1 }));
    await send(t, message('/messages on', { chatId: 2 }));
    await send(t, message('/stats', { userId: ADMIN_ID }));
    expect(t.api.texts().at(-1)).toContain('Чатов с адресами: 1');
    expect(t.api.texts().at(-1)).toContain('Чатов с сообщениями: 1');

    await send(t, message('/stats'));
    expect(t.api.texts().at(-1)).toBe('Эта команда вам недоступна.');
  });

  it('reports scanner state in /health', async () => {
    const t = await start();
    expect((await t.app.inject({ url: '/health' })).json()).toEqual({
      status: 'ok',
      chains: [
        {
          chain: 'ethereum',
          head: 100,
          lastBlock: 100,
          lag: 0,
          error: null,
          stopped: false,
        },
      ],
      telegram: {
        ok: true,
        mode: 'none',
        username: 'watch_bot',
        polling: null,
        webhook: null,
        store: 'ok',
        queue: 0,
      },
    });
  });

  it('serves Prometheus metrics of the scanner, notifications and Telegram', async () => {
    const t = await start();
    await send(t, message(`/watch ${ALICE}`));
    t.chain.addBlock(101, [tx(1, { from: ALICE, to: BOB, value: 1n })]);
    t.chain.setHead(101);
    await t.scanner.tick();

    const response = await t.app.inject({ url: '/metrics' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    const text = response.body;
    expect(text).toContain('eth_watch_head_block{chain="ethereum"} 101');
    expect(text).toContain('eth_watch_lag_blocks{chain="ethereum"} 0');
    expect(text).toContain('eth_watch_scanner_up{chain="ethereum"} 1');
    expect(text).toContain(
      'eth_watch_notifications_total{chain="ethereum",importance="outgoing"} 1',
    );
    expect(text).toContain(
      'tg_commands_total{command="watch",allowed="true"} 1',
    );
    expect(text).toContain('process_cpu_user_seconds_total');
  });

  it('counts messages found in blocks', async () => {
    const t = await start();
    t.chain.addBlock(101, [
      tx(1, { input: textInput('Hello from the chain') }),
    ]);
    t.chain.setHead(101);
    await t.scanner.tick();
    expect((await t.app.inject({ url: '/metrics' })).body).toContain(
      'eth_watch_block_messages_total{chain="ethereum"} 1',
    );
  });

  it('marks RPC problems as degraded', async () => {
    const chain = fakeChain(10);
    current = await buildTestApp({ chain });
    await current.scanner.tick();
    await send(current, message('/status'));
    expect(current.api.texts().at(-1)).toContain(
      '🔴 Ethereum: RPC returns chain id 10, expected 1',
    );
    expect((await current.app.inject({ url: '/health' })).json()).toMatchObject(
      {
        status: 'degraded',
      },
    );
  });
});

describe('startup', () => {
  it('sets up the default channel of the old bots', async () => {
    const stores = memoryStores();
    await start({
      stores,
      config: testConfig({
        bootstrap: {
          chatId: -100,
          addresses: [ALICE.toLowerCase(), 'not-an-address', ALICE],
          messages: true,
        },
      }),
    });
    expect(await stores.chats.get(-100)).toEqual({
      chatId: -100,
      topics: ['messages'],
      settings: { watches: [{ address: ALICE }], seeded: [ALICE] },
    });
  });

  it('does not bring back a default address after /unwatch on restart', async () => {
    const stores = memoryStores();
    const bootstrap = (addresses: string[]) =>
      testConfig({ bootstrap: { chatId: -100, addresses, messages: false } });

    const first = await start({ stores, config: bootstrap([ALICE]) });
    await first.watches.remove(-100, ALICE);
    await first.app.close();

    // Restart with one more default: only the new one is added
    const second = await start({ stores, config: bootstrap([ALICE, BOB]) });
    expect(await second.watches.list(-100)).toEqual([{ address: BOB }]);
    expect(second.watches.watchers(ALICE)).toEqual([]);
  });

  it('logs notifications when there is no bot token', async () => {
    const t = await start({
      config: testConfig({ bot: { mode: 'polling', admins: [] } }),
    });
    await t.watches.add(1, ALICE);
    await send(t, message('/messages on'));
    await mine(t, [
      tx(1, { from: ALICE, value: 1n, input: textInput('hello there friend') }),
    ]);
    expect(t.api.sent()).toHaveLength(1); // only the /messages reply
  });
});
