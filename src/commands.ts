import { html, joinHtml } from '@dirai/tg-kit';
import type { FastifyInstance } from 'fastify';

import { CHAINS } from './chains.js';
import { formatBlock, replyHtml } from './format.js';
import { MESSAGES_TOPIC } from './messages/handler.js';
import type { BlockScanner, ScannerStatus } from './scanner/scanner.js';
import type { WatchService } from './watch/watch-service.js';

const chainLine = (status: ScannerStatus) => {
  const title = CHAINS[status.chain].title;
  if (status.stopped && status.error) return html`🔴 ${title}: ${status.error}`;
  if (status.error) return html`🟠 ${title}: ошибка RPC, повторяю`;
  if (status.lastBlock === null) return html`⚪ ${title}: запускается`;
  return html`🟢 ${title}: блок ${formatBlock(status.lastBlock)}${
    status.lag ? html`, отставание ${status.lag}` : ''
  }`;
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
      description: 'Сообщения из транзакций: /messages on или off',
      scope: 'chatAdmin',
      handler: async (ctx) => {
        const chatId = ctx.chat!.id;
        const arg = String(ctx.match ?? '')
          .trim()
          .toLowerCase();
        if (arg === 'on') {
          await app.subscriptions.subscribe(chatId, [MESSAGES_TOPIC]);
          return replyHtml(
            ctx,
            html`✉️ Буду присылать текстовые сообщения, которые люди пишут в транзакциях.`,
          );
        }
        if (arg === 'off') {
          await app.subscriptions.unsubscribe(chatId, [MESSAGES_TOPIC]);
          return replyHtml(ctx, html`Сообщения из транзакций выключены.`);
        }
        const on = await isSubscribed(chatId);
        return replyHtml(
          ctx,
          html`Сообщения из транзакций ${on ? 'включены' : 'выключены'}.\n<code>/messages ${on ? 'off' : 'on'}</code> — ${on ? 'выключить' : 'включить'}`,
        );
      },
    });
  }

  app.tg.command({
    command: 'status',
    description: 'Что отслеживает чат и как работают сети',
    handler: async (ctx) => {
      const chatId = ctx.chat!.id;
      const list = await watches.list(chatId);
      return replyHtml(
        ctx,
        joinHtml([
          html`<b>Этот чат</b>`,
          html`Адресов: ${list.length}${list.length ? '' : ' · добавить: /watch'}`,
          messagesEnabled &&
            html`Сообщения из транзакций: ${(await isSubscribed(chatId)) ? 'включены' : 'выключены'}`,
          '',
          html`<b>Сети</b>`,
          ...scanners.map((scanner) => chainLine(scanner.status())),
        ]),
      );
    },
  });

  app.tg.command({
    command: 'stats',
    description: 'Статистика бота',
    scope: 'admin',
    handler: async (ctx) => {
      const { addresses, chats } = watches.stats();
      const messageChats = await app.subscriptions.listByTopic(MESSAGES_TOPIC);
      return replyHtml(
        ctx,
        joinHtml([
          html`<b>Статистика</b>`,
          html`Чатов с адресами: ${chats}`,
          html`Уникальных адресов: ${addresses}`,
          messagesEnabled && html`Чатов с сообщениями: ${messageChats.length}`,
          ...scanners.map((scanner) => chainLine(scanner.status())),
        ]),
      );
    },
  });
};
