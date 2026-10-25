import { html, joinHtml, type Html } from '@dirai/tg-kit';
import type { FastifyBaseLogger } from 'fastify';
import type { Collection } from 'mongodb';
import type { Address, Hash } from 'viem';

import { CHAINS, type ChainName } from '../chains.js';
import { addressLink } from '../format.js';
import { t } from '../i18n/index.js';
import { formatUsd, watchLabel } from './messages.js';
import { localDay, localHour } from './prefs.js';
import type { WatchService } from './watch-service.js';

/** An incoming transaction kept for the chat's daily summary */
export type DigestEntry = {
  address: Address;
  chain: ChainName;
  hash: Hash;
  /** USD value of what arrived, when known */
  usd?: number;
  /** When the bot saw it, unix ms */
  at: number;
};

export interface DigestStore {
  add(chatId: number, entry: DigestEntry): Promise<void>;
  /** Returns the chat's entries and clears them */
  take(chatId: number): Promise<DigestEntry[]>;
  /** Local day of the last digest sent to the chat */
  lastSent(chatId: number): Promise<string | null>;
  markSent(chatId: number, day: string): Promise<void>;
}

/** Entries kept per chat; a flood of spam must not grow the store without bound */
const MAX_ENTRIES = 1000;

export const memoryDigests = (): DigestStore => {
  const entries = new Map<number, DigestEntry[]>();
  const sent = new Map<number, string>();
  return {
    async add(chatId, entry) {
      entries.set(
        chatId,
        [...(entries.get(chatId) ?? []), entry].slice(-MAX_ENTRIES),
      );
    },
    async take(chatId) {
      const taken = entries.get(chatId) ?? [];
      entries.delete(chatId);
      return taken;
    },
    lastSent: async (chatId) => sent.get(chatId) ?? null,
    async markSent(chatId, day) {
      sent.set(chatId, day);
    },
  };
};

type DigestDocument = {
  chatId: number;
  entries: DigestEntry[];
  sentDay?: string;
};

export const mongoDigests = (
  collection: Collection<DigestDocument>,
): DigestStore => ({
  async add(chatId, entry) {
    await collection.updateOne(
      { chatId },
      { $push: { entries: { $each: [entry], $slice: -MAX_ENTRIES } } },
      { upsert: true },
    );
  },
  async take(chatId) {
    const before = await collection.findOneAndUpdate(
      { chatId },
      { $set: { entries: [] } },
      { returnDocument: 'before' },
    );
    return before?.entries ?? [];
  },
  async lastSent(chatId) {
    return (await collection.findOne({ chatId }))?.sentDay ?? null;
  },
  async markSent(chatId, day) {
    await collection.updateOne(
      { chatId },
      { $set: { sentDay: day } },
      { upsert: true },
    );
  },
});

/** The summary text: per address, how many incoming transactions and roughly how much */
export const formatDigest = (
  entries: DigestEntry[],
  label: (address: Address) => string,
  defaultChain: ChainName,
): Html => {
  if (!entries.length) {
    return joinHtml([t.digestTitle, t.digestEmpty]);
  }
  const byAddress = new Map<string, DigestEntry[]>();
  for (const entry of entries) {
    const key = entry.address.toLowerCase();
    byAddress.set(key, [...(byAddress.get(key) ?? []), entry]);
  }
  const lines = [...byAddress.values()].map((items) => {
    const [first] = items as [DigestEntry, ...DigestEntry[]];
    const transactions = new Set(items.map((item) => item.hash)).size;
    const usd = items.reduce((sum, item) => sum + (item.usd ?? 0), 0);
    const chains = [
      ...new Set(items.map((item) => CHAINS[item.chain].title)),
    ].join(', ');
    return html`<b>${label(first.address)}</b> (${addressLink(defaultChain, first.address)}): ${t.digestIncoming(transactions)}${
      usd > 0 ? t.digestWorth(formatUsd(usd)) : ''
    } · ${chains}`;
  });
  return joinHtml([t.digestTitle, ...lines, t.digestNote]);
};

/** Sends each digest chat its summary once a day, at the chat's local digest hour */
/** Entries older than this are dropped from a digest: they belong to an earlier day */
const MAX_AGE_MS = 48 * 3_600_000;

export class DigestService {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<unknown> | undefined;

  constructor(
    private readonly options: {
      store: DigestStore;
      watches: WatchService;
      deliver: (chatId: number, message: Html) => Promise<boolean>;
      defaultChain: ChainName;
      log: FastifyBaseLogger;
      now?: () => number;
    },
  ) {}

  private now() {
    return this.options.now?.() ?? Date.now();
  }

  record(chatId: number, entry: DigestEntry) {
    return this.options.store.add(chatId, entry);
  }

  /** Drops what was collected, e.g. when the chat goes back to a message per transaction */
  async discard(chatId: number) {
    await this.options.store.take(chatId);
  }

  private async sendDigest(chatId: number, day: string) {
    const { store, watches, deliver, defaultChain } = this.options;
    const now = this.now();
    const entries = (await store.take(chatId)).filter(
      (entry) => now - entry.at <= MAX_AGE_MS,
    );
    const list = await watches.list(chatId);
    const label = (address: Address) => {
      const watch = list.find(
        (w) => w.address.toLowerCase() === address.toLowerCase(),
      );
      return watch ? watchLabel(watch) : address;
    };

    if (await deliver(chatId, formatDigest(entries, label, defaultChain))) {
      await store.markSent(chatId, day);
      return true;
    }
    // Not delivered: keep the entries for the next attempt
    for (const entry of entries) await store.add(chatId, entry);
    return false;
  }

  /**
   * Sends the digests that are due: from the chat's digest hour on, once per local day,
   * so a bot that was down at that hour sends it when it is back. Resolves with the
   * chats that got one.
   */
  async tick(): Promise<number[]> {
    const { store, watches, log } = this.options;
    const now = this.now();
    const sent: number[] = [];

    for (const [chatId, prefs] of watches.chatsWithPrefs()) {
      if (prefs.mode !== 'digest' || localHour(prefs, now) < prefs.digestHour) {
        continue;
      }
      const day = localDay(prefs, now);
      try {
        if ((await store.lastSent(chatId)) === day) continue;
        if (await this.sendDigest(chatId, day)) sent.push(chatId);
      } catch (error) {
        // One chat must not keep the others from their digest
        log.error({ err: error, chatId }, 'digest failed');
      }
    }
    return sent;
  }

  start(intervalMs = 60_000) {
    this.timer = setInterval(() => {
      // A slow tick (many chats, Telegram limits) must not overlap with the next one
      if (this.running) return;
      this.running = this.tick()
        .catch((error: unknown) =>
          this.options.log.error({ err: error }, 'digest tick failed'),
        )
        .finally(() => {
          this.running = undefined;
        });
    }, intervalMs);
  }

  async close() {
    clearInterval(this.timer);
    await this.running;
  }
}
