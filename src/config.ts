import { CHAIN_NAMES, CHAINS, isChainName, type ChainName } from './chains.js';

export type ChainConfig = {
  name: ChainName;
  rpcUrl: string;
  confirmations: number;
};

export type Config = {
  port: number;
  host: string;
  logLevel: string;
  /** Number of proxy hops in front of the app, for client IPs in rate limits */
  trustProxy: number | false;
  corsOrigins: string[];
  bot: {
    /** Without a token the bot runs without Telegram and only logs notifications */
    token?: string;
    mode: 'polling' | 'webhook';
    webhook?: { url: string; secretToken: string };
    admins: number[];
  };
  mongoUri?: string;
  chains: ChainConfig[];
  /** Chains whose transactions are searched for text messages */
  messagesChains: ChainName[];
  pollIntervalMs: number;
  /** Upper bound of blocks one scanner tick processes while catching up */
  maxBlocksPerTick: number;
  /** A scanner further behind than this skips to the recent blocks */
  maxLagBlocks: number;
  maxWatchesPerChat: number;
  /** Look up unknown method names in the public signature database */
  signatureLookup: boolean;
  /** Show USD amounts, with prices from DefiLlama */
  prices: boolean;
  /** Optional chat set up on start, e.g. the channel of the old bots */
  bootstrap: {
    chatId?: number;
    addresses: string[];
    messages: boolean;
  };
};

type Env = Record<string, string | undefined>;

export class ConfigError extends Error {}

const text = (env: Env, key: string) => {
  const value = env[key]?.trim();
  return value ? value : undefined;
};

const integer = (
  env: Env,
  key: string,
  fallback: number,
  { min = 0 }: { min?: number } = {},
) => {
  const value = text(env, key);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new ConfigError(
      `${key} must be an integer >= ${min}, got "${value}"`,
    );
  }
  return parsed;
};

const list = (env: Env, key: string) =>
  (text(env, key) ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const chatId = (value: string, key: string) => {
  if (!/^-?\d+$/.test(value)) {
    throw new ConfigError(
      `${key} must be a numeric Telegram id, got "${value}"`,
    );
  }
  return Number(value);
};

const boolean = (env: Env, key: string, fallback: boolean) => {
  const value = text(env, key)?.toLowerCase();
  if (value === undefined) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new ConfigError(`${key} must be true or false, got "${value}"`);
};

export const loadConfig = (env: Env): Config => {
  const chains = CHAIN_NAMES.flatMap((name): ChainConfig[] => {
    const upper = name.toUpperCase();
    // RPC_URL is the old single-chain name for Ethereum
    const rpcUrl =
      text(env, `RPC_URL_${upper}`) ??
      (name === 'ethereum' ? text(env, 'RPC_URL') : undefined);
    if (!rpcUrl) return [];
    return [
      {
        name,
        rpcUrl,
        confirmations: integer(
          env,
          `CONFIRMATIONS_${upper}`,
          CHAINS[name].confirmations,
        ),
      },
    ];
  });
  if (!chains.length) {
    throw new ConfigError(
      `Set an RPC URL for at least one chain: ${CHAIN_NAMES.map((name) => `RPC_URL_${name.toUpperCase()}`).join(', ')}`,
    );
  }

  const enabled = new Set(chains.map((chain) => chain.name));
  const messagesChains = (
    text(env, 'MESSAGES_CHAINS') === undefined
      ? ['ethereum']
      : list(env, 'MESSAGES_CHAINS')
  ).map((name) => {
    if (!isChainName(name)) {
      throw new ConfigError(
        `MESSAGES_CHAINS: unknown chain "${name}", use ${CHAIN_NAMES.join(', ')}`,
      );
    }
    return name;
  });

  const token = text(env, 'BOT_TOKEN');
  const mode = text(env, 'BOT_MODE') ?? 'polling';
  if (mode !== 'polling' && mode !== 'webhook') {
    throw new ConfigError(`BOT_MODE must be polling or webhook, got "${mode}"`);
  }
  const webhookUrl = text(env, 'BOT_WEBHOOK_URL');
  const webhookSecret = text(env, 'BOT_WEBHOOK_SECRET');
  if (token && mode === 'webhook' && (!webhookUrl || !webhookSecret)) {
    throw new ConfigError(
      'BOT_MODE=webhook needs BOT_WEBHOOK_URL and BOT_WEBHOOK_SECRET',
    );
  }

  const trustProxy = integer(env, 'TRUST_PROXY', 0);
  const bootstrapChat = text(env, 'DEFAULT_CHANNEL_ID');

  return {
    port: integer(env, 'PORT', 3000),
    host: text(env, 'HOST') ?? '0.0.0.0',
    logLevel: text(env, 'LOG_LEVEL') ?? 'info',
    trustProxy: trustProxy > 0 ? trustProxy : false,
    corsOrigins: list(env, 'CORS_ORIGINS'),
    bot: {
      token,
      mode,
      webhook:
        mode === 'webhook' && webhookUrl && webhookSecret
          ? { url: webhookUrl, secretToken: webhookSecret }
          : undefined,
      admins: list(env, 'BOT_ADMINS').map((id) => chatId(id, 'BOT_ADMINS')),
    },
    mongoUri: text(env, 'MONGO_URI'),
    chains,
    messagesChains: messagesChains.filter((name) => enabled.has(name)),
    pollIntervalMs: integer(env, 'POLL_INTERVAL_MS', 4000, { min: 500 }),
    maxBlocksPerTick: integer(env, 'MAX_BLOCKS_PER_TICK', 50, { min: 1 }),
    maxLagBlocks: integer(env, 'MAX_LAG_BLOCKS', 1000, { min: 1 }),
    maxWatchesPerChat: integer(env, 'MAX_WATCHES_PER_CHAT', 20, { min: 1 }),
    signatureLookup: boolean(env, 'SIGNATURE_LOOKUP', true),
    prices: boolean(env, 'PRICES', true),
    bootstrap: {
      chatId: bootstrapChat
        ? chatId(bootstrapChat, 'DEFAULT_CHANNEL_ID')
        : undefined,
      addresses: list(env, 'DEFAULT_ADDRESSES'),
      messages: boolean(env, 'DEFAULT_CHANNEL_MESSAGES', false),
    },
  };
};
