import { html, type Html, type SendOptions } from '@dirai/tg-kit';
import type { FastifyBaseLogger } from 'fastify';
import { InlineKeyboard } from 'grammy';
import type { Address, Hex } from 'viem';

import { CHAINS } from '../chains.js';
import { callToken } from '../enrich/calldata.js';
import type { PriceLookup } from '../enrich/prices.js';
import type { MethodName, SignatureLookup } from '../enrich/signatures.js';
import { formatBlock } from '../format.js';
import type { BlockHandler, ChainReader, TokenInfo } from '../scanner/types.js';
import { collectActivity, mostImportant, type Activity } from './activity.js';
import type { DigestService } from './digest.js';
import {
  activityUsd,
  formatTx,
  watchLabel,
  type Enrichment,
  type TxGroup,
} from './messages.js';
import { isQuietTime, type ChatPrefs } from './prefs.js';
import type { Watch, WatchService } from './watch-service.js';

/** Sends a message to one chat; false when it was not delivered */
export type Deliver = (
  chatId: number,
  message: Html,
  options?: SendOptions,
) => Promise<boolean>;

/** Above this many ordinary transactions per chat in one block the rest is summarised */
export const MAX_MESSAGES_PER_BLOCK = 5;
/** Alerts get more room, but a flood of forged ones must not run without limit */
export const MAX_ALERTS_PER_BLOCK = 20;
export const MUTE_HOURS = 24;

/** Third-party lookups per block, and how long a block waits for them */
const MAX_TOKENS = 30;
const MAX_SELECTORS = 20;
const MAX_VERIFIED = 20;
const ENRICH_DEADLINE_MS = 1500;
const VERIFY_DEADLINE_MS = 3000;

export { watchLabel };

export const muteKeyboard = (watches: Watch[]) => {
  const keyboard = new InlineKeyboard();
  const [single] = watches;
  if (watches.length === 1 && single) {
    return keyboard.text(
      `🔕 Заглушить на ${MUTE_HOURS} ч`,
      `mute:${single.address}`,
    );
  }
  watches.slice(0, 3).forEach((watch, index) => {
    if (index > 0) keyboard.row();
    keyboard.text(
      `🔕 ${watchLabel(watch)} на ${MUTE_HOURS} ч`,
      `mute:${watch.address}`,
    );
  });
  return keyboard;
};

/** Resolves with `fallback` when the promise takes longer than `ms` */
const withDeadline = <T>(promise: Promise<T>, ms: number, fallback: T) =>
  new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });

/** Whether the chat wants to hear about this activity; alerts always get through */
const wanted = (
  activity: Activity,
  prefs: ChatPrefs,
  chainMuted: boolean,
  data: Enrichment,
) => {
  if (activity.importance === 'alert') return true;
  if (chainMuted) return false;
  // Fakes are hidden on request; a missing price alone is only a hint
  if (activity.spam && activity.spam !== 'unpriced' && prefs.spam === 'hide') {
    return false;
  }
  if (activity.importance === 'incoming' && prefs.minIncomingUsd > 0) {
    // Incoming calls carry no value; transfers without a price are kept, unknown is not small
    const usd = activity.kind === 'called' ? 0 : activityUsd(activity, data);
    if (usd !== undefined && usd < prefs.minIncomingUsd) return false;
  }
  return true;
};

const tokenOf = (activity: Activity): Address | null => {
  switch (activity.kind) {
    case 'send-token':
    case 'receive-token':
    case 'send-nft':
    case 'receive-nft':
    case 'approval':
    case 'nft-approval':
    case 'approval-for-all':
      return activity.token;
    default:
      return null;
  }
};

const selectorOf = (activity: Activity): Hex | null =>
  activity.kind === 'call' || activity.kind === 'called'
    ? activity.selector
    : null;

const calledToken = (activity: Activity): Address | null => {
  if (activity.kind === 'call') {
    return callToken(activity.selector, activity.input, activity.contract);
  }
  if (activity.kind === 'called') {
    return callToken(activity.selector, activity.input, activity.address);
  }
  return null;
};

/**
 * Whether the address really holds the token an alert is about. Any contract can emit a
 * Transfer or Approval naming any address; a token the owner never held cannot be taken
 * from them. Null when the contract does not answer: then the alert stays.
 */
