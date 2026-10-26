import type { PgClientLike } from '@dirai/tg-kit';
import type { Address } from 'viem';

import { looksLike } from '../enrich/lookalike.js';

/**
 * Who each watched address has sent to or approved, so a transfer to someone new stands
 * out: address poisoning relies on a look-alike the owner never paid before. Known since
 * the bot started watching; history before that is not read.
 */
export interface ContactStore {
  /** Whether the owner dealt with the counterparty before; reads only */
  isKnown(owner: Address, counterparty: Address): Promise<boolean>;
  /** A counterparty of the owner that looks like this one in a wallet, if any */
  similar(owner: Address, counterparty: Address): Promise<Address | null>;
  /** Records the pair; true when the owner had not dealt with the counterparty before */
  remember(owner: Address, counterparty: Address): Promise<boolean>;
}

const key = (owner: Address, counterparty: Address) =>
  `${owner.toLowerCase()}:${counterparty.toLowerCase()}`;

/** Pairs kept in memory; the oldest go first past this many */
const MEMORY_CONTACTS = 10_000;

export const memoryContacts = (): ContactStore => {
  const seen = new Set<string>();
  return {
    isKnown: async (owner, counterparty) => seen.has(key(owner, counterparty)),
    async similar(owner, counterparty) {
      const prefix = `${owner.toLowerCase()}:`;
      for (const pair of seen) {
        const known = pair.slice(prefix.length);
        if (pair.startsWith(prefix) && looksLike(known, counterparty)) {
          return known as Address;
        }
      }
      return null;
    },
    async remember(owner, counterparty) {
      const pair = key(owner, counterparty);
      if (seen.has(pair)) return false;
      seen.add(pair);
      if (seen.size > MEMORY_CONTACTS) {
        seen.delete(seen.values().next().value!);
      }
      return true;
    },
  };
};

export const pgContacts = async (sql: PgClientLike): Promise<ContactStore> => {
  await sql.query(`CREATE TABLE IF NOT EXISTS contacts (
    owner text NOT NULL,
    counterparty text NOT NULL,
    first_seen timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner, counterparty)
  )`);
  return {
    async isKnown(owner, counterparty) {
      const { rows } = await sql.query(
        'SELECT 1 FROM contacts WHERE owner = $1 AND counterparty = $2',
        [owner.toLowerCase(), counterparty.toLowerCase()],
      );
      return rows.length > 0;
    },
    async similar(owner, counterparty) {
      const { rows } = await sql.query(
        `SELECT counterparty FROM contacts
         WHERE owner = $1 AND counterparty <> $2
           AND left(counterparty, 6) = left($2, 6)
           AND right(counterparty, 4) = right($2, 4)
         LIMIT 1`,
        [owner.toLowerCase(), counterparty.toLowerCase()],
      );
      return (
        (rows[0] as { counterparty: Address } | undefined)?.counterparty ?? null
      );
    },
    async remember(owner, counterparty) {
      const { rows } = await sql.query(
        `INSERT INTO contacts (owner, counterparty) VALUES ($1, $2)
         ON CONFLICT DO NOTHING RETURNING owner`,
        [owner.toLowerCase(), counterparty.toLowerCase()],
      );
      return rows.length === 1;
    },
  };
};
