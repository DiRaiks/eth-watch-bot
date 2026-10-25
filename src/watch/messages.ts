import { html, joinHtml, raw, type Html } from '@dirai/tg-kit';
import type { Address, Hash, Hex } from 'viem';

import { addressUrl, CHAINS, type ChainName } from '../chains.js';
import { callAmount, decodeCall, type CallArg } from '../enrich/calldata.js';
import type { MethodName } from '../enrich/signatures.js';
import { RISKY_METHODS } from '../enrich/signatures.js';
import { t } from '../i18n/index.js';
import { usdValue } from '../enrich/prices.js';
import {
  addressLink,
  formatAmount,
  formatBlock,
  formatTime,
  groupThousands,
  shortAddress,
  truncate,
  txLink,
} from '../format.js';
import type { TokenInfo } from '../scanner/types.js';
import type { Activity, Importance } from './activity.js';
import type { Watch } from './watch-service.js';

/** What the handler learned about the block's tokens, methods and prices */
export type Enrichment = {
  tokens: Map<Address, TokenInfo>;
  methods: Map<Hex, MethodName | null>;
  /** USD price per token; the native coin under null */
  prices: Map<Address | null, number>;
};

export const watchLabel = (watch: Watch) =>
  watch.label ?? shortAddress(watch.address);

export const formatUsd = (usd: number) => {
  if (usd >= 100) return `$${groupThousands(String(Math.round(usd)))}`;
  if (usd >= 0.01) return `$${usd.toFixed(2)}`;
  return '<$0.01';
};

/** USD value of a transfer, when the price is known; undefined otherwise */
export const activityUsd = (
  activity: Activity,
  data: Enrichment,
): number | undefined => {
  if (activity.kind === 'send-native' || activity.kind === 'receive-native') {
    const price = data.prices.get(null);
    return price === undefined
      ? undefined
      : usdValue(activity.value, 18, price);
  }
  if (activity.kind === 'send-token' || activity.kind === 'receive-token') {
    const price = data.prices.get(activity.token);
    const decimals = data.tokens.get(activity.token)?.decimals;
    return price === undefined || decimals === null || decimals === undefined
      ? undefined
      : usdValue(activity.value, decimals, price);
  }
  return undefined;
};

const tokenLink = (chain: ChainName, token: Address, data: Enrichment) =>
  html`<a href="${addressUrl(chain, token)}">${data.tokens.get(token)?.symbol || shortAddress(token)}</a>`;

const tokenAmount = (
  chain: ChainName,
  token: Address,
  value: bigint,
  data: Enrichment,
) => {
  const decimals = data.tokens.get(token)?.decimals;
  const amount =
    decimals === null || decimals === undefined
      ? `${value.toString()} ${t.units}`
      : formatAmount(value, decimals);
  return html`<b>${amount}</b> ${tokenLink(chain, token, data)}`;
};

const withUsd = (amount: Html, usd: number | undefined) =>
  usd === undefined ? amount : html`${amount} (${formatUsd(usd)})`;

/** Arguments shown per call; the rest is summarised */
const MAX_ARGS = 4;
const TIME_PARAMS = /^(deadline|expiration|expiry|sigDeadline)$/;

/** A number short enough for a line: digits grouped, huge ones as a power of ten */
const shortNumber = (value: bigint) => {
  const digits = (value < 0n ? -value : value).toString();
  const sign = value < 0n ? '-' : '';
  return digits.length > 18
    ? `${sign}${digits[0]}.${digits.slice(1, 3)}e${digits.length - 1}`
    : `${sign}${groupThousands(digits)}`;
};

const isMax = (type: string, value: bigint) => {
  const bits = Number(type.slice(4) || 256);
  return (
    type.startsWith('uint') && bits >= 128 && value === 2n ** BigInt(bits) - 1n
  );
};

/** Built-in parameter names that hold token amounts, where the maximum means "all" */
const AMOUNT_PARAMS = /^(amount|value|amountIn)$/;
/** Line breaks, bidi overrides and invisible characters could forge the message's layout */
const INVISIBLE = /[\p{C}\p{Z}]+/gu;

