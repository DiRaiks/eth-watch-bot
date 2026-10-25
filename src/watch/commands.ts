import { html, joinHtml } from '@dirai/tg-kit';
import type { FastifyInstance } from 'fastify';
import type { Context } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import type { Address } from 'viem';

import { addressLink, formatTime, replyHtml, truncate } from '../format.js';
import type { ChainName } from '../chains.js';
import { MUTE_HOURS, watchLabel } from './handler.js';
import { normalizeAddress, type WatchService } from './watch-service.js';

export type ResolveName = (name: string) => Promise<Address | null>;

const MAX_LABEL = 32;

/**
 * Who may press the mute buttons: anyone in a private chat, bot admins, and admins of the
 * group or channel. Unlike channel posts, button presses carry the user, so channel
 * subscribers are checked too.
 */
const canManage = async (ctx: Context, admins: (id?: number) => boolean) => {
  const chat = ctx.chat;
  if (!chat) return false;
  if (chat.type === 'private') return true;
  if (admins(ctx.from?.id)) return true;
  if (!ctx.from) return false;
  try {
    const member = await ctx.api.getChatMember(chat.id, ctx.from.id);
    return member.status === 'creator' || member.status === 'administrator';
  } catch {
    return false;
  }
};

export const registerWatchCommands = (
  app: FastifyInstance,
  {
    watches,
    resolveName,
    defaultChain,
  }: {
    watches: WatchService;
    resolveName?: ResolveName;
    /** Chain used for explorer links in /list */
    defaultChain: ChainName;
  },
) => {
  const resolve = async (
    input: string,
  ): Promise<{ address: Address; ens?: string } | { error: string }> => {
    const address = normalizeAddress(input);
    if (address) return { address };
    if (!input.includes('.'))
      return {
        error: 'Это не похоже на адрес: нужен 0x… из 40 символов или ENS-имя.',
      };
    if (!resolveName)
      return { error: 'ENS-имена недоступны: боту не задан RPC Ethereum.' };
    const name = input.toLowerCase();
    try {
      const resolved = await resolveName(name);
      return resolved
        ? { address: resolved, ens: name }
        : { error: `ENS-имя ${input} ни на что не указывает.` };
    } catch {
      return { error: `Не удалось разрешить ${input}, попробуйте позже.` };
    }
  };

  app.tg.command({
    command: 'watch',
    description: 'Следить за адресом: /watch 0x… [метка]',
    scope: 'chatAdmin',
    handler: async (ctx) => {
      const [input, ...labelWords] = String(ctx.match ?? '')
        .trim()
        .split(/\s+/);
      if (!input) {
        return replyHtml(
          ctx,
          html`Пришлите адрес или ENS-имя и, если хотите, метку:\n<code>/watch 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 Виталик</code>\n<code>/watch vitalik.eth</code>`,
        );
      }
      const resolved = await resolve(input);
      if ('error' in resolved) return replyHtml(ctx, html`${resolved.error}`);

      const label = truncate(
        labelWords.join(' ') || resolved.ens || '',
        MAX_LABEL,
      );
      const result = await watches.add(
        ctx.chat!.id,
        resolved.address,
        label || undefined,
      );
      if (result.status === 'limit') {
        return replyHtml(
          ctx,
          html`В чате уже максимум адресов. Уберите лишние: /unwatch`,
        );
      }
      const name = html`<b>${watchLabel(result.watch)}</b> (${addressLink(defaultChain, result.watch.address)})`;
      return replyHtml(
        ctx,
        result.status === 'added'
          ? html`👀 Слежу за ${name}. Сообщу о переводах ETH и токенов и о вызовах контрактов.`
          : html`✏️ Метка обновлена: ${name}`,
      );
    },
  });

  app.tg.command({
    command: 'unwatch',
    description: 'Перестать следить: /unwatch 0x… или метка',
    scope: 'chatAdmin',
    handler: async (ctx) => {
      const input = String(ctx.match ?? '').trim();
      if (!input)
        return replyHtml(
          ctx,
          html`Укажите адрес или метку: <code>/unwatch 0x…</code>`,
        );
      const removed = await watches.remove(ctx.chat!.id, input);
      return replyHtml(
        ctx,
        removed
          ? html`Больше не слежу за <b>${watchLabel(removed)}</b>.`
          : html`Такого адреса нет в списке. Посмотреть список: /list`,
      );
    },
  });

  app.tg.command({
    command: 'list',
    description: 'Адреса, за которыми следит чат',
    handler: async (ctx) => {
      const list = await watches.list(ctx.chat!.id);
      if (!list.length) {
        return replyHtml(
          ctx,
          html`Чат пока ни за кем не следит. Добавить адрес: /watch 0x…`,
        );
      }
      const now = Date.now();
      return replyHtml(
        ctx,
        joinHtml([
          html`<b>Адреса чата</b> (${list.length})`,
          ...list.map(
            (watch) =>
              html`• ${watch.label ? html`<b>${watch.label}</b> ` : ''}${addressLink(defaultChain, watch.address)}${
                watch.mutedUntil && watch.mutedUntil > now
                  ? html` · 🔕 до ${formatTime(watch.mutedUntil)}`
                  : ''
              }`,
          ),
        ]),
      );
    },
  });

  const toggleButton = (
    markup: InlineKeyboardButton[][] | undefined,
    from: string,
    to: InlineKeyboardButton,
  ) =>
    markup?.map((row) =>
      row.map((button) =>
        'callback_data' in button && button.callback_data === from
          ? to
          : button,
      ),
    );

  app.tg.bot.callbackQuery(
    /^(mute|unmute):(0x[0-9a-fA-F]{40})$/,
    async (ctx) => {
      const [, action, raw] = ctx.match;
      const address = normalizeAddress(raw!)!;
      if (!(await canManage(ctx, app.tg.isAdmin))) {
        return ctx.answerCallbackQuery({
          text: 'Это могут сделать только админы чата.',
        });
      }
      const until =
        action === 'mute' ? Date.now() + MUTE_HOURS * 3_600_000 : null;
      const watch = await watches.mute(ctx.chat!.id, address, until);
      if (!watch) {
        return ctx.answerCallbackQuery({
          text: 'Чат больше не следит за этим адресом.',
        });
      }

      const label = watchLabel(watch);
      const next: InlineKeyboardButton =
        until === null
          ? {
              text: `🔕 Заглушить на ${MUTE_HOURS} ч`,
              callback_data: `mute:${address}`,
            }
          : { text: `🔔 Вернуть ${label}`, callback_data: `unmute:${address}` };
      const keyboard = toggleButton(
        ctx.callbackQuery.message?.reply_markup?.inline_keyboard,
        ctx.callbackQuery.data,
        next,
      );
      if (keyboard) {
        await ctx
          .editMessageReplyMarkup({
            reply_markup: { inline_keyboard: keyboard },
          })
          .catch(() => undefined);
      }
      return ctx.answerCallbackQuery({
        text:
          until === null
            ? `${label}: уведомления снова включены`
            : `${label}: тишина до ${formatTime(until)}`,
      });
    },
  );
};