const holdsToken = async (
  activity: Activity,
  reader: ChainReader,
  blockNumber: number,
): Promise<boolean | null> => {
  const balance = (block: number, tokenId?: bigint) =>
    reader.getTokenBalance(
      tokenOf(activity)!,
      activity.address,
      block,
      tokenId,
    );
  switch (activity.kind) {
    case 'send-token':
      return positive(await balance(blockNumber - 1));
    case 'send-nft':
      return positive(
        await balance(
          blockNumber - 1,
          activity.amounts ? activity.tokenIds[0] : undefined,
        ),
      );
    case 'approval':
      // Permit2 events come from Permit2 itself: the owner signed them
      if (activity.permit2) return true;
      return positive(await balance(blockNumber));
    case 'nft-approval':
    case 'approval-for-all':
      return positive(await balance(blockNumber));
    default:
      return true;
  }
};

const positive = (balance: bigint | null) =>
  balance === null ? null : balance > 0n;

/** Gathers token metadata, method names and prices, within limits and a deadline */
const enrich = async (
  chain: Parameters<PriceLookup>[0],
  activity: Activity[],
  reader: ChainReader,
  methods: SignatureLookup,
  prices: PriceLookup | null,
) => {
  // Tokens of alerts first, so a spam flood cannot crowd them out of the limit
  const byImportance = [...activity].sort(
    (a, b) =>
      Number(b.importance === 'alert') - Number(a.importance === 'alert'),
  );
  // Then tokens of called contracts, for the amounts in their arguments
  const tokens = [
    ...new Set(
      [...byImportance.map(tokenOf), ...activity.map(calledToken)].filter(
        (t): t is Address => t !== null,
      ),
    ),
  ].slice(0, MAX_TOKENS);
  const selectors = [
    ...new Set(
      activity.map(selectorOf).filter((s): s is Hex => !!s && s !== '0x'),
    ),
  ].slice(0, MAX_SELECTORS);
  const priced = [
    ...new Set(
      byImportance.flatMap((item): (Address | null)[] =>
        item.kind === 'send-native' || item.kind === 'receive-native'
          ? [null]
          : item.kind === 'send-token' || item.kind === 'receive-token'
            ? [item.token]
            : [],
      ),
    ),
  ].slice(0, MAX_TOKENS);

  const [tokenInfos, methodNames, priceMap] = await Promise.all([
    Promise.all(
      tokens.map(async (token) => {
        const info = await withDeadline(
          reader.getTokenInfo(token),
          ENRICH_DEADLINE_MS,
          null,
        );
        return [token, info] as const;
      }),
    ),
    Promise.all(
      selectors.map(async (selector) => {
        const name = await withDeadline(
          methods(selector),
          ENRICH_DEADLINE_MS,
          null,
        );
        return [selector, name] as const;
      }),
    ),
    prices && priced.length
      ? withDeadline(prices(chain, priced), ENRICH_DEADLINE_MS, null)
      : Promise.resolve(null),
  ]);

  const data: Enrichment = {
    tokens: new Map<Address, TokenInfo>(
      tokenInfos.flatMap(([token, info]) => (info ? [[token, info]] : [])),
    ),
    methods: new Map<Hex, MethodName | null>(methodNames),
    prices: priceMap ?? new Map(),
  };
  return { data, priceMap };
};

/**
 * Reports what watched addresses did in each block: transfers of ETH, tokens and NFTs,
 * contract calls, and approvals. Each chat gets one message per transaction, filtered
 * by its /settings; risky activity always gets through.
 */
