import { html, joinHtml, raw, type Html } from '@dirai/tg-kit';
import type { Address, Hash, Hex } from 'viem';

import { addressUrl, CHAINS, type ChainName } from '../chains.js';
import type { MethodName } from '../enrich/signatures.js';
import { RISKY_METHODS } from '../enrich/signatures.js';
import { usdValue } from '../enrich/prices.js';
import {
  addressLink,
  formatAmount,
  formatBlock,
  formatTime,
  groupThousands,
  shortAddress,
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
      ? `${value.toString()} ед.`
      : formatAmount(value, decimals);
  return html`<b>${amount}</b> ${tokenLink(chain, token, data)}`;
};

const withUsd = (amount: Html, usd: number | undefined) =>
  usd === undefined ? amount : html`${amount} (${formatUsd(usd)})`;

const methodText = (selector: Hex | null, data: Enrichment) => {
  if (!selector || selector === '0x') return '';
  const method = data.methods.get(selector);
  if (!method) return html` · метод <code>${selector}</code>`;
  if (!method.trusted) {
    // Anyone can register a name for a selector: show it as a hint only
    return html` · метод <code>${selector}</code> (похоже на ${method.name})`;
  }
  const risky = RISKY_METHODS.has(method.name) ? '⚠️ ' : '';
  return html` · ${risky}<b>${method.name}</b>`;
};

const nftIds = (tokenIds: bigint[], amounts: bigint[] | null) => {
  const shown = tokenIds.slice(0, 3).map((id, i) => {
    const amount = amounts?.[i];
    return amount !== undefined && amount !== 1n
      ? `#${id} ×${amount}`
      : `#${id}`;
  });
  return tokenIds.length > 3
    ? `${shown.join(', ')} и ещё ${tokenIds.length - 3}`
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
  return html`${raw(line.value.replace(/^🚨/u, '⚠️'))} · ⚠️ у вас нет этого токена, похоже на подделку: ничего не пропало`;
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
      return html`🧱 Создание контракта`;
    case 'send-native':
      return html`⬆️ Отправлено ${withUsd(html`<b>${formatAmount(activity.value, 18)} ${native}</b>`, usd)} → ${link(activity.to)}`;
    case 'receive-native':
      return html`⬇️ Получено ${withUsd(html`<b>${formatAmount(activity.value, 18)} ${native}</b>`, usd)} от ${link(activity.from)}`;
    case 'call':
      return html`⚙️ Вызов ${link(activity.contract)}${methodText(activity.selector, data)}`;
    case 'called':
      return html`⚙️ Вызов от ${link(activity.caller)}${methodText(activity.selector, data)}`;

    case 'send-token': {
      const amount = withUsd(
        tokenAmount(chain, activity.token, activity.value, data),
        usd,
      );
      if (activity.spam === 'fake-transfer') {
        return html`⚠️ Поддельный перевод ${amount} → ${link(activity.to)} от вашего имени. Это address poisoning: не копируйте адрес получателя из истории`;
      }
      if (activity.sentBy) {
        return html`🚨 Списано ${amount} → ${link(activity.to)}, транзакцию отправил ${link(activity.sentBy)}`;
      }
      return html`⬆️ Отправлено ${amount} → ${link(activity.to)}`;
    }
    case 'receive-token': {
      const amount = withUsd(
        tokenAmount(chain, activity.token, activity.value, data),
        usd,
      );
      const note =
        activity.spam === 'fake-transfer'
          ? ' · ⚠️ нулевой перевод, похоже на спам'
          : activity.spam === 'unpriced'
            ? ' · ⚠️ токен без цены, возможно спам'
            : '';
      return html`⬇️ Получено ${amount} от ${link(activity.from)}${note}`;
    }

    case 'send-nft': {
      const what = html`NFT ${tokenLink(chain, activity.token, data)} ${nftIds(activity.tokenIds, activity.amounts)}`;
      return activity.sentBy
        ? html`🚨 Списан ${what} → ${link(activity.to)}, транзакцию отправил ${link(activity.sentBy)}`
        : html`🖼 Отправлен ${what} → ${link(activity.to)}`;
    }
    case 'receive-nft':
      return html`🖼 Получен NFT ${tokenLink(chain, activity.token, data)} ${nftIds(activity.tokenIds, activity.amounts)} от ${link(activity.from)}`;

    case 'approval': {
      const token = tokenLink(chain, activity.token, data);
      if (activity.value === 0n) {
        return html`✅ Разрешение на ${token} для ${link(activity.spender)} отозвано`;
      }
      const via = activity.permit2
        ? html` через Permit2 до ${formatTime(activity.permit2.expiration * 1000)}`
        : '';
      return activity.unlimited
        ? html`🚨 Разрешение${via}: ${link(activity.spender)} может тратить <b>все</b> ваши ${token}`
        : html`⚠️ Разрешение${via}: ${link(activity.spender)} может тратить ${tokenAmount(chain, activity.token, activity.value, data)}`;
    }
    case 'nft-approval':
      return activity.importance === 'alert'
        ? html`⚠️ Разрешение: ${link(activity.spender)} может забрать NFT ${tokenLink(chain, activity.token, data)} #${activity.tokenId}`
        : html`✅ Разрешение на NFT ${tokenLink(chain, activity.token, data)} #${activity.tokenId} снято`;
    case 'approval-for-all':
      return activity.approved
        ? html`🚨 Разрешение: ${link(activity.operator)} может забрать <b>все</b> NFT коллекции ${tokenLink(chain, activity.token, data)}`
        : html`✅ Разрешение на коллекцию ${tokenLink(chain, activity.token, data)} для ${link(activity.operator)} отозвано`;
  }
};

export type TxGroup = {
  hash: Hash;
  watches: Watch[];
  items: Activity[];
  importance: Importance;
};

/** One message per transaction: what the chat's addresses did in it */
/** Lines per message; a transaction can touch hundreds of tokens */
const MAX_LINES = 12;
/** Telegram allows 4096 characters; links take more than they show */
const MAX_LENGTH = 3500;

const RANK = { alert: 0, outgoing: 1, incoming: 2 } as const;

/** One message per transaction: what the chat's addresses did in it, alerts first */
export const formatTx = (
  chain: ChainName,
  blockNumber: number,
  group: TxGroup,
  data: Enrichment,
  label: (address: Address) => string,
) => {
  const several = group.watches.length > 1;
  const title = group.watches.map(watchLabel).join(', ');
  const icon = group.importance === 'alert' ? '🚨' : '🔔';
  const lines = [...group.items]
    .sort((a, b) => RANK[a.importance] - RANK[b.importance])
    .map((item) => {
      const line = activityLine(chain, item, data);
      return several ? html`<b>${label(item.address)}</b>: ${line}` : line;
    });

  const build = (shown: number) =>
    joinHtml([
      html`${icon} <b>${title}</b> · ${CHAINS[chain].title}`,
      ...lines.slice(0, shown),
      shown < lines.length &&
        html`…и ещё ${lines.length - shown} в этой транзакции`,
      group.importance === 'alert' &&
        html`<i>Если это были не вы: отзовите разрешения (revoke.cash) и выведите средства на новый кошелёк.</i>`,
      html`${txLink(chain, group.hash)} · блок ${formatBlock(blockNumber)}`,
    ]);

  let shown = Math.min(lines.length, MAX_LINES);
  let message = build(shown);
  while (message.value.length > MAX_LENGTH && shown > 1) {
    shown -= 1;
    message = build(shown);
  }
  return message;
};
