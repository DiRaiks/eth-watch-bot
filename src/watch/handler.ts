import type { Html, SendOptions } from '@dirai-kit/tg';
import type { FastifyBaseLogger } from 'fastify';
import { InlineKeyboard } from 'grammy';
import type { Address, Hash, Hex } from 'viem';

import { CHAINS, type ChainName } from '../chains.js';
import { callToken } from '../enrich/calldata.js';
import { looksLike } from '../enrich/lookalike.js';
import type { PriceLookup } from '../enrich/prices.js';
import type { MethodName, SignatureLookup } from '../enrich/signatures.js';
import { formatBlock } from '../format.js';
import { t, withLanguage } from '../i18n/index.js';
import type {
  BlockHandler,
  ChainReader,
  TokenInfo,
  TxReceipt,
} from '../scanner/types.js';
import {
  collectActivity,
  mostImportant,
  type Activity,
  type Importance,
} from './activity.js';
import type { ContactStore } from './contacts.js';
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
/** Receipts, balances and code of what is about to be reported */
const MAX_RECEIPTS = 20;
const MAX_BALANCES = 10;
const MAX_COUNTERPARTIES = 20;
const FACTS_DEADLINE_MS = 3000;
const VERIFY_DEADLINE_MS = 3000;

export { watchLabel };

