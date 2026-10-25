import { html, joinHtml } from '@dirai/tg-kit';
import type { FastifyInstance } from 'fastify';

import { CHAINS } from './chains.js';
import { formatBlock, replyHtml } from './format.js';
import { t } from './i18n/index.js';
import { MESSAGES_TOPIC } from './messages/handler.js';
import type { BlockScanner, ScannerStatus } from './scanner/scanner.js';
import type { WatchService } from './watch/watch-service.js';

const chainLine = (status: ScannerStatus) => {
  const title = CHAINS[status.chain].title;
  if (status.stopped && status.error) return html`🔴 ${title}: ${status.error}`;
  if (status.error) return t.chainRetrying(title);
  if (status.lastBlock === null) return t.chainStarting(title);
  return t.chainAt(title, formatBlock(status.lastBlock), status.lag);
};

/** /messages, /status and the admin /stats */
export const registerCommands = (
  app: FastifyInstance,
  {
    watches,
    scanners,
    messagesEnabled,
  }: {
    watches: WatchService;
    scanners: BlockScanner[];
    /** False when no chain is searched for messages */
    messagesEnabled: boolean;
  },
) => {
  const isSubscribed = async (chatId: number) =>
    (await app.subscriptions.store.get(chatId))?.topics.includes(
      MESSAGES_TOPIC,
    ) ?? false;

  if (messagesEnabled) {
    app.tg.command({
      command: 'messages',
      description: t.messagesCommand,
      scope: 'chatAdmin',
      handler: async (ctx) => {
        const chatId = ctx.chat!.id;
        const arg = String(ctx.match ?? '')
          .trim()
          .toLowerCase();
        if (arg === 'on') {
          await app.subscriptions.subscribe(chatId, [MESSAGES_TOPIC]);
          return replyHtml(ctx, t.messagesOn);
        }
        if (arg === 'off') {
          await app.subscriptions.unsubscribe(chatId, [MESSAGES_TOPIC]);
          return replyHtml(ctx, t.messagesOff);
        }
        const on = await isSubscribed(chatId);
        return replyHtml(ctx, t.messagesState(on));
      },
    });
  }

  app.tg.command({
    command: 'status',
    description: t.statusCommand,
    handler: async (ctx) => {
      const chatId = ctx.chat!.id;
      const list = await watches.list(chatId);
      return replyHtml(
        ctx,
        joinHtml([
          t.statusChat,
          t.statusAddresses(list.length),
          messagesEnabled && t.statusMessages(await isSubscribed(chatId)),
          '',
          t.statusChains,
          ...scanners.map((scanner) => chainLine(scanner.status())),
        ]),
      );
    },
  });

  app.tg.command({
    command: 'stats',
    description: t.statsCommand,
    scope: 'admin',
    handler: async (ctx) => {
      const { addresses, chats } = watches.stats();
      const messageChats = await app.subscriptions.listByTopic(MESSAGES_TOPIC);
      return replyHtml(
        ctx,
        joinHtml([
          t.statsTitle,
          t.statsChats(chats),
          t.statsAddresses(addresses),
          messagesEnabled && t.statsMessageChats(messageChats.length),
          ...scanners.map((scanner) => chainLine(scanner.status())),
        ]),
      );
    },
  });
};
