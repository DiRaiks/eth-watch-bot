import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_PREFS, readPrefs } from '../src/watch/prefs.js';
import {
  ADMIN_ID,
  ALICE,
  BOB,
  buildTestApp,
  callback,
  message,
  textInput,
  tx,
} from './helpers.js';

type TestApp = Awaited<ReturnType<typeof buildTestApp>>;
let current: TestApp | undefined;

// The bot's default language in tests is Russian (LANGUAGE)
const start = async () => {
  current = await buildTestApp();
  current.chain.setHead(100);
  await current.scanner.tick();
  current.api.clear();
  return current;
};

const send = (t: TestApp, update: ReturnType<typeof message>) =>
  t.app.tg.bot.handleUpdate(update);

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

describe('language of a chat', () => {
  it("answers in the user's Telegram language and keeps it for alerts", async () => {
    const t = await start();
    await send(t, message('/status', { languageCode: 'en-GB' }));
    expect(t.api.texts().at(-1)).toContain('This chat');

    await send(t, message(`/watch ${ALICE} Alice`, { languageCode: 'en' }));
    expect(t.api.texts().at(-1)).toContain('Watching <b>Alice</b>');

    // Alerts have no user to ask: the language saved by /watch
    const alert = await mine(t, [
      tx(1, { from: ALICE, to: BOB, value: 10n ** 15n }),
    ]);
    expect(alert).toContain('⬆️ Sent');
    expect(alert).toContain('outgoing');
  });

  it('switches from /settings, at once in the same message', async () => {
    const t = await start();
    await send(t, message(`/watch ${ALICE} Alice`));
    await send(t, message('/settings'));
    const keyboard = t.api.sent().at(-1)?.payload.reply_markup as {
      inline_keyboard: { text: string; callback_data: string }[][];
    };
    const buttons = keyboard.inline_keyboard.flat().map((b) => b.text);
    expect(buttons).toEqual(
      expect.arrayContaining(['✅ 🇷🇺 Русский', '🇬🇧 English']),
    );

    t.api.clear();
    await send(t, callback('set:lang:en', keyboard.inline_keyboard));
    const edited = t.api.calls.find((c) => c.method === 'editMessageText');
    expect(String(edited?.payload.text)).toContain('Notification settings');
    expect(
      t.api.calls.find((c) => c.method === 'answerCallbackQuery')?.payload.text,
    ).toBe('Saved');

    const alert = await mine(t, [
      tx(1, { from: ALICE, to: BOB, value: 10n ** 15n }),
    ]);
    expect(alert).toContain('⬆️ Sent');

    // A chosen language wins over the user's Telegram one
    await send(t, message('/status', { languageCode: 'ru' }));
    expect(t.api.texts().at(-1)).toContain('This chat');
  });

  it('posts messages from transactions to each chat in its language', async () => {
    const t = await start();
    await send(t, message('/messages on', { chatId: 1 }));
    await send(t, message('/messages on', { chatId: 2 }));
    await send(t, message('/settings', { chatId: 2 }));
    const keyboard = t.api.sent().at(-1)?.payload.reply_markup as {
      inline_keyboard: { text: string; callback_data: string }[][];
    };
    await send(
      t,
      callback('set:lang:en', keyboard.inline_keyboard, { chatId: 2 }),
    );
    t.api.clear();

    await mine(t, [tx(1, { input: textInput('gm from the chain') })]);
    const byChat = new Map(
      t.api.sent().map((c) => [c.payload.chat_id, String(c.payload.text)]),
    );
    expect(byChat.get(1)).toContain('Сообщение в блоке');
    expect(byChat.get(2)).toContain('Message in block');
  });

  it('keeps a group on the default language whoever adds an address', async () => {
    const t = await start();
    await send(
      t,
      message(`/watch ${ALICE}`, {
        chatId: -5,
        chatType: 'group',
        languageCode: 'en',
        userId: ADMIN_ID,
      }),
    );
    const alert = await mine(t, [
      tx(1, { from: ALICE, to: BOB, value: 10n ** 15n }),
    ]);
    expect(alert).toContain('Отправлено');
  });

  it("shows /start, /help and the command menu in the chat's language", async () => {
    const t = await start();
    await send(t, message('/help', { languageCode: 'en' }));
    const help = String(t.api.texts().at(-1));
    expect(help.startsWith('Commands:\n')).toBe(true);
    expect(help).toContain('/help — List of commands');
    expect(help).toContain('/watch — Watch an address');

    await send(t, message('/help', { languageCode: 'de' }));
    expect(String(t.api.texts().at(-1))).toContain('/help — Список команд');

    // A language chosen in /settings wins over the user's Telegram one
    await send(t, message('/settings'));
    const keyboard = t.api.sent().at(-1)?.payload.reply_markup as {
      inline_keyboard: { text: string; callback_data: string }[][];
    };
    await send(t, callback('set:lang:en', keyboard.inline_keyboard));
    await send(t, message('/help', { languageCode: 'ru' }));
    expect(String(t.api.texts().at(-1))).toContain('/help — List of commands');

    const watch = t.app.tg.commands().find((c) => c.command === 'watch');
    expect(watch?.description).toMatchObject({
      default: 'Следить за адресом: /watch 0x… [метка]',
      en: 'Watch an address: /watch 0x… [label]',
      ru: 'Следить за адресом: /watch 0x… [метка]',
    });
  });

  it('reads only known languages from storage', () => {
    expect(readPrefs({ prefs: { language: 'en' } }).language).toBe('en');
    expect(readPrefs({ prefs: { language: 'de' } }).language).toBeUndefined();
    expect(DEFAULT_PREFS.language).toBeUndefined();
  });
});
