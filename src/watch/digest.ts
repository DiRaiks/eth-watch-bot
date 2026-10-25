import { html, joinHtml, type Html } from '@dirai/tg-kit';
import type { FastifyBaseLogger } from 'fastify';
import type { Address, Hash } from 'viem';

import { CHAINS, type ChainName } from '../chains.js';
import { addressLink } from '../format.js';
import { t, withLanguage } from '../i18n/index.js';
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

/** The subset of a Postgres client the store uses: a `pg` Pool, or PGlite in tests */
type Sql = {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
};

export const pgDigests = async (sql: Sql): Promise<DigestStore> => {
  await sql.query(`CREATE TABLE IF NOT EXISTS digests (
    chat_id bigint PRIMARY KEY,
    entries jsonb NOT NULL DEFAULT '[]',
    sent_day text
  )`);
  return {
    async add(chatId, entry) {
      // Appends, keeping the last MAX_ENTRIES in order
      await sql.query(
        `INSERT INTO digests (chat_id, entries) VALUES ($1, jsonb_build_array($2::jsonb))
         ON CONFLICT (chat_id) DO UPDATE SET entries = (
           SELECT COALESCE(jsonb_agg(e ORDER BY i), '[]'::jsonb) FROM (
             SELECT e, i
             FROM jsonb_array_elements(digests.entries || jsonb_build_array($2::jsonb))
               WITH ORDINALITY AS a(e, i)
             ORDER BY i DESC LIMIT $3
           ) AS kept
         )`,
        [chatId, JSON.stringify(entry), MAX_ENTRIES],
      );
    },
    async take(chatId) {
      // One statement: an entry added meanwhile is either taken or kept, never lost
      const { rows } = await sql.query(
        `WITH taken AS (
           SELECT entries FROM digests WHERE chat_id = $1 FOR UPDATE
         )
         UPDATE digests SET entries = '[]' FROM taken
         WHERE digests.chat_id = $1
         RETURNING taken.entries`,
        [chatId],
      );
      return ((rows[0] as { entries?: DigestEntry[] } | undefined)?.entries ??
        []) as DigestEntry[];
    },
    async lastSent(chatId) {
      const { rows } = await sql.query(
        'SELECT sent_day FROM digests WHERE chat_id = $1',
        [chatId],
      );
      return (
        (rows[0] as { sent_day: string | null } | undefined)?.sent_day ?? null
      );
    },
    async markSent(chatId, day) {
      await sql.query(
        `INSERT INTO digests (chat_id, sent_day) VALUES ($1, $2)
         ON CONFLICT (chat_id) DO UPDATE SET sent_day = $2`,
        [chatId, day],
      );
    },
  };
};

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

/** Entries older than this are dropped from a digest: they belong to an earlier day */
const MAX_AGE_MS = 48 * 3_600_000;

/** Sends each digest chat its summary once a day, at the chat's local digest hour */
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

    const text = withLanguage(watches.prefs(chatId).language, () =>
      formatDigest(entries, label, defaultChain),
    );
    if (await deliver(chatId, text)) {
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
