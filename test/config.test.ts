import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../src/config.js';

const base = { RPC_URL_ETHEREUM: 'https://eth.example' };

describe('loadConfig', () => {
  it('uses defaults for a minimal setup', () => {
    const config = loadConfig(base);
    expect(config).toMatchObject({
      port: 3000,
      host: '0.0.0.0',
      trustProxy: false,
      corsOrigins: [],
      bot: { token: undefined, mode: 'polling', admins: [] },
      chains: [
        {
          name: 'ethereum',
          rpcUrls: ['https://eth.example'],
          confirmations: 3,
        },
      ],
      messagesChains: ['ethereum'],
      pollIntervalMs: 4000,
      maxBlocksPerTick: 50,
      maxLagBlocks: 1000,
      maxWatchesPerChat: 20,
      bootstrap: { addresses: [], messages: false },
      language: 'en',
    });
  });

  it('speaks the language from LANGUAGE', () => {
    expect(loadConfig({ ...base, LANGUAGE: 'RU' }).language).toBe('ru');
    expect(loadConfig({ ...base, LANGUAGE: 'en' }).language).toBe('en');
  });

  it('accepts the old single RPC_URL for Ethereum', () => {
    expect(loadConfig({ RPC_URL: 'https://old' }).chains).toEqual([
      { name: 'ethereum', rpcUrls: ['https://old'], confirmations: 3 },
    ]);
  });

  it('takes several RPC URLs of a chain, in order', () => {
    expect(
      loadConfig({
        RPC_URL_ETHEREUM: ' https://a.example/key , https://b.example ,',
      }).chains[0]?.rpcUrls,
    ).toEqual(['https://a.example/key', 'https://b.example']);
    expect(
      loadConfig({ RPC_URL: 'https://old1,https://old2' }).chains[0]?.rpcUrls,
    ).toEqual(['https://old1', 'https://old2']);
  });

  it('refuses an RPC that is not an http(s) URL', () => {
    expect(() =>
      loadConfig({ RPC_URL_ETHEREUM: 'https://a.example wss://b.example' }),
    ).toThrow(ConfigError);
    expect(() => loadConfig({ RPC_URL_BASE: 'base.example' })).toThrow(
      /RPC_URL_BASE: "base.example" is not an http\(s\) URL/,
    );
  });

  it('enables every chain with an RPC URL and reads per-chain confirmations', () => {
    const config = loadConfig({
      ...base,
      RPC_URL_BASE: 'https://base.example',
      CONFIRMATIONS_BASE: '2',
      MESSAGES_CHAINS: 'ethereum, base, optimism',
    });
    expect(config.chains.map((c) => [c.name, c.confirmations])).toEqual([
      ['ethereum', 3],
      ['base', 2],
    ]);
    // optimism has no RPC URL, so it is dropped
    expect(config.messagesChains).toEqual(['ethereum', 'base']);
  });

  it('can switch messages off', () => {
    expect(
      loadConfig({ ...base, MESSAGES_CHAINS: ' ' }).messagesChains,
    ).toEqual(['ethereum']);
    expect(
      loadConfig({ ...base, MESSAGES_CHAINS: ',' }).messagesChains,
    ).toEqual([]);
  });

  it('reads bot, proxy, CORS and bootstrap settings', () => {
    const config = loadConfig({
      ...base,
      BOT_TOKEN: 'token',
      BOT_MODE: 'webhook',
      BOT_WEBHOOK_URL: 'https://bot.example',
      BOT_WEBHOOK_SECRET: 'secret',
      BOT_ADMINS: '1, 2',
      TRUST_PROXY: '1',
      CORS_ORIGINS: 'https://a.example,https://b.example',
      DEFAULT_CHANNEL_ID: '-100123',
      DEFAULT_ADDRESSES: '0xabc,0xdef',
      DEFAULT_CHANNEL_MESSAGES: 'yes',
      MONGO_URI: 'mongodb://localhost/eth',
    });
    expect(config.bot).toEqual({
      token: 'token',
      mode: 'webhook',
      webhook: { url: 'https://bot.example', secretToken: 'secret' },
      admins: [1, 2],
    });
    expect(config.trustProxy).toBe(1);
    expect(config.corsOrigins).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
    expect(config.bootstrap).toEqual({
      chatId: -100123,
      addresses: ['0xabc', '0xdef'],
      messages: true,
    });
    expect(config.mongoUri).toBe('mongodb://localhost/eth');
  });

  it.each([
    [{}, /at least one chain/],
    [{ ...base, MESSAGES_CHAINS: 'solana' }, /unknown chain "solana"/],
    [{ ...base, BOT_MODE: 'push' }, /BOT_MODE/],
    [{ ...base, BOT_TOKEN: 't', BOT_MODE: 'webhook' }, /BOT_WEBHOOK_URL/],
    [{ ...base, PORT: 'abc' }, /PORT must be an integer/],
    [
      { ...base, POLL_INTERVAL_MS: '10' },
      /POLL_INTERVAL_MS must be an integer >= 500/,
    ],
    [{ ...base, BOT_ADMINS: 'me' }, /BOT_ADMINS must be a numeric/],
    [{ ...base, LANGUAGE: 'de' }, /LANGUAGE must be en or ru/],
    [
      { ...base, DEFAULT_CHANNEL_MESSAGES: 'maybe' },
      /DEFAULT_CHANNEL_MESSAGES/,
    ],
  ])('rejects invalid settings %#', (env, error) => {
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(error);
  });
});
