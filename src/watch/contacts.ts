import type { PgClientLike } from '@dirai/tg-kit';
import type { Address } from 'viem';

/**
 * Who each watched address has sent to or approved, so a transfer to someone new stands
 * out: address poisoning relies on a look-alike the owner never paid before. Known since
 * the bot started watching; history before that is not read.
 */
export interface ContactStore {
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
