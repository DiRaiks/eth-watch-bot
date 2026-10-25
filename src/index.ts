import pg from 'pg';
import { createPublicClient, type PublicClient } from 'viem';
import { normalize } from 'viem/ens';

import { buildApp } from './app.js';
import { CHAINS, type ChainName } from './chains.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { checkRpcs, rpcTransport } from './rpc.js';
import type { ChainReader } from './scanner/types.js';
import { viemReader } from './scanner/viem-reader.js';
import { memoryStores, pgStores } from './storage.js';

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
if (process.env.NODE_ENV === 'production' && !config.databaseUrl) {
  console.error('Configuration error: DATABASE_URL is required in production');
  process.exit(1);
}

// RPCs of another network are left out of a list; reported once the logger exists
const rpcWarnings: { chain: ChainName; host: string; chainId: number }[] = [];
const clients: Partial<Record<ChainName, PublicClient>> = {};
const readers: Partial<Record<ChainName, ChainReader>> = {};
for (const chain of config.chains) {
  const viemChain = CHAINS[chain.name].viem;
  let urls = chain.rpcUrls;
  if (urls.length > 1) {
    const { usable, wrong } = await checkRpcs(urls, viemChain.id);
    rpcWarnings.push(...wrong.map((rpc) => ({ chain: chain.name, ...rpc })));
    // All of another network: keep them, the scanner stops with a clear error
    if (usable.length) urls = usable;
  }
  const rpc = rpcTransport(urls);
  const client = createPublicClient({
    chain: viemChain,
    transport: rpc.transport,
  }) as PublicClient;
  rpc.watch(client.transport);
  clients[chain.name] = client;
  readers[chain.name] = viemReader(client, rpc.current);
}

const db = config.databaseUrl
  ? new pg.Pool({ connectionString: config.databaseUrl, max: 5 })
  : null;
const stores = db ? await pgStores(db) : memoryStores();

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

for (const { chain, host, chainId } of rpcWarnings) {
  app.log.error(
    { chain, rpc: host, chainId },
    'RPC serves another network, left out',
  );
}

// A dropped idle connection: the pool reconnects; without a listener it would crash
db?.on('error', (error) =>
  app.log.error({ err: error }, 'database connection lost'),
);

if (!db) {
  app.log.warn(
    'DATABASE_URL is not set: chats and progress are kept in memory',
  );
}

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  // Docker kills the container after 10 s anyway; exit cleanly before that
  setTimeout(() => process.exit(1), 8000).unref();
  try {
    await app.close();
    await db?.end();
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, 'shutdown failed');
    process.exit(1);
  }
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.port, host: config.host });
