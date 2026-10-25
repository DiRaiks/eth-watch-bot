import type { Api } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { pad, toHex, type Address, type Hash, type Hex } from 'viem';

import { buildApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import type { PriceLookup } from '../src/enrich/prices.js';
import type { SignatureLookup } from '../src/enrich/signatures.js';
import type { TokenLog } from '../src/scanner/token-logs.js';
import type {
  ChainReader,
  ScannedBlock,
  ScannedTransaction,
  TokenInfo,
  TxReceipt,
} from '../src/scanner/types.js';
import { memoryStores, type Stores } from '../src/storage.js';

export const ADMIN_ID = 100;
export const ALICE = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' as Address;
export const BOB = '0x00000000219ab540356cBB839Cbe05303d7705Fa' as Address;
export const CAROL = '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84' as Address;
export const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address;

export const BOT_INFO: UserFromGetMe = {
  id: 1,
  is_bot: true,
  first_name: 'Watch bot',
  username: 'watch_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

export const blockHash = (number: number) => pad(toHex(number)) as Hash;
export const txHash = (n: number) => pad(toHex(1_000_000 + n)) as Hash;

/** A token log as the chain would return it, minus the position in the block */
export type NewLog = TokenLog extends infer T
  ? T extends TokenLog
    ? Omit<T, 'logIndex'>
    : never
  : never;

export const erc20 = (
  n: number,
  fields: { from: Address; to: Address; value: bigint; token?: Address },
): NewLog => ({
  type: 'erc20',
  token: USDC,
  transactionHash: txHash(n),
  ...fields,
});

export const tx = (
  n: number,
  fields: Partial<ScannedTransaction> = {},
): ScannedTransaction => ({
  hash: txHash(n),
  from: BOB,
  to: CAROL,
  value: 0n,
  input: '0x',
  ...fields,
});

/** An in-memory chain: blocks are empty unless added */
export const fakeChain = (chainId = 1) => {
  let head = 0;
  const blocks = new Map<number, ScannedBlock>();
  const logs = new Map<Hash, TokenLog[]>();
  const tokens = new Map<Address, TokenInfo>([
    [USDC, { symbol: 'USDC', decimals: 6 }],
  ]);
  const fetched: number[] = [];
  /** Token balances by `${token}:${owner}`; unknown pairs hold 1, null means no answer */
  const balances = new Map<string, bigint | null>();
  const balanceCalls: { token: Address; owner: Address; block: number }[] = [];
  // Receipts, native balances and contracts answer only when a test sets them
  const receipts = new Map<Hash, TxReceipt>();
  const nativeBalances = new Map<string, bigint>();
  const contracts = new Set<string>();
  const unknown = () => Promise.reject(new Error('not set in this test'));

  const block = (number: number): ScannedBlock =>
    blocks.get(number) ?? {
      number,
      hash: blockHash(number),
      timestamp: 1_700_000_000 + number,
      transactions: [],
    };

  const reader: ChainReader = {
    getChainId: async () => chainId,
    getBlockNumber: async () => head,
    getBlock: async (number) => {
      fetched.push(number);
      return block(number);
    },
    getTokenLogs: async (hash) => logs.get(hash) ?? [],
    getTokenBalance: async (token, owner, block) => {
      balanceCalls.push({ token, owner, block });
      const key = `${token.toLowerCase()}:${owner.toLowerCase()}`;
      return balances.has(key) ? balances.get(key)! : 1n;
    },
    getTokenInfo: async (token) =>
      tokens.get(token) ?? { symbol: '', decimals: null },
    getReceipt: (hash) => {
      const receipt = receipts.get(hash);
      return receipt ? Promise.resolve(receipt) : unknown();
    },
    getBalance: (address) => {
      const balance = nativeBalances.get(address.toLowerCase());
      return balance === undefined ? unknown() : Promise.resolve(balance);
    },
    isContract: async (address) => contracts.has(address.toLowerCase()),
  };

  return {
    reader,
    fetched,
    balanceCalls,
    setBalance(token: Address, owner: Address, balance: bigint | null) {
      balances.set(`${token.toLowerCase()}:${owner.toLowerCase()}`, balance);
    },
    setReceipt(hash: Hash, receipt: TxReceipt) {
      receipts.set(hash, receipt);
    },
    setNativeBalance(address: Address, balance: bigint) {
      nativeBalances.set(address.toLowerCase(), balance);
    },
    addContract(address: Address) {
      contracts.add(address.toLowerCase());
    },
    setHead(number: number) {
      head = number;
    },
    addBlock(
      number: number,
      transactions: ScannedTransaction[],
      tokenLogs: NewLog[] = [],
    ) {
      blocks.set(number, { ...block(number), transactions });
      logs.set(
        blockHash(number),
        tokenLogs.map((log, logIndex) => ({ ...log, logIndex }) as TokenLog),
      );
    },
  };
};

export type ApiCall = { method: string; payload: Record<string, unknown> };

export const fakeApi = (respond: (call: ApiCall) => unknown = () => true) => {
  const calls: ApiCall[] = [];
  let messageId = 0;

  const configureApi = (api: Api) => {
    api.config.use(async (_prev, method, payload) => {
      const call = { method, payload: payload as Record<string, unknown> };
      calls.push(call);
      const custom = respond(call);
      const result =
        method === 'sendMessage' && custom === true
          ? {
              message_id: ++messageId,
              date: 0,
              chat: { id: call.payload.chat_id, type: 'private' },
            }
          : custom;
      return { ok: true, result } as never;
    });
  };

  return {
    calls,
    configureApi,
    sent: () => calls.filter((c) => c.method === 'sendMessage'),
    texts: () =>
      calls
        .filter((c) => c.method === 'sendMessage')
        .map((c) => String(c.payload.text)),
    clear: () => {
      calls.length = 0;
    },
  };
};

export const testConfig = (overrides: Partial<Config> = {}): Config => ({
  port: 0,
  host: '127.0.0.1',
  logLevel: 'silent',
  trustProxy: false,
  corsOrigins: [],
  bot: { token: 'test-token', mode: 'polling', admins: [ADMIN_ID] },
  chains: [{ name: 'ethereum', rpcUrls: ['http://rpc'], confirmations: 0 }],
  messagesChains: ['ethereum'],
  pollIntervalMs: 1000,
  maxBlocksPerTick: 50,
  maxLagBlocks: 1000,
  maxWatchesPerChat: 20,
  signatureLookup: false,
  prices: false,
  language: 'ru',
  bootstrap: { addresses: [], messages: false },
  ...overrides,
});

export const buildTestApp = async ({
  config = testConfig(),
  stores = memoryStores(),
  respond,
  chain = fakeChain(),
  resolveName,
  methods,
  prices = null,
  now,
}: {
  methods?: SignatureLookup;
  prices?: PriceLookup | null;
  now?: () => number;
  config?: Config;
  stores?: Stores;
  respond?: (call: ApiCall) => unknown;
  chain?: ReturnType<typeof fakeChain>;
  resolveName?: (name: string) => Promise<Address | null>;
} = {}) => {
  const api = fakeApi(respond);
  const built = await buildApp({
    config,
    stores,
    readers: { ethereum: chain.reader },
    resolveName,
    methods,
    prices,
    now,
    logger: false,
    startScanners: false,
    bot: { mode: 'none', botInfo: BOT_INFO, configureApi: api.configureApi },
    notifier: { minIntervalMs: 0 },
  });
  await built.app.ready();
  const scanner = built.scanners[0]!;
  return { ...built, api, chain, stores, scanner };
};

let updateId = 0;

type ChatOptions = {
  chatId?: number;
  userId?: number;
  chatType?: 'private' | 'group';
};

const chat = (chatId: number, chatType: 'private' | 'group') =>
  chatType === 'private'
    ? { id: chatId, type: 'private' as const, first_name: 'U' }
    : { id: chatId, type: 'group' as const, title: 'G' };

export const message = (
  text: string,
  { chatId = 10, userId = 20, chatType = 'private' }: ChatOptions = {},
): Update => ({
  update_id: ++updateId,
  message: {
    message_id: updateId,
    date: 0,
    chat: chat(chatId, chatType),
    from: { id: userId, is_bot: false, first_name: 'U' },
    text,
    entities: text.startsWith('/')
      ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }]
      : [],
  },
});

export const callback = (
  data: string,
  keyboard: { text: string; callback_data: string }[][],
  { chatId = 10, userId = 20, chatType = 'private' }: ChatOptions = {},
): Update => ({
  update_id: ++updateId,
  callback_query: {
    id: String(updateId),
    from: { id: userId, is_bot: false, first_name: 'U' },
    chat_instance: '1',
    data,
    message: {
      message_id: 1,
      date: 0,
      chat: chat(chatId, chatType),
      text: 'notification',
      reply_markup: { inline_keyboard: keyboard },
    },
  },
});

/** Hex of a UTF-8 string, as wallets put messages into transaction input */
export const textInput = (text: string) =>
  toHex(new TextEncoder().encode(text)) as Hex;