const argValue = (
  chain: ChainName,
  arg: CallArg,
  data: Enrichment,
  amountOf: Address | null,
): Html | string => {
  const { type } = arg;
  // viem decodes integers of up to 48 bits as numbers
  const value = typeof arg.value === 'number' ? BigInt(arg.value) : arg.value;
  if (type.endsWith(']')) {
    return Array.isArray(value) ? t.items(value.length) : '[…]';
  }
  if (type === 'tuple') {
    return arg.components ? argList(chain, arg.components, data, null) : '(…)';
  }
  if (type === 'address' && typeof value === 'string') {
    const token = data.tokens.get(value as Address);
    return token?.symbol
      ? tokenLink(chain, value as Address, data)
      : addressLink(chain, value);
  }
  if (type === 'bool') return value ? t.yes : t.no;
  if (type === 'string' && typeof value === 'string') {
    return `«${truncate(value.replace(INVISIBLE, ' '), 24)}»`;
  }
  if (typeof value === 'bigint') {
    const token = amountOf && data.tokens.get(amountOf);
    // No decimals: an NFT, whose approve and transferFrom take a token id
    if (token && token.decimals === null) return `#${value}`;
    if (arg.name && TIME_PARAMS.test(arg.name)) {
      if (value < 2n ** 40n) return formatTime(Number(value) * 1000);
    } else if (
      (amountOf || AMOUNT_PARAMS.test(arg.name ?? '')) &&
      isMax(type, value)
    ) {
      return html`<b>${t.all}</b>`;
    }
    if (token && token.decimals !== null) {
      return `${formatAmount(value, token.decimals)} ${token.symbol}`.trim();
    }
    return shortNumber(value);
  }
  if (typeof value === 'string' && value.startsWith('0x')) {
    return value.length > 18
      ? t.bytes(value.slice(0, 10), (value.length - 2) / 2)
      : value;
  }
  return '…';
};

/** "(to 0x28C6…1d60, amount 250 000 USDC)"; names only from trusted signatures */
const argList = (
  chain: ChainName,
  args: CallArg[],
  data: Enrichment,
  amount: { index: number; token: Address } | null,
): Html => {
  const shown = args.slice(0, MAX_ARGS).map((arg, index) => {
    const value = argValue(
      chain,
      arg,
      data,
      amount?.index === index ? amount.token : null,
    );
    return arg.name ? html`${arg.name} ${value}` : html`${value}`;
  });
  if (args.length > MAX_ARGS) shown.push(html`…`);
  return html`(${joinHtml(shown, ', ')})`;
};

const methodText = (
  chain: ChainName,
  selector: Hex | null,
  input: Hex,
  contract: Address,
  data: Enrichment,
) => {
  if (!selector || selector === '0x') return '';
  const method = data.methods.get(selector);
  if (!method) return t.method(selector);
  const args =
    method.signature &&
    decodeCall(method.signature, input, { named: method.trusted });
  const params = args
    ? argList(chain, args, data, callAmount(selector, contract, args))
    : '';
  if (!method.trusted) {
    // Anyone can register a name for a selector: show it as a hint only
    return t.methodHint(selector, method.name, params);
  }
  const risky = RISKY_METHODS.has(method.name) ? '⚠️ ' : '';
  return html` · ${risky}<b>${method.name}</b>${params}`;
};

const nftIds = (tokenIds: bigint[], amounts: bigint[] | null) => {
  const shown = tokenIds.slice(0, 3).map((id, i) => {
    const amount = amounts?.[i];
    return amount !== undefined && amount !== 1n
      ? `#${id} ×${amount}`
      : `#${id}`;
  });
  return tokenIds.length > 3
    ? `${shown.join(', ')} ${t.andMore(tokenIds.length - 3)}`
    : shown.join(', ');
};

/** One line describing an activity, from the point of view of the watched address */
export const activityLine = (
  chain: ChainName,
  activity: Activity,
  data: Enrichment,
): Html => {
  const line = describe(chain, activity, data);
  if (activity.spam !== 'fake-token') return line;
  // An alarming event from a token the address never held: say so instead of alarming
  return html`${raw(line.value.replace(/^🚨/u, '⚠️'))}${t.fakeTokenNote}`;
};