export const addressWatchHandler = ({
  watches,
  deliver,
  methods,
  prices,
  digest,
  log,
  now = Date.now,
}: {
  watches: WatchService;
  deliver: Deliver;
  methods: SignatureLookup;
  /** Null turns USD amounts off */
  prices: PriceLookup | null;
  digest?: DigestService;
  log?: FastifyBaseLogger;
  now?: () => number;
}): BlockHandler => ({
  name: 'address-watch',
  wants: () => watches.hasWatches(),

  async handleBlock(chain, block, reader) {
    const isWatched = (address: Address) => watches.isWatched(address);
    const logs = await reader.getTokenLogs(block.hash, isWatched);
    const activity = collectActivity(block, logs, isWatched);
    if (!activity.length) return;

    const { data, priceMap } = await enrich(
      chain,
      activity,
      reader,
      methods,
      prices,
    );

    // Tokens nobody prices are typical of spam airdrops; only when prices answered
    if (priceMap) {
      for (const item of activity) {
        if (
          item.kind === 'receive-token' &&
          !item.spam &&
          item.value > 0n &&
          !priceMap.has(item.token)
        ) {
          item.spam = 'unpriced';
        }
      }
    }

    // Alerts about tokens the owner does not hold are forgeries: anyone can emit the events
    const unverified = activity
      .filter((item) => {
        const token = tokenOf(item);
        return item.importance === 'alert' && token && !data.prices.has(token);
      })
      .slice(0, MAX_VERIFIED);
    await withDeadline(
      Promise.all(
        unverified.map(async (item) => {
          if ((await holdsToken(item, reader, block.number)) === false) {
            item.importance = 'outgoing';
            item.spam = 'fake-token';
          }
        }),
      ),
      VERIFY_DEADLINE_MS,
      [],
    );

    // Group per chat and transaction, following each chat's settings
    const groups = new Map<number, Map<string, TxGroup>>();
    for (const item of activity) {
      const includeMuted = item.importance === 'alert';
      for (const { chatId, watch } of watches.watchers(item.address, {
        includeMuted,
      })) {
        const prefs = watches.prefs(chatId);
        const chainMuted = prefs.mutedChains.includes(chain);
        if (!wanted(item, prefs, chainMuted, data)) continue;
        const chatGroups = groups.get(chatId) ?? new Map<string, TxGroup>();
        const group = chatGroups.get(item.hash) ?? {
          hash: item.hash,
          watches: [],
          items: [],
          importance: 'incoming',
        };
        if (!group.watches.some((w) => w.address === watch.address)) {
          group.watches.push(watch);
        }
        group.items.push(item);
        group.importance = mostImportant(group.items);
        chatGroups.set(item.hash, group);
        groups.set(chatId, chatGroups);
      }
    }

    let undelivered = false;
    const send = async (
      chatId: number,
      message: Html,
      options: SendOptions,
    ) => {
      const ok = await deliver(chatId, message, options);
      undelivered ||= !ok;
    };

    for (const [chatId, chatGroups] of groups) {
      const prefs = watches.prefs(chatId);
      const label = (address: Address) => {
        for (const group of chatGroups.values()) {
          const watch = group.watches.find((w) => w.address === address);
          if (watch) return watchLabel(watch);
        }
        return address;
      };
      const quiet = isQuietTime(prefs, now());
      const alerts: TxGroup[] = [];
      const others: TxGroup[] = [];

      for (const group of chatGroups.values()) {
        if (group.importance === 'alert') {
          alerts.push(group);
          continue;
        }
        if (
          prefs.mode === 'digest' &&
          group.importance === 'incoming' &&
          digest
        ) {
          const usd = group.items.reduce(
            (sum, item) => sum + (activityUsd(item, data) ?? 0),
            0,
          );
          try {
            for (const watch of group.watches) {
              await digest.record(chatId, {
                address: watch.address,
                chain,
                hash: group.hash,
                ...(usd > 0 ? { usd } : {}),
                at: now(),
              });
            }
            continue;
          } catch (error) {
            // Better a message now than a lost transaction or a repeated block
            log?.warn(
              { err: error, chatId },
              'digest entry not saved, sending it',
            );
          }
        }
        others.push(group);
      }

      const message = (group: TxGroup) =>
        formatTx(chain, block.number, group, data, label);
      const options = (group: TxGroup, silent: boolean) => ({
        replyMarkup: muteKeyboard(group.watches),
        silent,
      });

      // Every alert rings, whatever the settings; the limit only stops forged floods
      for (const group of alerts.slice(0, MAX_ALERTS_PER_BLOCK)) {
        await send(chatId, message(group), options(group, false));
      }
      if (alerts.length > MAX_ALERTS_PER_BLOCK) {
        await send(
          chatId,
          html`🚨 …и ещё ${alerts.length - MAX_ALERTS_PER_BLOCK} тревог в блоке ${formatBlock(block.number)} (${CHAINS[chain].title}). Проверьте адреса в эксплорере.`,
          {},
        );
      }

      for (const group of others.slice(0, MAX_MESSAGES_PER_BLOCK)) {
        await send(chatId, message(group), options(group, quiet));
      }
      if (others.length > MAX_MESSAGES_PER_BLOCK) {
        await send(
          chatId,
          html`…и ещё ${others.length - MAX_MESSAGES_PER_BLOCK} транзакций в блоке ${formatBlock(block.number)} (${CHAINS[chain].title})`,
          { silent: true },
        );
      }
    }
    // The notifier unsubscribes chats that blocked the bot and follows migrated groups
    if (undelivered) await watches.load();
  },
});
