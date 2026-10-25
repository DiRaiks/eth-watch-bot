import {
  memoryStore,
  pgStore,
  type PgClientLike,
  type SubscriptionStore,
} from '@dirai/tg-kit';
import type { Address, Hash } from 'viem';

import type { ChainName } from './chains.js';
import type { BlockMessage, MessageStore } from './messages/handler.js';
import type { CheckpointStore } from './scanner/types.js';
import { memoryDigests, pgDigests, type DigestStore } from './watch/digest.js';

export type Stores = {
  chats: SubscriptionStore;
  checkpoints: CheckpointStore;
  messages: MessageStore;
  digests: DigestStore;
};

/** Messages older than this are deleted from the database */
const MESSAGES_TTL_DAYS = 90;
const MEMORY_MESSAGES = 200;

export const memoryCheckpoints = (): CheckpointStore => {
  const blocks = new Map<ChainName, number>();
  return {
    get: async (chain) => blocks.get(chain) ?? null,
    set: async (chain, block) => {
      blocks.set(chain, block);
    },
  };
};

export const memoryMessages = (): MessageStore => {
  const messages: BlockMessage[] = [];
  return {
    async add(message) {
      if (
        messages.some(
          (m) => m.chain === message.chain && m.hash === message.hash,
        )
      ) {
        return false;
      }
      messages.unshift(message);
      messages.length = Math.min(messages.length, MEMORY_MESSAGES);
      return true;
    },
    recent: async (limit) => messages.slice(0, limit),
  };
};

export const memoryStores = (): Stores => ({
  chats: memoryStore(),
  checkpoints: memoryCheckpoints(),
  messages: memoryMessages(),
  digests: memoryDigests(),
});

/** The subset of a Postgres client the stores use: a `pg` Pool, or PGlite in tests */
export type Sql = PgClientLike;

/** Messages are deleted at most this often, on the way of saving new ones */
const CLEANUP_INTERVAL_MS = 60 * 60_000;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS checkpoints (
    chain text PRIMARY KEY,
    block bigint NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    chain text NOT NULL,
    hash text NOT NULL,
    block_number bigint NOT NULL,
    from_address text NOT NULL,
    to_address text,
    text text NOT NULL,
    timestamp bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (chain, hash)
  )`,
  `CREATE INDEX IF NOT EXISTS messages_recent_idx
    ON messages (timestamp DESC, block_number DESC)`,
  `CREATE INDEX IF NOT EXISTS messages_created_idx ON messages (created_at)`,
];

type MessageRow = {
  chain: ChainName;
  hash: Hash;
  block_number: string | number;
  from_address: Address;
  to_address: Address | null;
  text: string;
  timestamp: string | number;
};

export const pgStores = async (sql: Sql): Promise<Stores> => {
  for (const statement of SCHEMA) await sql.query(statement);
  const digests = await pgDigests(sql);

  let cleanedAt = 0;
  const cleanup = async () => {
    if (Date.now() - cleanedAt < CLEANUP_INTERVAL_MS) return;
    cleanedAt = Date.now();
    await sql.query(
      `DELETE FROM messages WHERE created_at < now() - make_interval(days => $1)`,
      [MESSAGES_TTL_DAYS],
    );
  };

  return {
    chats: pgStore(sql, { table: 'chats' }),
    digests,
    checkpoints: {
      async get(chain) {
        const { rows } = await sql.query(
          'SELECT block FROM checkpoints WHERE chain = $1',
          [chain],
        );
        const row = rows[0] as { block: string | number } | undefined;
        return row ? Number(row.block) : null;
      },
      async set(chain, block) {
        await sql.query(
          `INSERT INTO checkpoints (chain, block) VALUES ($1, $2)
           ON CONFLICT (chain) DO UPDATE SET block = $2, updated_at = now()`,
          [chain, block],
        );
      },
    },
    messages: {
      async add(message) {
        await cleanup();
        const { rows } = await sql.query(
          `INSERT INTO messages
             (chain, hash, block_number, from_address, to_address, text, timestamp)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (chain, hash) DO NOTHING
           RETURNING hash`,
          [
            message.chain,
            message.hash,
            message.blockNumber,
            message.from,
            message.to,
            message.text,
            message.timestamp,
          ],
        );
        return rows.length === 1;
      },
      async recent(limit) {
        const { rows } = await sql.query(
          `SELECT chain, hash, block_number, from_address, to_address, text, timestamp
           FROM messages ORDER BY timestamp DESC, block_number DESC LIMIT $1`,
          [limit],
        );
        return (rows as MessageRow[]).map((row) => ({
          chain: row.chain,
          blockNumber: Number(row.block_number),
          hash: row.hash,
          from: row.from_address,
          to: row.to_address,
          text: row.text,
          timestamp: Number(row.timestamp),
        }));
      },
    },
  };
};
