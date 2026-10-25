import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_PREFS, readPrefs } from '../src/watch/prefs.js';
import { ALICE, BOB, buildTestApp, callback, message, tx } from './helpers.js';

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

  it('reads only known languages from storage', () => {
    expect(readPrefs({ prefs: { language: 'en' } }).language).toBe('en');
    expect(readPrefs({ prefs: { language: 'de' } }).language).toBeUndefined();
    expect(DEFAULT_PREFS.language).toBeUndefined();
  });
});
