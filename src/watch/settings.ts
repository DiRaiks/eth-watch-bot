import { html, joinHtml, type Html } from '@dirai/tg-kit';
import type { FastifyInstance } from 'fastify';
import { InlineKeyboard, type Context } from 'grammy';

import { CHAINS, isChainName, type ChainName } from '../chains.js';
import { replyHtml } from '../format.js';
import { canManage } from './commands.js';
import {
  formatTimeZone,
  QUIET_PRESETS,
  THRESHOLDS,
  TIME_ZONES,
  type ChatPrefs,
} from './prefs.js';
import type { DigestService } from './digest.js';
import type { WatchService } from './watch-service.js';

const pad = (hour: number) => String(hour).padStart(2, '0');
const quietText = (quiet: ChatPrefs['quiet']) =>
  quiet ? `${pad(quiet.from)}:00–${pad(quiet.to)}:00` : 'выкл';
const mark = (on: boolean, text: string) => (on ? `• ${text}` : text);

export const settingsText = (prefs: ChatPrefs, chains: ChainName[]): Html =>
  joinHtml([
    html`⚙️ <b>Настройки уведомлений</b>`,
    html`Сети: ${
      chains
        .filter((c) => !prefs.mutedChains.includes(c))
        .map((c) => CHAINS[c].title)
        .join(', ') || 'ни одной'
    }`,
    html`Порог для входящих: ${prefs.minIncomingUsd ? `от $${prefs.minIncomingUsd}` : 'все'}`,
    html`Тихие часы: ${quietText(prefs.quiet)} (${formatTimeZone(prefs.timeZone)}), уведомления без звука`,
    html`Спам: ${prefs.spam === 'hide' ? 'скрывать' : 'показывать с пометкой'}`,
    html`Режим: ${
      prefs.mode === 'digest'
        ? `входящие — сводкой в ${pad(prefs.digestHour)}:00`
        : 'каждая транзакция'
    }`,
    '',
    html`<i>Исходящие переводы, разрешения на токены и списания не вами приходят всегда, со звуком и без порога.</i>`,
  ]);

export const settingsKeyboard = (prefs: ChatPrefs, chains: ChainName[]) => {
  const keyboard = new InlineKeyboard();
  if (chains.length > 1) {
    for (const chain of chains) {
      const on = !prefs.mutedChains.includes(chain);
      keyboard.text(
        `${on ? '✅' : '▫️'} ${CHAINS[chain].title}`,
        `set:chain:${chain}`,
      );
    }
    keyboard.row();
  }
  for (const threshold of THRESHOLDS) {
    keyboard.text(
      mark(
        prefs.minIncomingUsd === threshold,
        threshold ? `от $${threshold}` : 'Все входящие',
      ),
      `set:min:${threshold}`,
    );
  }
  keyboard.row();
  keyboard.text(mark(prefs.quiet === null, 'Без тихих часов'), 'set:quiet:off');
  for (const preset of QUIET_PRESETS) {
    const on =
      prefs.quiet?.from === preset.from && prefs.quiet.to === preset.to;
    keyboard.text(
      mark(on, `🌙 ${quietText(preset)}`),
      `set:quiet:${preset.from}-${preset.to}`,
    );
  }
  keyboard.row();
  keyboard
    .text('◀', 'set:tz:prev')
    .text(`🕒 ${formatTimeZone(prefs.timeZone)}`, 'set:noop')
    .text('▶', 'set:tz:next')
    .row();
  keyboard
    .text(mark(prefs.spam === 'show', 'Спам с пометкой'), 'set:spam:show')
    .text(mark(prefs.spam === 'hide', 'Скрывать спам'), 'set:spam:hide')
    .row();
  keyboard
    .text(mark(prefs.mode === 'each', 'Каждая транзакция'), 'set:mode:each')
    .text(
      mark(prefs.mode === 'digest', `Сводка в ${pad(prefs.digestHour)}:00`),
      'set:mode:digest',
    );
  return keyboard;
};

/** Applies a button press; null for unknown or stale buttons */
export const applySetting = (
  prefs: ChatPrefs,
  data: string,
  chains: ChainName[],
): Partial<ChatPrefs> | null => {
  const [, key, value = ''] = data.split(':');
  switch (key) {
    case 'chain': {
      if (!isChainName(value) || !chains.includes(value)) return null;
      const muted = prefs.mutedChains.includes(value);
      return {
        mutedChains: muted
          ? prefs.mutedChains.filter((chain) => chain !== value)
          : [...prefs.mutedChains, value],
      };
    }
    case 'min': {
      const threshold = Number(value);
      return (THRESHOLDS as readonly number[]).includes(threshold)
        ? { minIncomingUsd: threshold }
        : null;
    }
    case 'quiet': {
      if (value === 'off') return { quiet: null };
      const preset = QUIET_PRESETS.find((p) => `${p.from}-${p.to}` === value);
      return preset ? { quiet: { ...preset } } : null;
    }
    case 'tz': {
      if (value !== 'prev' && value !== 'next') return null;
      const zones: readonly string[] = TIME_ZONES;
      const index = Math.max(0, zones.indexOf(prefs.timeZone));
      const step = value === 'next' ? 1 : zones.length - 1;
      return { timeZone: zones[(index + step) % zones.length]! };
    }
    case 'spam':
      return value === 'show' || value === 'hide' ? { spam: value } : null;
    case 'mode':
      return value === 'each' || value === 'digest' ? { mode: value } : null;
    default:
      return null;
  }
};

export const registerSettings = (
  app: FastifyInstance,
  {
    watches,
    chains,
    digest,
  }: {
    watches: WatchService;
    chains: ChainName[];
    /** Pending digest entries are dropped when the chat switches back to every message */
    digest?: DigestService;
  },
) => {
  const render = (prefs: ChatPrefs) => ({
    text: settingsText(prefs, chains),
    keyboard: settingsKeyboard(prefs, chains),
  });

  app.tg.command({
    command: 'settings',
    description: 'Настройки уведомлений: сети, порог, тихие часы, сводка',
    scope: 'chatAdmin',
    handler: (ctx) => {
      const { text, keyboard } = render(watches.prefs(ctx.chat!.id));
      return replyHtml(ctx, text, { reply_markup: keyboard });
    },
  });

  app.tg.bot.callbackQuery(/^set:/, async (ctx: Context) => {
    const data = ctx.callbackQuery?.data ?? '';
    if (data === 'set:noop') return ctx.answerCallbackQuery();
    if (!(await canManage(ctx, app.tg.isAdmin))) {
      return ctx.answerCallbackQuery({
        text: 'Это могут сделать только админы чата.',
      });
    }
    const chatId = ctx.chat!.id;
    const { prefs, changed } = await watches.setPrefs(chatId, (current) =>
      applySetting(current, data, chains),
    );
    if (!changed) return ctx.answerCallbackQuery();
    if (prefs.mode === 'each') await digest?.discard(chatId);

    const { text, keyboard } = render(prefs);
    await ctx
      .editMessageText(text.value, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
        link_preview_options: { is_disabled: true },
      })
      .catch(() => undefined);
    return ctx.answerCallbackQuery({ text: 'Сохранено' });
  });
};
