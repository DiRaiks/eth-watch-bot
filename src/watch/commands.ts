import { html, joinHtml } from '@dirai/tg-kit';
import type { FastifyInstance } from 'fastify';
import type { Context } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import type { Address } from 'viem';

import { addressLink, formatTime, replyHtml, truncate } from '../format.js';
import type { ChainName } from '../chains.js';
import { t } from '../i18n/index.js';
import { MUTE_HOURS, watchLabel } from './handler.js';
import { normalizeAddress, type WatchService } from './watch-service.js';

export type ResolveName = (name: string) => Promise<Address | null>;

const MAX_LABEL = 32;

/**
 * Who may press the mute buttons: anyone in a private chat, bot admins, and admins of the
 * group or channel. Unlike channel posts, button presses carry the user, so channel
 * subscribers are checked too.
 */
export const canManage = async (
  ctx: Context,
  admins: (id?: number) => boolean,
) => {
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
    if (!input.includes('.')) return { error: t.notAnAddress };
    if (!resolveName) return { error: t.ensUnavailable };
    const name = input.toLowerCase();
    try {
      const resolved = await resolveName(name);
      return resolved
        ? { address: resolved, ens: name }
        : { error: t.ensEmpty(input) };
    } catch {
      return { error: t.ensFailed(input) };
    }
  };

  app.tg.command({
    command: 'watch',
    description: t.watchCommand,
    scope: 'chatAdmin',
    handler: async (ctx) => {
      const [input, ...labelWords] = String(ctx.match ?? '')
        .trim()
        .split(/\s+/);
      if (!input) {
        return replyHtml(ctx, t.watchUsage);
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
        return replyHtml(ctx, t.watchLimit);
      }
      const name = html`<b>${watchLabel(result.watch)}</b> (${addressLink(defaultChain, result.watch.address)})`;
      return replyHtml(
        ctx,
        result.status === 'added' ? t.watchAdded(name) : t.watchRelabeled(name),
      );
    },
  });

  app.tg.command({
    command: 'unwatch',
    description: t.unwatchCommand,
    scope: 'chatAdmin',
    handler: async (ctx) => {
      const input = String(ctx.match ?? '').trim();
      if (!input) return replyHtml(ctx, t.unwatchUsage);
      const removed = await watches.remove(ctx.chat!.id, input);
      return replyHtml(
        ctx,
        removed ? t.unwatched(watchLabel(removed)) : t.unwatchMissing,
      );
    },
  });

  app.tg.command({
    command: 'list',
    description: t.listCommand,
    handler: async (ctx) => {
      const list = await watches.list(ctx.chat!.id);
      if (!list.length) {
        return replyHtml(ctx, t.listEmpty);
      }
      const now = Date.now();
      return replyHtml(
        ctx,
        joinHtml([
          t.listTitle(list.length),
          ...list.map(
            (watch) =>
              html`• ${watch.label ? html`<b>${watch.label}</b> ` : ''}${addressLink(defaultChain, watch.address)}${
                watch.mutedUntil && watch.mutedUntil > now
                  ? t.mutedUntil(formatTime(watch.mutedUntil))
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
        return ctx.answerCallbackQuery({ text: t.adminsOnly });
      }
      const until =
        action === 'mute' ? Date.now() + MUTE_HOURS * 3_600_000 : null;
      const watch = await watches.mute(ctx.chat!.id, address, until);
      if (!watch) {
        return ctx.answerCallbackQuery({ text: t.notWatched });
      }

      const label = watchLabel(watch);
      const next: InlineKeyboardButton =
        until === null
          ? { text: t.mute(MUTE_HOURS), callback_data: `mute:${address}` }
          : { text: t.unmute(label), callback_data: `unmute:${address}` };
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
          until === null ? t.unmuted(label) : t.muted(label, formatTime(until)),
      });
    },
  );
};
