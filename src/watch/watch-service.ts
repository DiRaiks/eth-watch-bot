import type { SubscriptionStore } from '@dirai-kit/tg';
import { getAddress, isAddress, type Address } from 'viem';

import { DEFAULT_PREFS, readPrefs, type ChatPrefs } from './prefs.js';

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

/** Default addresses the chat was ever given, watched or since removed */
const readSeeded = (settings: Record<string, unknown>): Address[] =>
  Array.isArray(settings.seeded) ? (settings.seeded as Address[]) : [];

/**
 * Watched addresses live in the chat's settings of the subscription store. An in-memory
 * index by lowercase address answers "who watches this address" for every transaction.
 */
export class WatchService {
  private readonly index = new Map<string, Map<number, Watch>>();
  private readonly prefsByChat = new Map<number, ChatPrefs>();
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
      this.prefsByChat.clear();
      for (const chat of chats) {
        this.indexChat(chat.chatId, chat.settings);
      }
      return;
    }
  }

  private indexChat(chatId: number, settings: Record<string, unknown>) {
    this.version += 1;
    const watches = readWatches(settings);
    if (settings.prefs) this.prefsByChat.set(chatId, readPrefs(settings));
    else this.prefsByChat.delete(chatId);
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
    const next = { ...settings, watches };
    await this.store.save(chatId, { settings: next });
    this.indexChat(chatId, next);
  }

  /** The chat's alert settings (defaults until changed) */
  prefs(chatId: number): ChatPrefs {
    return this.prefsByChat.get(chatId) ?? DEFAULT_PREFS;
  }

  /**
   * Changes the chat's settings. A function gets the stored settings inside the chat's
   * lock, so two quick button presses build on each other; null changes nothing.
   */
  setPrefs(
    chatId: number,
    change:
      Partial<ChatPrefs> | ((prefs: ChatPrefs) => Partial<ChatPrefs> | null),
  ): Promise<{ prefs: ChatPrefs; changed: boolean }> {
    return this.withChat(chatId, async () => {
      const chat = await this.store.get(chatId);
      const settings = chat?.settings ?? {};
      const current = readPrefs(settings);
      const update = typeof change === 'function' ? change(current) : change;
      if (!update) return { prefs: current, changed: false };
      const prefs = { ...current, ...update };
      const next = { ...settings, prefs };
      await this.store.save(chatId, { settings: next });
      this.indexChat(chatId, next);
      return { prefs, changed: true };
    });
  }

  /** Chats with saved settings, e.g. to find the ones that asked for a digest */
  chatsWithPrefs(): [number, ChatPrefs][] {
    return [...this.prefsByChat];
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

  /**
   * Adds the default addresses the chat was never given before, so one removed with
   * /unwatch stays removed after a restart. Resolves with the addresses added.
   */
  seed(chatId: number, addresses: Address[]): Promise<Address[]> {
    return this.withChat(chatId, async () => {
      const chat = await this.store.get(chatId);
      const settings = chat?.settings ?? {};
      const seeded = readSeeded(settings);
      let watches = readWatches(settings);
      const done = [...seeded];
      const added: Address[] = [];
      for (const address of addresses) {
        if (done.some((a) => key(a) === key(address))) continue;
        if (!watches.some((w) => key(w.address) === key(address))) {
          // Over the limit: not seeded, so it is tried again on the next start
          if (watches.length >= this.options.maxPerChat) continue;
          watches = [...watches, { address }];
          added.push(address);
        }
        done.push(address);
      }
      if (done.length === seeded.length) return added;
      const next = { ...settings, watches, seeded: done };
      await this.store.save(chatId, { settings: next });
      this.indexChat(chatId, next);
      return added;
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

  /**
   * Chats watching the address that have not muted it. Risky activity passes
   * `includeMuted`: a mute should silence noise, not hide a drain.
   */
  watchers(address: string, { includeMuted = false } = {}): Watcher[] {
    const now = this.now();
    return [...(this.index.get(key(address)) ?? [])]
      .filter(
        ([, watch]) =>
          includeMuted || !watch.mutedUntil || watch.mutedUntil <= now,
      )
      .map(([chatId, watch]) => ({ chatId, watch }));
  }

  /** Every watched address, lowercase */
  addresses(): string[] {
    return [...this.index.keys()];
  }

  /** Whether any chat watches the address, muted or not */
  isWatched(address: string) {
    return this.index.has(key(address));
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
