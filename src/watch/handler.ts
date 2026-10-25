import { html, joinHtml, type Html, type SendOptions } from '@dirai/tg-kit';
import { InlineKeyboard } from 'grammy';
import type { Address, Hash } from 'viem';

import { addressUrl, CHAINS, type ChainName } from '../chains.js';
import {
  addressLink,
  formatAmount,
  formatBlock,
  shortAddress,
  txLink,
} from '../format.js';
import type {
  BlockHandler,
  ScannedTransaction,
  TokenInfo,
  TransferLog,
} from '../scanner/types.js';
import type { Watch, WatchService } from './watch-service.js';

/** Sends a message to one chat; false when it was not delivered */
export type Deliver = (
  chatId: number,
  message: Html,
  options?: SendOptions,
) => Promise<boolean>;

/** Above this many transactions per chat in one block the rest is summarised */
export const MAX_MESSAGES_PER_BLOCK = 5;
export const MUTE_HOURS = 24;

type Group = {
  chatId: number;
  hash: Hash;
  watches: Watch[];
  lines: { watch: Watch; line: Html }[];
};

export const watchLabel = (watch: Watch) =>
  watch.label ?? shortAddress(watch.address);

const nativeLines = (chain: ChainName, tx: ScannedTransaction) => {
  const amount = html`<b>${formatAmount(tx.value, 18)} ${CHAINS[chain].nativeSymbol}</b>`;
  const method =
    tx.input.length >= 10
      ? html` · метод <code>${tx.input.slice(0, 10)}</code>`
      : '';

  const outgoing = !tx.to
    ? html`🧱 Создание контракта`
    : tx.value > 0n
      ? html`⬆️ Отправлено ${amount} → ${addressLink(chain, tx.to)}`
      : html`⚙️ Вызов контракта ${addressLink(chain, tx.to)}${method}`;

  const incoming =
    tx.value > 0n
      ? html`⬇️ Получено ${amount} от ${addressLink(chain, tx.from)}`
      : html`⚙️ Вызов от ${addressLink(chain, tx.from)}${method}`;

  return { outgoing, incoming };
};

const tokenAmount = (chain: ChainName, log: TransferLog, info: TokenInfo) => {
  const symbol = info.symbol || shortAddress(log.token);
  const value =
    info.decimals === null
      ? `${log.value.toString()} ед.`
      : formatAmount(log.value, info.decimals);
  return html`<b>${value}</b> <a href="${addressUrl(chain, log.token)}">${symbol}</a>`;
};

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

const formatGroup = (chain: ChainName, blockNumber: number, group: Group) => {
  const several = group.watches.length > 1;
  const title = group.watches.map(watchLabel).join(', ');
  return joinHtml([
    html`🔔 <b>${title}</b> · ${CHAINS[chain].title}`,
    ...group.lines.map(({ watch, line }) =>
      several ? html`<b>${watchLabel(watch)}</b>: ${line}` : line,
    ),
    html`${txLink(chain, group.hash)} · блок ${formatBlock(blockNumber)}`,
  ]);
};

/**
 * Reports native transfers, contract calls and ERC-20 transfers of watched addresses.
 * Each chat gets one message per transaction, listing everything its addresses did in it.
 */
export const addressWatchHandler = ({
  watches,
  deliver,
}: {
  watches: WatchService;
  deliver: Deliver;
}): BlockHandler => ({
  name: 'address-watch',
  wants: () => watches.hasWatches(),

  async handleBlock(chain, block, reader) {
    const groups = new Map<string, Group>();
    const add = (chatId: number, hash: Hash, watch: Watch, line: Html) => {
      const id = `${chatId}:${hash}`;
      const group = groups.get(id) ?? { chatId, hash, watches: [], lines: [] };
      if (!group.watches.some((w) => w.address === watch.address)) {
        group.watches.push(watch);
      }
      group.lines.push({ watch, line });
      groups.set(id, group);
    };

    for (const tx of block.transactions) {
      const from = watches.watchers(tx.from);
      const to = tx.to ? watches.watchers(tx.to) : [];
      if (!from.length && !to.length) continue;
      const lines = nativeLines(chain, tx);
      for (const { chatId, watch } of from)
        add(chatId, tx.hash, watch, lines.outgoing);
      for (const { chatId, watch } of to)
        add(chatId, tx.hash, watch, lines.incoming);
    }

    const logs = (await reader.getTransferLogs(block.hash)).filter(
      (log) =>
        watches.watchers(log.from).length || watches.watchers(log.to).length,
    );
    const tokens = new Map<Address, TokenInfo>();
    await Promise.all(
      [...new Set(logs.map((log) => log.token))].map(async (token) => {
        tokens.set(token, await reader.getTokenInfo(token));
      }),
    );
    for (const log of logs) {
      const amount = tokenAmount(chain, log, tokens.get(log.token)!);
      for (const { chatId, watch } of watches.watchers(log.from)) {
        add(
          chatId,
          log.transactionHash,
          watch,
          html`⬆️ Отправлено ${amount} → ${addressLink(chain, log.to)}`,
        );
      }
      for (const { chatId, watch } of watches.watchers(log.to)) {
        add(
          chatId,
          log.transactionHash,
          watch,
          html`⬇️ Получено ${amount} от ${addressLink(chain, log.from)}`,
        );
      }
    }

    const byChat = new Map<number, Group[]>();
    for (const group of groups.values()) {
      byChat.set(group.chatId, [...(byChat.get(group.chatId) ?? []), group]);
    }

    let undelivered = false;
    for (const [chatId, chatGroups] of byChat) {
      for (const group of chatGroups.slice(0, MAX_MESSAGES_PER_BLOCK)) {
        const ok = await deliver(
          chatId,
          formatGroup(chain, block.number, group),
          {
            replyMarkup: muteKeyboard(group.watches),
          },
        );
        undelivered ||= !ok;
      }
      const rest = chatGroups.length - MAX_MESSAGES_PER_BLOCK;
      if (rest > 0) {
        const ok = await deliver(
          chatId,
          html`…и ещё ${rest} транзакций в блоке ${formatBlock(block.number)} (${CHAINS[chain].title})`,
          { silent: true },
        );
        undelivered ||= !ok;
      }
    }
    // The notifier unsubscribes chats that blocked the bot and follows migrated groups
    if (undelivered) await watches.load();
  },
});
