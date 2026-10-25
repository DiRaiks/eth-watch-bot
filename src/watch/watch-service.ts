import type { SubscriptionStore } from '@dirai/tg-kit';
import { getAddress, isAddress, type Address } from 'viem';

export type Watch = {
  /** Checksummed */
  address: Address;
  label?: string;
  /** Unix ms; notifications for the address are skipped until then */
  mutedUntil?: number;
};

export type Watcher = { chatId: number; watch: Watch };

export type AddResult =
  { status: 'added' | 'updated'; watch: Watch } | { status: 'limit' };

/** Accepts any letter case; returns the checksummed address or null */
export const normalizeAddress = (value: string): Address | null =>
  isAddress(value, { strict: false }) ? getAddress(value) : null;

const key = (address: string) => address.toLowerCase();

const readWatches = (settings: Record<string, unknown>): Watch[] =>
  Array.isArray(settings.watches) ? (settings.watches as Watch[]) : [];

/**
 * Watched addresses live in the chat's settings of the subscription store. An in-memory
 * index by lowercase address answers "who watches this address" for every transaction.
 */
export class WatchService {
  private readonly index = new Map<string, Map<number, Watch>>();
  private readonly locks = new Map<number, Promise<unknown>>();
  /** Grows with every change of the index */
  private version = 0;

  constructor(
    private readonly store: SubscriptionStore,
    private readonly options: { maxPerChat: number; now?: () => number },
  ) {}

  private now() {
    return this.options.now?.() ?? Date.now();
  }

  /** Rebuilds the index from the store, e.g. after the notifier removed a chat */
  async load() {
    // A command that changes a chat while the list loads makes the snapshot stale: load again
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const version = this.version;
      const chats = await this.store.list();
      if (version !== this.version) continue;
      this.index.clear();
      for (const chat of chats) {
        this.indexChat(chat.chatId, readWatches(chat.settings));
      }
      return;
    }
  }

  private indexChat(chatId: number, watches: Watch[]) {
    this.version += 1;
    for (const [address, watchers] of this.index) {
      watchers.delete(chatId);
      if (!watchers.size) this.index.delete(address);
    }
    for (const watch of watches) {
      const watchers = this.index.get(key(watch.address)) ?? new Map();
      watchers.set(chatId, watch);
      this.index.set(key(watch.address), watchers);
    }
  }

  /** Runs changes of one chat one after another, so two commands cannot overwrite each other */
  private withChat<T>(chatId: number, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(chatId) ?? Promise.resolve();
    const run = previous.then(task, task);
    const settled = run.catch(() => undefined);
    this.locks.set(chatId, settled);
    void settled.then(() => {
      if (this.locks.get(chatId) === settled) this.locks.delete(chatId);
    });
    return run;
  }

  private async update(
    chatId: number,
    change: (watches: Watch[]) => Watch[] | null,
  ) {
    const chat = await this.store.get(chatId);
    const settings = chat?.settings ?? {};
    const watches = change(readWatches(settings));
    if (!watches) return;
    await this.store.save(chatId, { settings: { ...settings, watches } });
    this.indexChat(chatId, watches);
  }

  async list(chatId: number): Promise<Watch[]> {
    const chat = await this.store.get(chatId);
    return chat ? readWatches(chat.settings) : [];
  }

  /** Adds an address, or updates the label of one already watched */
  add(chatId: number, address: Address, label?: string): Promise<AddResult> {
    return this.withChat(chatId, async () => {
      let result: AddResult = { status: 'limit' };
      await this.update(chatId, (watches) => {
        const existing = watches.find((w) => key(w.address) === key(address));
        if (existing) {
          const watch = { ...existing, ...(label ? { label } : {}) };
          result = { status: 'updated', watch };
          return watches.map((w) => (w === existing ? watch : w));
        }
        if (watches.length >= this.options.maxPerChat) return null;
        const watch: Watch = { address, ...(label ? { label } : {}) };
        result = { status: 'added', watch };
        return [...watches, watch];
      });
      return result;
    });
  }

  /** Removes by address or by label; resolves with the removed watch */
  remove(chatId: number, addressOrLabel: string): Promise<Watch | null> {
    return this.withChat(chatId, async () => {
      let removed: Watch | null = null;
      const needle = addressOrLabel.toLowerCase();
      await this.update(chatId, (watches) => {
        removed =
          watches.find((w) => key(w.address) === needle) ??
          watches.find((w) => w.label?.toLowerCase() === needle) ??
          null;
        return removed ? watches.filter((w) => w !== removed) : null;
      });
      return removed;
    });
  }

  /** `until` null unmutes; resolves with the updated watch, or null if it is not watched */
  mute(
    chatId: number,
    address: Address,
    until: number | null,
  ): Promise<Watch | null> {
    return this.withChat(chatId, async () => {
      let updated: Watch | null = null;
      await this.update(chatId, (watches) => {
        const existing = watches.find((w) => key(w.address) === key(address));
        if (!existing) return null;
        const watch: Watch = { ...existing, mutedUntil: until ?? undefined };
        if (until === null) delete watch.mutedUntil;
        updated = watch;
        return watches.map((w) => (w === existing ? watch : w));
      });
      return updated;
    });
  }

  /** Chats watching the address that have not muted it */
  watchers(address: string): Watcher[] {
    const now = this.now();
    return [...(this.index.get(key(address)) ?? [])]
      .filter(([, watch]) => !watch.mutedUntil || watch.mutedUntil <= now)
      .map(([chatId, watch]) => ({ chatId, watch }));
  }

  hasWatches() {
    return this.index.size > 0;
  }

  stats() {
    const chats = new Set<number>();
    for (const watchers of this.index.values()) {
      for (const chatId of watchers.keys()) chats.add(chatId);
    }
    return { addresses: this.index.size, chats: chats.size };
  }
}