export const muteKeyboard = (watches: Watch[]) => {
  const keyboard = new InlineKeyboard();
  const [single] = watches;
  if (watches.length === 1 && single) {
    return keyboard.text(t.mute(MUTE_HOURS), `mute:${single.address}`);
  }
  watches.slice(0, 3).forEach((watch, index) => {
    if (index > 0) keyboard.row();
    keyboard.text(
      t.muteAddress(watchLabel(watch), MUTE_HOURS),
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

const selectorOf = (activity: Activity): Hex | null => {
  switch (activity.kind) {
    case 'call':
    case 'called':
      return activity.selector;
    // Coins sent with a method call, e.g. staking
    case 'send-native':
    case 'receive-native':
      return activity.selector ?? null;
    default:
      return null;
  }
};

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

/** Activity that comes from the transaction itself, so its receipt tells its outcome */
const ownTx = (item: Activity) =>
  item.kind === 'send-native' ||
  item.kind === 'receive-native' ||
  item.kind === 'call' ||
  item.kind === 'called' ||
  item.kind === 'create';

/** The sender pays the fee: activity of a transaction the watched address sent */
const sentByWatched = (item: Activity) =>
  item.kind === 'send-native' || item.kind === 'call' || item.kind === 'create';

const lowercaseKeys = <V>(map: Map<Address, V>) =>
  new Map(
    [...map].map(([address, value]) => [
      address.toLowerCase() as Address,
      value,
    ]),
  );

/** A counterparty met in a transaction; remembered once the alert is delivered */
export type ContactPair = { hash: Hash; owner: Address; counterparty: Address };

/**
 * Who the watched address paid or allowed to spend. Only in a transaction it sent
 * itself: anyone can emit an Approval or Transfer naming the address, and a forged one
 * must not make a look-alike "known".
 */
/** Anyone the address seems to deal with, also in forged events: poisoning's targets */
const anyCounterpartyOf = (item: Activity): Address | null => {
  switch (item.kind) {
    case 'send-native':
    case 'send-token':
    case 'send-nft':
      return item.to;
    case 'approval':
    case 'nft-approval':
      return item.spender;
    case 'approval-for-all':
      return item.operator;
    default:
      return null;
  }
};

const counterpartyOf = (item: Activity): Address | null => {
  switch (item.kind) {
    case 'send-native':
      return item.to;
    case 'send-token':
    case 'send-nft':
      return item.sentBy || item.spam ? null : item.to;
    case 'approval':
    case 'nft-approval':
      return item.importance === 'alert' ? item.spender : null;
    case 'approval-for-all':
      return item.approved ? item.operator : null;
    default:
      return null;
  }
};

/**
 * What the transactions about to be reported did: whether they went through and their
 * fee, balances after the block, which counterparties are contracts and which are new.
 * Each part is best effort: a slow or missing answer only leaves its line out.
 */
const gatherFacts = async (
  items: Activity[],
  reader: ChainReader,
  blockNumber: number,
  contacts: ContactStore | undefined,
  /** Watched addresses, lowercase: the owner's own wallets are imitated too */
  watched: () => string[],
): Promise<
  Pick<
    Enrichment,
    'receipts' | 'balances' | 'contracts' | 'newContacts' | 'lookalikes'
  > & {
    contactPairs: ContactPair[];
  }
> => {
  const unique = <T>(values: T[], limit: number) =>
    [...new Set(values)].slice(0, limit);
  const hashes = unique(
    items.filter(ownTx).map((item) => item.hash),
    MAX_RECEIPTS,
  );
  const holders = unique(
    items
      .filter((item) => sentByWatched(item) || item.kind === 'receive-native')
      .map((item) => item.address),
    MAX_BALANCES,
  );
  const sentBy = new Set(
    items
      .filter(sentByWatched)
      .map((item) => `${item.hash}:${item.address.toLowerCase()}`),
  );
  const pairs: ContactPair[] = items
    .filter((item) => sentBy.has(`${item.hash}:${item.address.toLowerCase()}`))
    .flatMap((item) => {
      const counterparty = counterpartyOf(item);
      return counterparty
        ? [{ hash: item.hash, owner: item.address, counterparty }]
        : [];
    })
    .slice(0, MAX_COUNTERPARTIES);
  const counterparties = unique(
    pairs.map(({ counterparty }) => counterparty),
    MAX_COUNTERPARTIES,
  );

  const settle = <T>(promise: Promise<T> | undefined) =>
    promise
      ? withDeadline(
          promise.then((value): T | null => value),
          FACTS_DEADLINE_MS,
          null,
        )
      : Promise.resolve(null);

  // A counterparty that shows like a watched address or a known contact, yet is another
  const suspects = items
    .flatMap((item) => {
      const counterparty = anyCounterpartyOf(item);
      return counterparty ? [{ owner: item.address, counterparty }] : [];
    })
    .slice(0, MAX_COUNTERPARTIES);
  const lookalike = async ({
    owner,
    counterparty,
  }: {
    owner: Address;
    counterparty: Address;
  }) => {
    const own = watched().find((address) => looksLike(address, counterparty));
    const original =
      own ?? (await settle(contacts?.similar(owner, counterparty)));
    return original
      ? ([counterparty.toLowerCase(), original as Address] as const)
      : null;
  };

  const [receipts, balances, contracts, newContacts, imitations] =
    await Promise.all([
      Promise.all(
        hashes.map(
          async (hash) =>
            [hash, await settle(reader.getReceipt?.(hash))] as const,
        ),
      ),
      Promise.all(
        holders.map(
          async (address) =>
            [
              address,
              await settle(reader.getBalance?.(address, blockNumber)),
            ] as const,
        ),
      ),
      Promise.all(
        counterparties.map(
          async (address) =>
            [address, await settle(reader.isContract?.(address))] as const,
        ),
      ),
      Promise.all(
        pairs.map(async ({ owner, counterparty }) =>
          // Unknown when the store did not answer: then no note rather than a wrong one
          (await settle(contacts?.isKnown(owner, counterparty))) === false
            ? `${owner.toLowerCase()}:${counterparty.toLowerCase()}`
            : null,
        ),
      ),
      Promise.all(suspects.map(lookalike)),
    ]);

  const known = <K, V>(entries: (readonly [K, V | null])[]) =>
    new Map(
      entries.flatMap(([key, value]) =>
        value === null ? [] : [[key, value] as [K, V]],
      ),
    );
  return {
    receipts: known<Hash, TxReceipt>(receipts),
    // Addresses come in whatever case the RPC returns: keyed in lowercase
    balances: lowercaseKeys(known<Address, bigint>(balances)),
    contracts: lowercaseKeys(known<Address, boolean>(contracts)),
    newContacts: new Set(newContacts.filter((pair) => pair !== null)),
    contactPairs: pairs,
    lookalikes: new Map(imitations.filter((entry) => entry !== null)),
  };
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
        item.kind === 'send-native' ||
        item.kind === 'receive-native' ||
        sentByWatched(item)
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
  contacts,
  log,
  onSent,
  now = Date.now,
}: {
  watches: WatchService;
  deliver: Deliver;
  methods: SignatureLookup;
  /** Null turns USD amounts off */
  prices: PriceLookup | null;
  digest?: DigestService;
  /** Who each address dealt with, to point out new counterparties */
  contacts?: ContactStore;
  log?: FastifyBaseLogger;
  /** Called for every transaction message sent to a chat, e.g. to count it */
  onSent?: (chain: ChainName, importance: Importance) => void;
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

    // A symbol that imitates a popular ticker with look-alike letters is a fake token,
    // whatever its contract answers: its alerts are forgeries, its gifts spam
    for (const item of activity) {
      const token = tokenOf(item);
      if (
        !token ||
        data.prices.has(token) ||
        !data.tokens.get(token)?.imitates
      ) {
        continue;
      }
      if (item.importance === 'alert') {
        item.importance = 'outgoing';
        item.spam = 'fake-token';
      } else if (item.kind === 'receive-token' && !item.spam) {
        item.spam = 'unpriced';
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

    // What goes out as a message now; incoming activity of digest chats waits for the
    // summary and needs no receipts or balances
    const toDigest = (chatId: number, group: TxGroup) =>
      Boolean(digest) &&
      group.importance === 'incoming' &&
      watches.prefs(chatId).mode === 'digest';
    const reported = [
      ...new Set(
        [...groups].flatMap(([chatId, chatGroups]) =>
          [...chatGroups.values()]
            .filter((group) => !toDigest(chatId, group))
            .flatMap((group) => group.items),
        ),
      ),
    ];
    const { contactPairs, ...facts } = await gatherFacts(
      reported,
      reader,
      block.number,
      contacts,
      () => watches.addresses(),
    );
    Object.assign(data, facts);

    // ETH sent to a digest chat's address by a transaction that failed never arrived: only
    // these few need a receipt, the rest of the digest stays free of RPC calls
    const digestNative = [
      ...new Set(
        [...groups].flatMap(([chatId, chatGroups]) =>
          [...chatGroups.values()]
            .filter(
              (group) =>
                toDigest(chatId, group) &&
                group.items.some((item) => item.kind === 'receive-native') &&
                !data.receipts?.has(group.hash),
            )
            .map((group) => group.hash),
        ),
      ),
    ].slice(0, MAX_RECEIPTS);
    const digestReceipts = await Promise.all(
      digestNative.map(async (hash) => {
        const receipt = reader.getReceipt
          ? await withDeadline(
              reader.getReceipt(hash).then((value): TxReceipt | null => value),
              FACTS_DEADLINE_MS,
              null,
            )
          : null;
        return [hash, receipt] as const;
      }),
    );
    for (const [hash, receipt] of digestReceipts) {
      if (receipt) data.receipts?.set(hash, receipt);
    }

    // Counterparties become known once an alert about them reached a chat, so a failed
    // delivery and the retried block still say "first time"
    const remembered = new Set<string>();
    const rememberContacts = async (hash: Hash) => {
      if (data.receipts?.get(hash)?.success === false) return;
      for (const { owner, counterparty } of contactPairs.filter(
        (pair) => pair.hash === hash,
      )) {
        const pair = `${owner}:${counterparty}`;
        if (remembered.has(pair)) continue;
        remembered.add(pair);
        await contacts
          ?.remember(owner, counterparty)
          .catch((error: unknown) =>
            log?.warn({ err: error }, 'contact not saved'),
          );
      }
    };

    let undelivered = false;
    const send = async (
      chatId: number,
      message: Html,
      options: SendOptions,
    ) => {
      const ok = await deliver(chatId, message, options);
      undelivered ||= !ok;
      return ok;
    };

    for (const [chatId, chatGroups] of groups) {
      const prefs = watches.prefs(chatId);
      // Messages, buttons and summaries in the chat's own language
      await withLanguage(prefs.language, async () => {
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
            // Nothing arrived: not worth a line in the summary
            if (data.receipts?.get(group.hash)?.success === false) continue;
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
          formatTx(chain, block.number, group, data, label, {
            hideDetails: prefs.details === 'hidden',
            timeZone: prefs.timeZone,
            blockTime: block.timestamp,
          });
        const options = (group: TxGroup, silent: boolean) => ({
          replyMarkup: muteKeyboard(group.watches),
          silent,
        });

        // Every alert rings, whatever the settings; the limit only stops forged floods
        for (const group of alerts.slice(0, MAX_ALERTS_PER_BLOCK)) {
          if (await send(chatId, message(group), options(group, false))) {
            await rememberContacts(group.hash);
          }
          onSent?.(chain, group.importance);
        }
        if (alerts.length > MAX_ALERTS_PER_BLOCK) {
          await send(
            chatId,
            t.moreAlerts(
              alerts.length - MAX_ALERTS_PER_BLOCK,
              formatBlock(block.number),
              CHAINS[chain].title,
            ),
            {},
          );
        }

        for (const group of others.slice(0, MAX_MESSAGES_PER_BLOCK)) {
          if (await send(chatId, message(group), options(group, quiet))) {
            await rememberContacts(group.hash);
          }
          onSent?.(chain, group.importance);
        }
        if (others.length > MAX_MESSAGES_PER_BLOCK) {
          await send(
            chatId,
            t.moreTransactions(
              others.length - MAX_MESSAGES_PER_BLOCK,
              formatBlock(block.number),
              CHAINS[chain].title,
            ),
            { silent: true },
          );
        }
      });
    }
    // The notifier unsubscribes chats that blocked the bot and follows migrated groups
    if (undelivered) await watches.load();
  },
});
