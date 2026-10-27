import { html, joinHtml } from '@dirai-kit/tg';
import type { FastifyInstance } from 'fastify';

import { CHAINS } from './chains.js';
import { formatBlock, replyHtml } from './format.js';
import { t, translations } from './i18n/index.js';
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

const MB = 1024 * 1024;

/** "3 ч 12 мин" */
const uptimeText = (seconds: number) => {
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  return t.uptime(days, hours % 24, minutes % 60);
};

/** /messages, /status and the admin /stats and /health */
export const registerCommands = (
  app: FastifyInstance,
  {
    watches,
    scanners,
    messagesEnabled,
    ping,
    totals,
  }: {
    watches: WatchService;
    scanners: BlockScanner[];
    /** False when no chain is searched for messages */
    messagesEnabled: boolean;
    /** Database check; absent when everything is kept in memory */
    ping?: () => Promise<boolean>;
    /** Notifications and block messages since the start */
    totals: () => {
      sent: Record<'alert' | 'outgoing' | 'incoming', number>;
      found: number;
    };
  },
) => {
  const isSubscribed = async (chatId: number) =>
    (await app.subscriptions.store.get(chatId))?.topics.includes(
      MESSAGES_TOPIC,
    ) ?? false;

  if (messagesEnabled) {
    app.tg.command({
      command: 'messages',
      description: translations((texts) => texts.messagesCommand),
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
    description: translations((texts) => texts.statusCommand),
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
    command: 'health',
    description: translations((texts) => texts.healthCommand),
    scope: 'admin',
    handler: async (ctx) => {
      const started = performance.now();
      const database = !ping
        ? t.healthDbMemory
        : (await ping())
          ? t.healthDb(Math.round(performance.now() - started))
          : t.healthDbDown;
      const telegram = await app.tgHealth.check();
      const { sent, found } = totals();
      return replyHtml(
        ctx,
        joinHtml([
          t.healthTitle,
          t.healthProcess(
            uptimeText(process.uptime()),
            Math.round(process.memoryUsage().rss / MB),
          ),
          database,
          t.healthTelegram(telegram.ok, telegram.mode, telegram.queue),
          '',
          t.statusChains,
          ...scanners.map((scanner) => {
            const status = scanner.status();
            return status.rpc
              ? html`${chainLine(status)} · ${status.rpc}`
              : chainLine(status);
          }),
          '',
          t.healthSent(sent.alert, sent.outgoing, sent.incoming),
          messagesEnabled && t.healthFound(found),
        ]),
      );
    },
  });

  app.tg.command({
    command: 'stats',
    description: translations((texts) => texts.statsCommand),
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
