import { html, joinHtml, type Html } from '@dirai/tg-kit';
import type { Address, Hash } from 'viem';

import { CHAINS, type ChainName } from '../chains.js';
import { addressLink, formatBlock, truncate, txLink } from '../format.js';
import { t } from '../i18n/index.js';
import type { BlockHandler } from '../scanner/types.js';
import { decodeMessage } from './decode.js';

export const MESSAGES_TOPIC = 'messages';
const MAX_SHOWN = 2000;
/** Above this many messages in one block the rest is summarised */
export const MAX_POSTS_PER_BLOCK = 5;

export type BlockMessage = {
  chain: ChainName;
  blockNumber: number;
  hash: Hash;
  from: Address;
  to: Address | null;
  text: string;
  /** Block time, unix seconds */
  timestamp: number;
};

export interface MessageStore {
  /** Saves the message; false when it was saved before (a repeated block) */
  add(message: BlockMessage): Promise<boolean>;
  /** Newest first */
  recent(limit: number): Promise<BlockMessage[]>;
}

/** `recipients` above 1 means the sender mailed the same text to several addresses in the block */
export const formatMessage = (message: BlockMessage, recipients = 1) =>
  joinHtml([
    t.messageTitle(
      formatBlock(message.blockNumber),
      CHAINS[message.chain].title,
    ),
    html`<blockquote expandable>${truncate(message.text, MAX_SHOWN)}</blockquote>`,
    html`${addressLink(message.chain, message.from)}${
      recipients > 1
        ? t.toAddresses(recipients)
        : message.to
          ? html` → ${addressLink(message.chain, message.to)}`
          : ''
    } · ${txLink(message.chain, message.hash)}`,
  ]);

/**
 * Finds text messages in transaction input, stores them for the API and posts them to
 * subscribed chats. The same text from one sender in a block is posted once.
 */
export const blockMessagesHandler = ({
  chains,
  store,
  broadcast,
}: {
  chains: ChainName[];
  store: MessageStore;
  broadcast: (message: Html) => Promise<unknown>;
}): BlockHandler => ({
  name: 'block-messages',
  wants: (chain) => chains.includes(chain),

  async handleBlock(chain, block) {
    const mailings = new Map<
      string,
      { first: BlockMessage; recipients: number; fresh: boolean }
    >();
    for (const tx of block.transactions) {
      const text = decodeMessage(tx.input);
      if (!text) continue;
      const message: BlockMessage = {
        chain,
        blockNumber: block.number,
        hash: tx.hash,
        from: tx.from,
        to: tx.to,
        text,
        timestamp: block.timestamp,
      };
      const fresh = await store.add(message);
      const key = `${tx.from.toLowerCase()}\n${text}`;
      const mailing = mailings.get(key);
      if (mailing) {
        mailing.recipients += 1;
        mailing.fresh ||= fresh;
      } else {
        mailings.set(key, { first: message, recipients: 1, fresh });
      }
    }
    const fresh = [...mailings.values()].filter((mailing) => mailing.fresh);
    for (const { first, recipients } of fresh.slice(0, MAX_POSTS_PER_BLOCK)) {
      await broadcast(formatMessage(first, recipients));
    }
    const rest = fresh.length - MAX_POSTS_PER_BLOCK;
    if (rest > 0) {
      await broadcast(
        t.moreMessages(rest, formatBlock(block.number), CHAINS[chain].title),
      );
    }
  },
});
