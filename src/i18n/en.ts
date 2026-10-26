import { html, type Html } from '@dirai/tg-kit';

/** A piece of a message: escaped text or ready markup */
type Part = Html | string;

/** "1 message", "2 messages" */
const count = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

export const en = {
  thousandsSeparator: ',',
  /** "25 Oct 14:00 UTC" */
  time: (day: number, month: number, time: string) =>
    `${day} ${MONTHS[month]} ${time} UTC`,
  localTime: (day: number, month: number, time: string) =>
    `${day} ${MONTHS[month]} ${time}`,
  transaction: 'Transaction',

  // tg-kit and /start
  start: (chains: string) =>
    [
      `Hi! I watch addresses on ${chains}: ETH, token and NFT transfers, contract calls and token approvals.`,
      'Add your wallets, and you will hear about any transaction you did not make.',
      '',
      'Add an address: /watch 0x… or /watch vitalik.eth',
      'Settings: /settings · All commands: /help',
    ].join('\n'),
  helpTitle: 'Commands:',
  startCommand: 'Start',
  helpCommand: 'List of commands',
  forbidden: 'This command is not available to you.',
  adminsOnly: 'Only chat admins can do this.',

  // /status, /stats, /messages
  chainRetrying: (title: string) => html`🟠 ${title}: RPC error, retrying`,
  chainStarting: (title: string) => html`⚪ ${title}: starting`,
  chainAt: (title: string, block: string, lag: number | null) =>
    html`🟢 ${title}: block ${block}${lag ? `, ${lag} behind` : ''}`,
  messagesCommand: 'Messages from transactions: /messages on or off',
  messagesOn: html`✉️ I will post the text messages people write in transactions.`,
  messagesOff: html`Messages from transactions are off.`,
  messagesState: (on: boolean) =>
    html`Messages from transactions are ${on ? 'on' : 'off'}.\n<code>/messages ${on ? 'off' : 'on'}</code> to turn them ${on ? 'off' : 'on'}`,
  statusCommand: 'What this chat watches and how the chains are doing',
  statusChat: html`<b>This chat</b>`,
  statusAddresses: (count: number) =>
    html`Addresses: ${count}${count ? '' : ' · add one: /watch'}`,
  statusMessages: (on: boolean) =>
    html`Messages from transactions: ${on ? 'on' : 'off'}`,
  statusChains: html`<b>Chains</b>`,
  statsCommand: 'Bot statistics',
  healthCommand: 'Service health',
  healthTitle: html`🩺 <b>Service health</b>`,
  uptime: (days: number, hours: number, minutes: number) =>
    days
      ? `${days} d ${hours} h`
      : hours
        ? `${hours} h ${minutes} min`
        : `${minutes} min`,
  healthProcess: (uptime: string, memoryMb: number) =>
    html`Up for ${uptime} · memory ${memoryMb} MB`,
  healthDb: (ms: number) => html`Database: ✅ Postgres, answered in ${ms} ms`,
  healthDbDown: html`Database: 🔴 not answering`,
  healthDbMemory: html`Database: ⚪ none, all in memory`,
  healthTelegram: (ok: boolean, mode: string, queue: number) =>
    html`Telegram: ${ok ? '✅' : '🔴'} ${mode}, ${queue} queued`,
  healthSent: (alerts: number, outgoing: number, incoming: number) =>
    html`Notifications since start: 🚨 ${alerts} · ⬆️ ${outgoing} · ⬇️ ${incoming}`,
  healthFound: (count: number) =>
    html`Messages from transactions since start: ${count}`,
  statsTitle: html`<b>Statistics</b>`,
  statsChats: (count: number) => html`Chats with addresses: ${count}`,
  statsAddresses: (count: number) => html`Unique addresses: ${count}`,
  statsMessageChats: (count: number) => html`Chats with messages: ${count}`,

  // /watch, /unwatch, /list, mute buttons
  notAnAddress:
    'This does not look like an address: send a 0x… of 40 characters or an ENS name.',
  ensUnavailable: 'ENS names are unavailable: the bot has no Ethereum RPC.',
  ensEmpty: (name: string) => `The ENS name ${name} points nowhere.`,
  ensFailed: (name: string) => `Could not resolve ${name}, try again later.`,
  watchCommand: 'Watch an address: /watch 0x… [label]',
  watchUsage: html`Send an address or an ENS name and, if you like, a label:\n<code>/watch 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 Vitalik</code>\n<code>/watch vitalik.eth</code>`,
  watchLimit: html`The chat watches the maximum number of addresses. Remove some: /unwatch`,
  watchAdded: (name: Html) =>
    html`👀 Watching ${name}. I will report ETH and token transfers and contract calls.`,
  watchRelabeled: (name: Html) => html`✏️ Label updated: ${name}`,
  unwatchCommand: 'Stop watching: /unwatch 0x… or a label',
  unwatchUsage: html`Name an address or a label: <code>/unwatch 0x…</code>`,
  unwatched: (label: string) => html`No longer watching <b>${label}</b>.`,
  unwatchMissing: html`No such address in the list. See the list: /list`,
  listCommand: 'Addresses this chat watches',
  listEmpty: html`The chat watches nothing yet. Add an address: /watch 0x…`,
  listTitle: (count: number) => html`<b>Chat addresses</b> (${count})`,
  mutedUntil: (time: string) => html` · 🔕 until ${time}`,
  notWatched: 'The chat no longer watches this address.',
  mute: (hours: number) => `🔕 Mute for ${hours} h`,
  muteAddress: (label: string, hours: number) => `🔕 ${label} for ${hours} h`,
  unmute: (label: string) => `🔔 Unmute ${label}`,
  unmuted: (label: string) => `${label}: notifications are back on`,
  muted: (label: string, time: string) => `${label}: silent until ${time}`,

  // /settings
  settingsCommand:
    'Notification settings: chains, threshold, quiet hours, digest',
  saved: 'Saved',
  off: 'off',
  settingsTitle: html`⚙️ <b>Notification settings</b>`,
  settingsChains: (chains: string) => html`Chains: ${chains || 'none'}`,
  settingsThreshold: (usd: number) =>
    html`Incoming threshold: ${usd ? `from $${usd}` : 'all'}`,
  settingsQuiet: (hours: string, zone: string) =>
    html`Quiet hours: ${hours} (${zone}), notifications without a sound`,
  settingsSpam: (hide: boolean) =>
    html`Spam: ${hide ? 'hidden' : 'shown with a warning'}`,
  settingsMode: (digestAt: string | null) =>
    html`Mode: ${digestAt ? `incoming in a digest at ${digestAt}` : 'every transaction'}`,
  settingsDetails: (hidden: boolean) =>
    html`Details: ${hidden ? 'under a spoiler, the chat list shows only the event' : 'shown'}`,
  settingsNote: html`<i>Outgoing transfers, token approvals and transfers out of your address that you did not send always arrive, with a sound and no threshold.</i>`,
  fromUsd: (usd: number) => `from $${usd}`,
  allIncoming: 'All incoming',
  noQuietHours: 'No quiet hours',
  spamShown: 'Spam with a warning',
  spamHidden: 'Hide spam',
  everyTransaction: 'Every transaction',
  digestAt: (time: string) => `Digest at ${time}`,
  settingsLanguage: html`Language: English`,
  detailsHidden: 'Details under a spoiler',
  detailsShown: 'Details shown',

  // Daily digest
  digestTitle: html`📋 <b>Daily digest</b>`,
  digestEmpty: 'No incoming transactions.',
  digestIncoming: (count: number) => `${count} incoming`,
  digestWorth: (usd: string) => ` worth ~${usd}`,
  digestNote: html`<i>Outgoing transactions and approvals arrive at once, not in the digest.</i>`,

  // Text messages from transactions
  messageTitle: (block: string, chain: string) =>
    html`✉️ <b>Message in block ${block}</b> · ${chain}`,
  toAddresses: (n: number) => ` → ${count(n, 'address', 'addresses')}`,
  moreMessages: (n: number, block: string, chain: string) =>
    html`…and ${count(n, 'more message')} in block ${block} (${chain}): /v1/messages`,

  // Address alerts
  moreAlerts: (n: number, block: string, chain: string) =>
    html`🚨 …and ${count(n, 'more alert')} in block ${block} (${chain}). Check the addresses in an explorer.`,
  moreTransactions: (n: number, block: string, chain: string) =>
    html`…and ${count(n, 'more transaction')} in block ${block} (${chain})`,
  eventOutgoing: 'outgoing',
  eventIncoming: 'incoming',
  eventApproval: 'token approval',
  eventTaken: 'taken without you',
  eventAlert: 'needs attention',
  moreInTx: (count: number) => html`…and ${count} more in this transaction`,
  advice: html`<i>If this was not you: revoke the approvals (revoke.cash) and move the funds to a new wallet.</i>`,
  block: (link: Html, block: string, time?: string | null) =>
    html`${link} · block ${block}${time ? ` · ${time}` : ''}`,
  eventFailed: ' · ❌ failed',
  txFailed: html`❌ <b>The transaction failed</b>: no coins or tokens moved, the fee was paid`,
  fee: (amount: Part) => html`⛽ Fee ${amount}`,
  balance: (label: string | null, amount: Part) =>
    html`💰 Balance${label ? html` ${label}` : ''}: ${amount}`,
  contractNote: ' (contract)',
  firstTimeNote: ' · 🆕 first time',
  revoke: (url: string) =>
    html`🧹 <a href="${url}">Review and revoke approvals</a> on revoke.cash`,
  units: 'units',
  andMore: (count: number) => `and ${count} more`,

  created: html`🧱 Contract created`,
  sent: (amount: Part, to: Html) => html`⬆️ Sent ${amount} → ${to}`,
  received: (amount: Part, from: Html) =>
    html`⬇️ Received ${amount} from ${from}`,
  call: (contract: Html, method: Part) => html`⚙️ Call to ${contract}${method}`,
  calledBy: (caller: Html, method: Part) =>
    html`⚙️ Call from ${caller}${method}`,
  method: (selector: string) => html` · method <code>${selector}</code>`,
  methodHint: (selector: string, name: string, params: Part) =>
    html` · method <code>${selector}</code> (looks like ${name}${params})`,
  fakeTransfer: (amount: Part, to: Html) =>
    html`⚠️ Fake transfer of ${amount} → ${to} in your name. This is address poisoning: do not copy the recipient's address from your history`,
  taken: (amount: Part, to: Html, by: Html) =>
    html`🚨 Pulled out ${amount} → ${to} in a transaction sent by ${by}`,
  zeroTransferNote: ' · ⚠️ a zero transfer, likely spam',
  unpricedNote: ' · ⚠️ a token without a price, possibly spam',
  nftTaken: (what: Html, to: Html, by: Html) =>
    html`🚨 Pulled out ${what} → ${to} in a transaction sent by ${by}`,
  nftSent: (what: Html, to: Html) => html`🖼 Sent ${what} → ${to}`,
  nftReceived: (what: Html, from: Html) =>
    html`🖼 Received ${what} from ${from}`,
  approvalRevoked: (token: Html, spender: Html) =>
    html`✅ Approval of ${token} for ${spender} revoked`,
  viaPermit2: (time: string) => html` via Permit2 until ${time}`,
  approvalAll: (via: Part, spender: Html, token: Html) =>
    html`🚨 Approval${via}: ${spender} can spend <b>all</b> your ${token}`,
  approvalAmount: (via: Part, spender: Html, amount: Html) =>
    html`⚠️ Approval${via}: ${spender} can spend ${amount}`,
  nftApproval: (spender: Html, token: Html, id: bigint) =>
    html`⚠️ Approval: ${spender} can take NFT ${token} #${id}`,
  nftApprovalCleared: (token: Html, id: bigint) =>
    html`✅ Approval of NFT ${token} #${id} cleared`,
  approvalForAll: (operator: Html, token: Html) =>
    html`🚨 Approval: ${operator} can take <b>all</b> NFTs of the ${token} collection`,
  approvalForAllRevoked: (token: Html, operator: Html) =>
    html`✅ Approval of the ${token} collection for ${operator} revoked`,
  imitationNote: (ticker: string) => ` · ⚠️ a fake ${ticker}`,
  lookalikeNote: (original: Html) =>
    html` · ⚠️ looks like ${original} but is another address: do not copy it from your history`,
  fakeTokenNote:
    ' · ⚠️ you do not hold this token, likely a forgery: nothing was lost',

  // Call parameters
  all: 'all',
  yes: 'yes',
  no: 'no',
  items: (n: number) => `[${count(n, 'item')}]`,
  bytes: (start: string, n: number) => `${start}… (${count(n, 'byte')})`,
};

export type Texts = typeof en;
