import { memoryStore, mongoStore, type SubscriptionStore } from '@dirai/tg-kit';
import type { Db } from 'mongodb';

import type { ChainName } from './chains.js';
import type { BlockMessage, MessageStore } from './messages/handler.js';
import type { CheckpointStore } from './scanner/types.js';

export type Stores = {
  chats: SubscriptionStore;
  checkpoints: CheckpointStore;
  messages: MessageStore;
};

/** Messages older than this are dropped from MongoDB */
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
});

type CheckpointDocument = { chain: ChainName; block: number; updatedAt: Date };
type MessageDocument = BlockMessage & { createdAt: Date };

export const mongoStores = async (db: Db): Promise<Stores> => {
  const chats = db.collection('chats');
  const checkpoints = db.collection<CheckpointDocument>('checkpoints');
  const messages = db.collection<MessageDocument>('messages');

  await Promise.all([
    chats.createIndex({ chatId: 1 }, { unique: true }),
    chats.createIndex({ 'settings.watches.address': 1 }),
    checkpoints.createIndex({ chain: 1 }, { unique: true }),
    messages.createIndex({ chain: 1, hash: 1 }, { unique: true }),
    messages.createIndex({ timestamp: -1 }),
    messages.createIndex(
      { createdAt: 1 },
      { expireAfterSeconds: MESSAGES_TTL_DAYS * 86_400 },
    ),
  ]);

  return {
    chats: mongoStore(chats),
    checkpoints: {
      async get(chain) {
        return (await checkpoints.findOne({ chain }))?.block ?? null;
      },
      async set(chain, block) {
        await checkpoints.updateOne(
          { chain },
          { $set: { block, updatedAt: new Date() } },
          { upsert: true },
        );
      },
    },
    messages: {
      async add(message) {
        const result = await messages.updateOne(
          { chain: message.chain, hash: message.hash },
          { $setOnInsert: { ...message, createdAt: new Date() } },
          { upsert: true },
        );
        return result.upsertedCount === 1;
      },
      async recent(limit) {
        const docs = await messages
          .find({}, { projection: { _id: 0, createdAt: 0 } })
          .sort({ timestamp: -1, blockNumber: -1 })
          .limit(limit)
          .toArray();
        return docs as BlockMessage[];
      },
    },
  };
};
