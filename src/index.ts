import { MongoClient } from 'mongodb';
import { createPublicClient, http, type PublicClient } from 'viem';
import { normalize } from 'viem/ens';

import { buildApp } from './app.js';
import { CHAINS, type ChainName } from './chains.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import type { ChainReader } from './scanner/types.js';
import { viemReader } from './scanner/viem-reader.js';
import { memoryStores, mongoStores } from './storage.js';

const readConfig = (): Config => {
  try {
    return loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`Configuration error: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
};

const config = readConfig();

// In memory a restart forgets every chat and where scanning stopped
if (process.env.NODE_ENV === 'production' && !config.mongoUri) {
  console.error('Configuration error: MONGO_URI is required in production');
  process.exit(1);
}

const clients = Object.fromEntries(
  config.chains.map((chain) => [
    chain.name,
    createPublicClient({
      chain: CHAINS[chain.name].viem,
      transport: http(chain.rpcUrl, { retryCount: 2, timeout: 20_000 }),
    }) as PublicClient,
  ]),
) as Partial<Record<ChainName, PublicClient>>;

const readers = Object.fromEntries(
  Object.entries(clients).map(([name, client]) => [name, viemReader(client)]),
) as Partial<Record<ChainName, ChainReader>>;

const mongo = config.mongoUri ? new MongoClient(config.mongoUri) : null;
const stores = mongo ? await mongoStores(mongo.db()) : memoryStores();

const ethereum = clients.ethereum;
const { app } = await buildApp({
  config,
  stores,
  readers,
  resolveName: ethereum
    ? (name) => ethereum.getEnsAddress({ name: normalize(name) })
    : undefined,
  logger: {
    level: config.logLevel,
    transport:
      process.env.NODE_ENV === 'production'
        ? undefined
        : { target: 'pino-pretty' },
  },
});

if (!mongo) {
  app.log.warn('MONGO_URI is not set: chats and progress are kept in memory');
}

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  // Docker kills the container after 10 s anyway; exit cleanly before that
  setTimeout(() => process.exit(1), 8000).unref();
  try {
    await app.close();
    await mongo?.close();
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, 'shutdown failed');
    process.exit(1);
  }
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.port, host: config.host });