const describe = (
  chain: ChainName,
  activity: Activity,
  data: Enrichment,
): Html => {
  const native = CHAINS[chain].nativeSymbol;
  const link = (address: Address) => addressLink(chain, address);
  const usd = activityUsd(activity, data);

  switch (activity.kind) {
    case 'create':
      return t.created;
    case 'send-native':
      return html`${t.sent(
        withUsd(
          html`<b>${formatAmount(activity.value, 18)} ${native}</b>`,
          usd,
        ),
        link(activity.to),
      )}${methodText(
        chain,
        activity.selector ?? null,
        activity.input ?? '0x',
        activity.to,
        data,
      )}`;
    case 'receive-native':
      return html`${t.received(
        withUsd(
          html`<b>${formatAmount(activity.value, 18)} ${native}</b>`,
          usd,
        ),
        link(activity.from),
      )}${methodText(
        chain,
        activity.selector ?? null,
        activity.input ?? '0x',
        activity.address,
        data,
      )}`;
    case 'call':
      return t.call(
        link(activity.contract),
        methodText(
          chain,
          activity.selector,
          activity.input,
          activity.contract,
          data,
        ),
      );
    case 'called':
      return t.calledBy(
        link(activity.caller),
        methodText(
          chain,
          activity.selector,
          activity.input,
          activity.address,
          data,
        ),
      );

    case 'send-token': {
      const amount = withUsd(
        tokenAmount(chain, activity.token, activity.value, data),
        usd,
      );
      if (activity.spam === 'fake-transfer') {
        return t.fakeTransfer(amount, link(activity.to));
      }
      if (activity.sentBy) {
        return t.taken(amount, link(activity.to), link(activity.sentBy));
      }
      return t.sent(amount, link(activity.to));
    }
    case 'receive-token': {
      const amount = withUsd(
        tokenAmount(chain, activity.token, activity.value, data),
        usd,
      );
      const note =
        activity.spam === 'fake-transfer'
          ? t.zeroTransferNote
          : activity.spam === 'unpriced'
            ? t.unpricedNote
            : '';
      return html`${t.received(amount, link(activity.from))}${note}`;
    }

    case 'send-nft': {
      const what = html`NFT ${tokenLink(chain, activity.token, data)} ${nftIds(activity.tokenIds, activity.amounts)}`;
      return activity.sentBy
        ? t.nftTaken(what, link(activity.to), link(activity.sentBy))
        : t.nftSent(what, link(activity.to));
    }
    case 'receive-nft':
      return t.nftReceived(
        html`NFT ${tokenLink(chain, activity.token, data)} ${nftIds(activity.tokenIds, activity.amounts)}`,
        link(activity.from),
      );

    case 'approval': {
      const token = tokenLink(chain, activity.token, data);
      if (activity.value === 0n) {
        return t.approvalRevoked(token, link(activity.spender));
      }
      const via = activity.permit2
        ? t.viaPermit2(formatTime(activity.permit2.expiration * 1000))
        : '';
      return activity.unlimited
        ? t.approvalAll(via, link(activity.spender), token)
        : t.approvalAmount(
            via,
            link(activity.spender),
            tokenAmount(chain, activity.token, activity.value, data),
          );
    }
    case 'nft-approval':
      return activity.importance === 'alert'
        ? t.nftApproval(
            link(activity.spender),
            tokenLink(chain, activity.token, data),
            activity.tokenId,
          )
        : t.nftApprovalCleared(
            tokenLink(chain, activity.token, data),
            activity.tokenId,
          );
    case 'approval-for-all':
      return activity.approved
        ? t.approvalForAll(
            link(activity.operator),
            tokenLink(chain, activity.token, data),
          )
        : t.approvalForAllRevoked(
            tokenLink(chain, activity.token, data),
            link(activity.operator),
          );
  }
};

export type TxGroup = {
  hash: Hash;
  watches: Watch[];
  items: Activity[];
  importance: Importance;
};

/** Lines per message; a transaction can touch hundreds of tokens */
const MAX_LINES = 12;
/** Telegram allows 4096 characters; links take more than they show */
const MAX_LENGTH = 3500;

const RANK = { alert: 0, outgoing: 1, incoming: 2 } as const;

/** What happened, in a word or two: the only part an alert shows before its spoiler */
const eventName = (top: Activity | undefined, importance: Importance) => {
  if (importance === 'alert' && top) {
    if (
      top.kind === 'approval' ||
      top.kind === 'nft-approval' ||
      top.kind === 'approval-for-all'
    ) {
      return t.eventApproval;
    }
    if ((top.kind === 'send-token' || top.kind === 'send-nft') && top.sentBy) {
      return t.eventTaken;
    }
    return t.eventAlert;
  }
  return importance === 'incoming' ? t.eventIncoming : t.eventOutgoing;
};

/** One message per transaction: what the chat's addresses did in it, alerts first */
export const formatTx = (
  chain: ChainName,
  blockNumber: number,
  group: TxGroup,
  data: Enrichment,
  label: (address: Address) => string,
  { hideDetails = false }: { hideDetails?: boolean } = {},
) => {
  const several = group.watches.length > 1;
  const title = group.watches.map(watchLabel).join(', ');
  const icon = group.importance === 'alert' ? '🚨' : '🔔';
  const items = [...group.items].sort(
    (a, b) => RANK[a.importance] - RANK[b.importance],
  );
  const lines = items.map((item) => {
    const line = activityLine(chain, item, data);
    return several ? html`<b>${label(item.address)}</b>: ${line}` : line;
  });
  // Nothing sensitive here: the chat list shows it as the message preview
  const header = html`${icon} <b>${title}</b> · ${CHAINS[chain].title} · ${eventName(items[0], group.importance)}`;

  const build = (shown: number) => {
    const details = joinHtml([
      ...lines.slice(0, shown),
      shown < lines.length && t.moreInTx(lines.length - shown),
      t.block(txLink(chain, group.hash), formatBlock(blockNumber)),
    ]);
    return joinHtml([
      header,
      hideDetails ? html`<tg-spoiler>${details}</tg-spoiler>` : details,
      group.importance === 'alert' && t.advice,
    ]);
  };

  let shown = Math.min(lines.length, MAX_LINES);
  let message = build(shown);
  while (message.value.length > MAX_LENGTH && shown > 1) {
    shown -= 1;
    message = build(shown);
  }
  return message;
};
