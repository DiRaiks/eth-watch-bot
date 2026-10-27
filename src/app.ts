import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import {
  tgBot,
  tgHealth,
  tgNotifier,
  tgSubscriptions,
  type Html,
  type TgBotOptions,
  type TgNotifierOptions,
} from '@dirai-kit/tg';
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import type { Context } from 'grammy';

import { CHAINS, type ChainName } from './chains.js';
import { registerCommands } from './commands.js';
import type { Config } from './config.js';
import { registerRoutes } from './http.js';
import { createMetrics } from './metrics.js';
import {
  languageOf,
  setLanguage,
  translations,
  withLanguage,
} from './i18n/index.js';
import { blockMessagesHandler, MESSAGES_TOPIC } from './messages/handler.js';
import { priceLookup, type PriceLookup } from './enrich/prices.js';
import { signatureLookup, type SignatureLookup } from './enrich/signatures.js';
import { BlockScanner } from './scanner/scanner.js';
import type { ChainReader } from './scanner/types.js';
import type { Stores } from './storage.js';
import { registerWatchCommands, type ResolveName } from './watch/commands.js';
import { DigestService } from './watch/digest.js';
import { addressWatchHandler, type Deliver } from './watch/handler.js';
import { registerSettings } from './watch/settings.js';
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
  /** Method names; defaults to the built-in list plus the public database (SIGNATURE_LOOKUP) */
  methods?: SignatureLookup;
  /** USD prices; defaults to DefiLlama (PRICES), null turns them off */
  prices?: PriceLookup | null;
  /** Starts the scanners and the digest on ready (default true); tests drive them by hand */
  startScanners?: boolean;
  now?: () => number;
};

export const buildApp = async (options: AppOptions) => {
  const { config, stores } = options;
  setLanguage(config.language);
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

  const watches = new WatchService(stores.chats, {
    maxPerChat: config.maxWatchesPerChat,
    now: options.now,
  });
  await watches.load();

  // The chat's language: the one chosen in /settings, else the user's Telegram language
  const chatLanguage = (ctx: Context) =>
    (ctx.chat && watches.prefs(ctx.chat.id).language) ??
    languageOf(ctx.from?.language_code);

  const chainTitles = config.chains
    .map(({ name }) => CHAINS[name].title)
    .join(', ');
  await app.register(tgBot, {
    token: config.bot.token ?? 'disabled',
    mode: telegram ? config.bot.mode : 'none',
    webhook: config.bot.webhook,
    admins: config.bot.admins,
    texts: {
      start: translations((texts) => texts.start(chainTitles)),
      helpTitle: translations((texts) => texts.helpTitle),
      startDescription: translations((texts) => texts.startCommand),
      helpDescription: translations((texts) => texts.helpCommand),
      forbidden: translations((texts) => texts.forbidden),
    },
    language: chatLanguage,
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

  // One registry for the bot and the kit; /metrics and /health are the bot's own routes
  let scanners: BlockScanner[] = [];
  const metrics = createMetrics(() => scanners);
  await app.register(tgHealth, {
    registry: metrics.registry,
    healthPath: false,
    metricsPath: false,
  });

  const deliver: Deliver = async (chatId, message, sendOptions) => {
    if (!telegram) {
      app.log.info({ chatId, message: message.value }, 'notification');
      return true;
    }
    const sent = await app.notifier.send(chatId, message, sendOptions);
    // Another chat id means the group became a supergroup: the caller reloads its index
    return sent !== null && sent.chatId === chatId;
  };
  // Each subscribed chat in its own language: the text is built once per language
  const broadcast = async (format: () => Html) => {
    if (!telegram) {
      app.log.info({ message: format().value }, 'message broadcast');
      return;
    }
    try {
      const texts = new Map<string, Html>();
      const textFor = (chatId: number) => {
        const language = watches.prefs(chatId).language;
        let text = texts.get(language ?? '');
        if (!text) {
          text = withLanguage(language, format);
          texts.set(language ?? '', text);
        }
        return text;
      };
      const chats = await app.subscriptions.listByTopic(MESSAGES_TOPIC);
      // The notifier's queue keeps Telegram's limits; it also drops chats that blocked the bot
      await Promise.all(
        chats.map(({ chatId }) => app.notifier.send(chatId, textFor(chatId))),
      );
    } catch (error) {
      // The message is stored already; a retry of the block would not post it again
      app.log.error({ err: error }, 'message broadcast failed');
    }
  };

  // The bot's own replies in the chat's language; the kit's /start and /help take it
  // from `language` above. Before the bot's own commands, which come below.
  app.tg.bot.use((ctx, next) => withLanguage(chatLanguage(ctx), next));

  const defaultChain = config.chains[0]!.name;
  const digest = new DigestService({
    store: stores.digests,
    watches,
    deliver: (chatId, message) => deliver(chatId, message, { silent: true }),
    defaultChain,
    log: app.log,
    now: options.now,
  });

  // Messages go first: they are stored once, so a block repeated after a failure of the
  // address handler does not post them again
  const handlers = [
    blockMessagesHandler({
      chains: config.messagesChains,
      store: stores.messages,
      broadcast,
      onFound: metrics.messageFound,
    }),
    addressWatchHandler({
      watches,
      deliver,
      methods:
        options.methods ?? signatureLookup({ remote: config.signatureLookup }),
      prices:
        options.prices !== undefined
          ? options.prices
          : config.prices
            ? priceLookup()
            : null,
      digest,
      contacts: stores.contacts,
      log: app.log,
      onSent: metrics.notificationSent,
      now: options.now,
    }),
  ];

  scanners = config.chains.flatMap((chain) => {
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
    defaultChain,
  });
  registerSettings(app, {
    watches,
    chains: config.chains.map((chain) => chain.name),
    digest,
  });
  registerCommands(app, {
    watches,
    scanners,
    messagesEnabled: config.messagesChains.length > 0,
    ...(stores.ping && { ping: stores.ping }),
    totals: metrics.totals,
  });
  registerRoutes(app, {
    scanners,
    messages: stores.messages,
    metrics: metrics.registry,
    telegram,
  });

  app.addHook('onReady', async () => {
    await bootstrapChat(app, watches, config.bootstrap);
    if (options.startScanners === false) return;
    for (const scanner of scanners) scanner.start(config.pollIntervalMs);
    digest.start();
  });
  app.addHook('onClose', async () => {
    await Promise.all([
      ...scanners.map((scanner) => scanner.close()),
      digest.close(),
    ]);
  });

  return { app, watches, scanners, digest };
};

/** Sets up the chat from DEFAULT_CHANNEL_ID, keeping the setup of the old bots working */
const bootstrapChat = async (
  app: FastifyInstance,
  watches: WatchService,
  bootstrap: Config['bootstrap'],
) => {
  const { chatId } = bootstrap;
  if (chatId === undefined) return;

  const addresses = bootstrap.addresses.flatMap((input) => {
    const address = normalizeAddress(input);
    if (!address) {
      app.log.warn(
        { address: input },
        'DEFAULT_ADDRESSES: not an address, skipped',
      );
      return [];
    }
    return [address];
  });
  // Each address once per chat: an /unwatch is not undone by the next restart
  await watches.seed(chatId, addresses);
  if (bootstrap.messages) {
    await app.subscriptions.subscribe(chatId, [MESSAGES_TOPIC]);
  }
};
