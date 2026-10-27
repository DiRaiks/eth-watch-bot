import { html, type Html } from '@dirai-kit/tg';
import type { Context } from 'grammy';
import { formatUnits } from 'viem';

import { addressUrl, txUrl, type ChainName } from './chains.js';
import { t } from './i18n/index.js';

export const shortAddress = (address: string) =>
  `${address.slice(0, 6)}…${address.slice(-4)}`;

export const groupThousands = (integer: string) =>
  integer.replace(/\B(?=(\d{3})+(?!\d))/g, t.thousandsSeparator);

/**
 * Human amount: up to 4 decimals for amounts of 1 and more, 4 significant digits for
 * smaller ones, thousands separated by spaces
 */
export const formatAmount = (value: bigint, decimals: number) => {
  const [integer = '0', fraction = ''] = formatUnits(value, decimals).split(
    '.',
  );
  let shown: string;
  if (integer !== '0') {
    shown = fraction.slice(0, 4);
  } else {
    const leadingZeros = fraction.match(/^0*/)?.[0].length ?? 0;
    shown = fraction.slice(0, leadingZeros + 4);
  }
  shown = shown.replace(/0+$/, '');
  return shown
    ? `${groupThousands(integer)}.${shown}`
    : groupThousands(integer);
};

export const addressLink = (chain: ChainName, address: string): Html =>
  html`<a href="${addressUrl(chain, address)}">${shortAddress(address)}</a>`;

export const txLink = (
  chain: ChainName,
  hash: string,
  label = t.transaction,
): Html => html`<a href="${txUrl(chain, hash)}">${label}</a>`;

export const formatBlock = (number: number) => groupThousands(String(number));

/** "25 Oct 14:00 UTC", "25.10 14:00 UTC" */
export const formatTime = (ms: number) => {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return t.time(
    date.getUTCDate(),
    date.getUTCMonth(),
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`,
  );
};

/** "26.10 02:16" in the chat's zone, for when a block was made */
export const formatLocalTime = (ms: number, timeZone: string) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      day: 'numeric',
      month: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(ms)
      .map((part) => [part.type, part.value]),
  );
  return t.localTime(
    Number(parts.day),
    Number(parts.month) - 1,
    `${parts.hour}:${parts.minute}`,
  );
};

/** Cuts by code points, so emoji and other surrogate pairs stay whole */
export const truncate = (text: string, max: number) => {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
};

/** Replies with HTML markup and without link previews */
export const replyHtml = (
  ctx: Context,
  message: Html,
  other: Parameters<Context['reply']>[1] = {},
) =>
  ctx.reply(message.value, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...other,
  });
