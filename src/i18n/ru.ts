import { html } from '@dirai/tg-kit';

import type { Texts } from './en.js';

const pad = (n: number) => String(n).padStart(2, '0');

export const ru: Texts = {
  thousandsSeparator: ' ',
  time: (day, month, time) => `${pad(day)}.${pad(month + 1)} ${time} UTC`,
  transaction: 'Транзакция',

  start: (chains) =>
    [
      `Привет! Я слежу за адресами в ${chains}: переводы ETH, токенов и NFT, вызовы контрактов и разрешения на токены.`,
      'Добавьте свои кошельки, и вы узнаете о любой транзакции, которую не делали.',
      '',
      'Добавить адрес: /watch 0x… или /watch vitalik.eth',
      'Настройки: /settings · Все команды: /help',
    ].join('\n'),
  helpTitle: 'Команды:',
  startCommand: 'Начать',
  helpCommand: 'Список команд',
  forbidden: 'Эта команда вам недоступна.',
  adminsOnly: 'Это могут сделать только админы чата.',

  chainRetrying: (title) => html`🟠 ${title}: ошибка RPC, повторяю`,
  chainStarting: (title) => html`⚪ ${title}: запускается`,
  chainAt: (title, block, lag) =>
    html`🟢 ${title}: блок ${block}${lag ? `, отставание ${lag}` : ''}`,
  messagesCommand: 'Сообщения из транзакций: /messages on или off',
  messagesOn: html`✉️ Буду присылать текстовые сообщения, которые люди пишут в транзакциях.`,
  messagesOff: html`Сообщения из транзакций выключены.`,
  messagesState: (on) =>
    html`Сообщения из транзакций ${on ? 'включены' : 'выключены'}.\n<code>/messages ${on ? 'off' : 'on'}</code> — ${on ? 'выключить' : 'включить'}`,
  statusCommand: 'Что отслеживает чат и как работают сети',
  statusChat: html`<b>Этот чат</b>`,
  statusAddresses: (count) =>
    html`Адресов: ${count}${count ? '' : ' · добавить: /watch'}`,
  statusMessages: (on) =>
    html`Сообщения из транзакций: ${on ? 'включены' : 'выключены'}`,
  statusChains: html`<b>Сети</b>`,
  statsCommand: 'Статистика бота',
  statsTitle: html`<b>Статистика</b>`,
  statsChats: (count) => html`Чатов с адресами: ${count}`,
  statsAddresses: (count) => html`Уникальных адресов: ${count}`,
  statsMessageChats: (count) => html`Чатов с сообщениями: ${count}`,

  notAnAddress: 'Это не похоже на адрес: нужен 0x… из 40 символов или ENS-имя.',
  ensUnavailable: 'ENS-имена недоступны: боту не задан RPC Ethereum.',
  ensEmpty: (name) => `ENS-имя ${name} ни на что не указывает.`,
  ensFailed: (name) => `Не удалось разрешить ${name}, попробуйте позже.`,
  watchCommand: 'Следить за адресом: /watch 0x… [метка]',
  watchUsage: html`Пришлите адрес или ENS-имя и, если хотите, метку:\n<code>/watch 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 Виталик</code>\n<code>/watch vitalik.eth</code>`,
  watchLimit: html`В чате уже максимум адресов. Уберите лишние: /unwatch`,
  watchAdded: (name) =>
    html`👀 Слежу за ${name}. Сообщу о переводах ETH и токенов и о вызовах контрактов.`,
  watchRelabeled: (name) => html`✏️ Метка обновлена: ${name}`,
  unwatchCommand: 'Перестать следить: /unwatch 0x… или метка',
  unwatchUsage: html`Укажите адрес или метку: <code>/unwatch 0x…</code>`,
  unwatched: (label) => html`Больше не слежу за <b>${label}</b>.`,
  unwatchMissing: html`Такого адреса нет в списке. Посмотреть список: /list`,
  listCommand: 'Адреса, за которыми следит чат',
  listEmpty: html`Чат пока ни за кем не следит. Добавить адрес: /watch 0x…`,
  listTitle: (count) => html`<b>Адреса чата</b> (${count})`,
  mutedUntil: (time) => html` · 🔕 до ${time}`,
  notWatched: 'Чат больше не следит за этим адресом.',
  mute: (hours) => `🔕 Заглушить на ${hours} ч`,
  muteAddress: (label, hours) => `🔕 ${label} на ${hours} ч`,
  unmute: (label) => `🔔 Вернуть ${label}`,
  unmuted: (label) => `${label}: уведомления снова включены`,
  muted: (label, time) => `${label}: тишина до ${time}`,

  settingsCommand: 'Настройки уведомлений: сети, порог, тихие часы, сводка',
  saved: 'Сохранено',
  off: 'выкл',
  settingsTitle: html`⚙️ <b>Настройки уведомлений</b>`,
  settingsChains: (chains) => html`Сети: ${chains || 'ни одной'}`,
  settingsThreshold: (usd) =>
    html`Порог для входящих: ${usd ? `от $${usd}` : 'все'}`,
  settingsQuiet: (hours, zone) =>
    html`Тихие часы: ${hours} (${zone}), уведомления без звука`,
  settingsSpam: (hide) =>
    html`Спам: ${hide ? 'скрывать' : 'показывать с пометкой'}`,
  settingsMode: (digestAt) =>
    html`Режим: ${digestAt ? `входящие — сводкой в ${digestAt}` : 'каждая транзакция'}`,
  settingsDetails: (hidden) =>
    html`Детали: ${hidden ? 'под спойлером, в списке чатов видно только событие' : 'открыты'}`,
  settingsNote: html`<i>Исходящие переводы, разрешения на токены и списания не вами приходят всегда, со звуком и без порога.</i>`,
  fromUsd: (usd) => `от $${usd}`,
  allIncoming: 'Все входящие',
  noQuietHours: 'Без тихих часов',
  spamShown: 'Спам с пометкой',
  spamHidden: 'Скрывать спам',
  everyTransaction: 'Каждая транзакция',
  digestAt: (time) => `Сводка в ${time}`,
  settingsLanguage: html`Язык: русский`,
  detailsHidden: 'Детали под спойлером',
  detailsShown: 'Детали открыты',

  digestTitle: html`📋 <b>Сводка за сутки</b>`,
  digestEmpty: 'Входящих транзакций не было.',
  digestIncoming: (count) => `${count} входящих`,
  digestWorth: (usd) => ` на ~${usd}`,
  digestNote: html`<i>Исходящие транзакции и разрешения приходят сразу, не в сводке.</i>`,

  messageTitle: (block, chain) =>
    html`✉️ <b>Сообщение в блоке ${block}</b> · ${chain}`,
  toAddresses: (count) => ` → ${count} адресам`,
  moreMessages: (count, block, chain) =>
    html`…и ещё ${count} сообщений в блоке ${block} (${chain}): /v1/messages`,

  moreAlerts: (count, block, chain) =>
    html`🚨 …и ещё ${count} тревог в блоке ${block} (${chain}). Проверьте адреса в эксплорере.`,
  moreTransactions: (count, block, chain) =>
    html`…и ещё ${count} транзакций в блоке ${block} (${chain})`,
  eventOutgoing: 'исходящая',
  eventIncoming: 'входящая',
  eventApproval: 'разрешение на токены',
  eventTaken: 'списание не вами',
  eventAlert: 'требует внимания',
  moreInTx: (count) => html`…и ещё ${count} в этой транзакции`,
  advice: html`<i>Если это были не вы: отзовите разрешения (revoke.cash) и выведите средства на новый кошелёк.</i>`,
  block: (link, block) => html`${link} · блок ${block}`,
  units: 'ед.',
  andMore: (count) => `и ещё ${count}`,

  created: html`🧱 Создание контракта`,
  sent: (amount, to) => html`⬆️ Отправлено ${amount} → ${to}`,
  received: (amount, from) => html`⬇️ Получено ${amount} от ${from}`,
  call: (contract, method) => html`⚙️ Вызов ${contract}${method}`,
  calledBy: (caller, method) => html`⚙️ Вызов от ${caller}${method}`,
  method: (selector) => html` · метод <code>${selector}</code>`,
  methodHint: (selector, name, params) =>
    html` · метод <code>${selector}</code> (похоже на ${name}${params})`,
  fakeTransfer: (amount, to) =>
    html`⚠️ Поддельный перевод ${amount} → ${to} от вашего имени. Это address poisoning: не копируйте адрес получателя из истории`,
  taken: (amount, to, by) =>
    html`🚨 Списано ${amount} → ${to}, транзакцию отправил ${by}`,
  zeroTransferNote: ' · ⚠️ нулевой перевод, похоже на спам',
  unpricedNote: ' · ⚠️ токен без цены, возможно спам',
  nftTaken: (what, to, by) =>
    html`🚨 Списан ${what} → ${to}, транзакцию отправил ${by}`,
  nftSent: (what, to) => html`🖼 Отправлен ${what} → ${to}`,
  nftReceived: (what, from) => html`🖼 Получен ${what} от ${from}`,
  approvalRevoked: (token, spender) =>
    html`✅ Разрешение на ${token} для ${spender} отозвано`,
  viaPermit2: (time) => html` через Permit2 до ${time}`,
  approvalAll: (via, spender, token) =>
    html`🚨 Разрешение${via}: ${spender} может тратить <b>все</b> ваши ${token}`,
  approvalAmount: (via, spender, amount) =>
    html`⚠️ Разрешение${via}: ${spender} может тратить ${amount}`,
  nftApproval: (spender, token, id) =>
    html`⚠️ Разрешение: ${spender} может забрать NFT ${token} #${id}`,
  nftApprovalCleared: (token, id) =>
    html`✅ Разрешение на NFT ${token} #${id} снято`,
  approvalForAll: (operator, token) =>
    html`🚨 Разрешение: ${operator} может забрать <b>все</b> NFT коллекции ${token}`,
  approvalForAllRevoked: (token, operator) =>
    html`✅ Разрешение на коллекцию ${token} для ${operator} отозвано`,
  fakeTokenNote:
    ' · ⚠️ у вас нет этого токена, похоже на подделку: ничего не пропало',

  all: 'все',
  yes: 'да',
  no: 'нет',
  items: (count) => `[${count} шт.]`,
  bytes: (start, count) => `${start}… (${count} байт)`,
};
