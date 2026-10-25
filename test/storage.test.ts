import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { BlockMessage } from '../src/messages/handler.js';
import { memoryMessages, mongoStores, type Stores } from '../src/storage.js';
import { ALICE, BOB, txHash } from './helpers.js';

const msg = (n: number, fields: Partial<BlockMessage> = {}): BlockMessage => ({
  chain: 'ethereum',
  blockNumber: n,
  hash: txHash(n),
  from: ALICE,
  to: BOB,
  text: `message ${n}`,
  timestamp: 1_700_000_000 + n,
  ...fields,
});

let server: MongoMemoryServer;
let client: MongoClient;
let stores: Stores;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = await MongoClient.connect(server.getUri());
  stores = await mongoStores(client.db('eth-watch-test'));
}, 120_000);

afterAll(async () => {
  await client?.close();
  await server?.stop();
});

describe('mongo stores', () => {
  it('saves checkpoints per chain', async () => {
    expect(await stores.checkpoints.get('ethereum')).toBeNull();
    await stores.checkpoints.set('ethereum', 10);
    await stores.checkpoints.set('ethereum', 11);
    await stores.checkpoints.set('base', 5);
    expect(await stores.checkpoints.get('ethereum')).toBe(11);
    expect(await stores.checkpoints.get('base')).toBe(5);
  });

  it('stores each message once and returns the newest first', async () => {
    expect(await stores.messages.add(msg(1))).toBe(true);
    expect(await stores.messages.add(msg(2))).toBe(true);
    expect(await stores.messages.add(msg(1))).toBe(false);
    // the same hash on another chain is another message
    expect(await stores.messages.add(msg(1, { chain: 'base' }))).toBe(true);

    const recent = await stores.messages.recent(2);
    expect(recent).toEqual([msg(2), msg(1)]);
  });

  it('keeps digest entries until taken, and the last digest day', async () => {
    const entry = {
      address: ALICE,
      chain: 'ethereum' as const,
      hash: txHash(1),
      at: 1,
    };
    expect(await stores.digests.take(3)).toEqual([]);
    await stores.digests.add(3, entry);
    await stores.digests.add(3, { ...entry, hash: txHash(2), usd: 5 });
    expect(await stores.digests.take(3)).toEqual([
      entry,
      { ...entry, hash: txHash(2), usd: 5 },
    ]);
    expect(await stores.digests.take(3)).toEqual([]);

    expect(await stores.digests.lastSent(3)).toBeNull();
    await stores.digests.markSent(3, '2026-10-25');
    expect(await stores.digests.lastSent(3)).toBe('2026-10-25');
  });

  it('keeps chats with their watches', async () => {
    await stores.chats.save(7, { settings: { watches: [{ address: ALICE }] } });
    expect(await stores.chats.list()).toEqual([
      { chatId: 7, topics: [], settings: { watches: [{ address: ALICE }] } },
    ]);
  });
});

describe('memory messages', () => {
  it('keeps the newest 200 messages without duplicates', async () => {
    const store = memoryMessages();
    for (let n = 1; n <= 210; n += 1) await store.add(msg(n));
    expect(await store.add(msg(210))).toBe(false);
    const recent = await store.recent(500);
    expect(recent).toHaveLength(200);
    expect(recent[0]?.blockNumber).toBe(210);
  });
});
