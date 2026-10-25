import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import {
  tgBot,
  tgNotifier,
  tgSubscriptions,
  type Html,
  type TgBotOptions,
  type TgNotifierOptions,
} from '@dirai/tg-kit';
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';

import { CHAINS, type ChainName } from './chains.js';
import { registerCommands } from './commands.js';
import type { Config } from './config.js';
import { registerRoutes } from './http.js';
import { blockMessagesHandler, MESSAGES_TOPIC } from './messages/handler.js';
import { BlockScanner } from './scanner/scanner.js';
import type { ChainReader } from './scanner/types.js';
import type { Stores } from './storage.js';
import { registerWatchCommands, type ResolveName } from './watch/commands.js';
import { addressWatchHandler, type Deliver } from './watch/handler.js';
import { normalizeAddress, WatchService } from './watch/watch-service.js';

export type AppOptions = {
  config: Config;
  stores: Stores;
  readers: Partial<Record<ChainName, ChainReader>>;
  resolveName?: ResolveName;
  logger?: FastifyServerOptions['logger'];
  /** Overrides for tests: a fake Telegram API, botInfo, mode `none` */
  bot?: Partial<TgBotOptions>;
  notifier?: TgNotifierOptions;
  /** Starts the scanners on ready (default true); tests drive them with tick() */
  startScanners?: boolean;
};

const START_TEXT = (chains: string) =>
  [
    `Привет! Я слежу за адресами в ${chains} и сообщаю о переводах ETH и токенов.`,
    '',
    'Добавить адрес: /watch 0x… или /watch vitalik.eth',
    'Все команды: /help',
  ].join('\n');

export const buildApp = async (options: AppOptions) => {
  const { config, stores } = options;
  const app = Fastify({
    logger: options.logger ?? { level: config.logLevel },
    // Trust X-Forwarded-For only from the configured number of proxy hops
    trustProxy:
      config.trustProxy === false
        ? false
        : (_address: string, hop: number) => hop < Number(config.trustProxy),
  });

  const telegram = Boolean(config.bot.token);
  if (!telegram) {
    app.log.warn('BOT_TOKEN is not set: notifications are logged, not sent');
  }

  await app.register(rateLimit, { global: false });
  if (config.corsOrigins.length) {
    await app.register(cors, { origin: config.corsOrigins, methods: ['GET'] });
  }

  const chainTitles = config.chains
    .map(({ name }) => CHAINS[name].title)
    .join(', ');
  await app.register(tgBot, {
    token: config.bot.token ?? 'disabled',
    mode: telegram ? config.bot.mode : 'none',
    webhook: config.bot.webhook,
    admins: config.bot.admins,
    texts: { start: START_TEXT(chainTitles) },
    ...options.bot,
  });
  // The kit's /subscribe and /unsubscribe are replaced by /messages: without a topic
  // /unsubscribe would delete the chat together with its addresses
  await app.register(tgSubscriptions, {
    store: stores.chats,
    topics: [MESSAGES_TOPIC],
    commands: false,
  });
  await app.register(tgNotifier, options.notifier ?? {});

  const deliver: Deliver = async (chatId, message, sendOptions) => {
    if (!telegram) {
      app.log.info({ chatId, message: message.value }, 'notification');
      return true;
    }
    const sent = await app.notifier.send(chatId, message, sendOptions);
    // Another chat id means the group became a supergroup: the caller reloads its index
    return sent !== null && sent.chatId === chatId;
  };
  const broadcast = async (message: Html) => {
    if (!telegram) {
      app.log.info({ message: message.value }, 'message broadcast');
      return;
    }
    try {
      await app.notifier.notify(MESSAGES_TOPIC, message);
    } catch (error) {
      // The message is stored already; a retry of the block would not post it again
      app.log.error({ err: error }, 'message broadcast failed');
    }
  };

  const watches = new WatchService(stores.chats, {
    maxPerChat: config.maxWatchesPerChat,
  });
  await watches.load();

  // Messages go first: they are stored once, so a block repeated after a failure of the
  // address handler does not post them again
  const handlers = [
    blockMessagesHandler({
      chains: config.messagesChains,
      store: stores.messages,
      broadcast,
    }),
    addressWatchHandler({ watches, deliver }),
  ];

  const scanners = config.chains.flatMap((chain) => {
    const reader = options.readers[chain.name];
    if (!reader) return [];
    return [
      new BlockScanner({
        chain: chain.name,
        chainId: CHAINS[chain.name].viem.id,
        reader,
        checkpoints: stores.checkpoints,
        handlers,
        confirmations: chain.confirmations,
        maxBlocksPerTick: config.maxBlocksPerTick,
        maxLagBlocks: config.maxLagBlocks,
        log: app.log,
      }),
    ];
  });

  registerWatchCommands(app, {
    watches,
    resolveName: options.resolveName,
    defaultChain: config.chains[0]!.name,
  });
  registerCommands(app, {
    watches,
    scanners,
    messagesEnabled: config.messagesChains.length > 0,
  });
  registerRoutes(app, { scanners, messages: stores.messages });

  app.addHook('onReady', async () => {
    await bootstrapChat(app, watches, config.bootstrap);
    if (options.startScanners === false) return;
    for (const scanner of scanners) scanner.start(config.pollIntervalMs);
  });
  app.addHook('onClose', async () => {
    await Promise.all(scanners.map((scanner) => scanner.close()));
  });

  return { app, watches, scanners };
};

/** Sets up the chat from DEFAULT_CHANNEL_ID, keeping the setup of the old bots working */
const bootstrapChat = async (
  app: FastifyInstance,
  watches: WatchService,
  bootstrap: Config['bootstrap'],
) => {
  const { chatId } = bootstrap;
  if (chatId === undefined) return;

  for (const input of bootstrap.addresses) {
    const address = normalizeAddress(input);
    if (!address) {
      app.log.warn(
        { address: input },
        'DEFAULT_ADDRESSES: not an address, skipped',
      );
      continue;
    }
    const existing = await watches.list(chatId);
    if (existing.some((watch) => watch.address === address)) continue;
    await watches.add(chatId, address);
  }
  if (bootstrap.messages) {
    await app.subscriptions.subscribe(chatId, [MESSAGES_TOPIC]);
  }
};
