import { memoryStore } from '@dirai-kit/tg';
import { describe, expect, it } from 'vitest';

import { normalizeAddress, WatchService } from '../src/watch/watch-service.js';
import { ALICE, BOB } from './helpers.js';

const setup = (maxPerChat = 20) => {
  let now = 1_000;
  const store = memoryStore();
  const watches = new WatchService(store, { maxPerChat, now: () => now });
  return {
    store,
    watches,
    setNow: (value: number) => {
      now = value;
    },
  };
};

describe('normalizeAddress', () => {
  it('checksums any letter case and rejects garbage', () => {
    expect(normalizeAddress(ALICE.toLowerCase())).toBe(ALICE);
    expect(normalizeAddress(ALICE.toUpperCase().replace('0X', '0x'))).toBe(
      ALICE,
    );
    expect(normalizeAddress('0x123')).toBeNull();
    expect(normalizeAddress('vitalik.eth')).toBeNull();
  });
});

describe('WatchService', () => {
  it('finds watchers regardless of letter case', async () => {
    const { watches } = setup();
    await watches.add(1, ALICE, 'Alice');
    expect(watches.watchers(ALICE.toLowerCase())).toEqual([
      { chatId: 1, watch: { address: ALICE, label: 'Alice' } },
    ]);
    expect(watches.watchers(BOB)).toEqual([]);
  });

  it('reports every chat that watches an address', async () => {
    const { watches } = setup();
    await watches.add(1, ALICE);
    await watches.add(2, ALICE, 'Vitalik');
    expect(watches.watchers(ALICE).map((w) => w.chatId)).toEqual([1, 2]);
    expect(watches.stats()).toEqual({ addresses: 1, chats: 2 });
  });

  it('updates the label of an address already watched', async () => {
    const { watches } = setup();
    await watches.add(1, ALICE);
    expect(await watches.add(1, ALICE, 'Alice')).toEqual({
      status: 'updated',
      watch: { address: ALICE, label: 'Alice' },
    });
    expect(await watches.list(1)).toHaveLength(1);
  });

  it('keeps the per-chat limit', async () => {
    const { watches } = setup(1);
    await watches.add(1, ALICE);
    expect(await watches.add(1, BOB)).toEqual({ status: 'limit' });
  });

  it('removes by address or label', async () => {
    const { watches } = setup();
    await watches.add(1, ALICE, 'Alice');
    await watches.add(1, BOB);
    expect((await watches.remove(1, 'alice'))?.address).toBe(ALICE);
    expect((await watches.remove(1, BOB.toLowerCase()))?.address).toBe(BOB);
    expect(await watches.remove(1, BOB)).toBeNull();
    expect(watches.hasWatches()).toBe(false);
  });

  it('skips muted addresses until the mute ends', async () => {
    const { watches, setNow } = setup();
    await watches.add(1, ALICE);
    await watches.mute(1, ALICE, 5_000);
    expect(watches.watchers(ALICE)).toEqual([]);
    setNow(5_000);
    expect(watches.watchers(ALICE)).toHaveLength(1);

    await watches.mute(1, ALICE, 9_000);
    expect(await watches.mute(1, ALICE, null)).toEqual({ address: ALICE });
    expect(await watches.mute(1, BOB, null)).toBeNull();
  });

  it('keeps the chat topics when saving addresses', async () => {
    const { store, watches } = setup();
    await store.save(1, { topics: ['messages'], settings: { other: true } });
    await watches.add(1, ALICE);
    expect(await store.get(1)).toEqual({
      chatId: 1,
      topics: ['messages'],
      settings: { other: true, watches: [{ address: ALICE }] },
    });
  });

  it('does not lose additions made at the same time', async () => {
    const { watches } = setup();
    await Promise.all([watches.add(1, ALICE), watches.add(1, BOB)]);
    expect((await watches.list(1)).map((w) => w.address)).toEqual([ALICE, BOB]);
  });

  it('continues after a failed change', async () => {
    const { store, watches } = setup();
    const save = store.save;
    store.save = async () => {
      throw new Error('db down');
    };
    await expect(watches.add(1, ALICE)).rejects.toThrow('db down');
    store.save = save;
    expect((await watches.add(1, ALICE)).status).toBe('added');
  });

  it('reloads the index from the store', async () => {
    const { store, watches } = setup();
    await watches.add(1, ALICE);
    await store.remove(1);
    expect(watches.hasWatches()).toBe(true);
    await watches.load();
    expect(watches.hasWatches()).toBe(false);
  });

  it('seeds each default address once, so an unwatched one stays removed', async () => {
    const { store, watches } = setup();
    expect(await watches.seed(1, [ALICE])).toEqual([ALICE]);
    await watches.remove(1, ALICE);

    // A restart: a new service over the same store seeds again, with a new default
    const restarted = new WatchService(store, { maxPerChat: 20 });
    await restarted.load();
    expect(await restarted.seed(1, [ALICE, BOB])).toEqual([BOB]);
    expect(await restarted.list(1)).toEqual([{ address: BOB }]);
    expect(restarted.isWatched(ALICE)).toBe(false);
    expect(await restarted.seed(1, [ALICE, BOB])).toEqual([]);
  });

  it('marks an address already watched as seeded without adding it twice', async () => {
    const { watches } = setup();
    await watches.add(1, ALICE, 'Alice');
    expect(await watches.seed(1, [ALICE])).toEqual([]);
    expect(await watches.list(1)).toEqual([{ address: ALICE, label: 'Alice' }]);
    await watches.remove(1, ALICE);
    expect(await watches.seed(1, [ALICE])).toEqual([]);
  });

  it('leaves a default over the limit unseeded for the next start', async () => {
    const { watches } = setup(1);
    expect(await watches.seed(1, [ALICE, BOB])).toEqual([ALICE]);
    await watches.remove(1, ALICE);
    expect(await watches.seed(1, [ALICE, BOB])).toEqual([BOB]);
  });
});
