import { getAddress, type Address } from 'viem';

import type { ChainName } from '../chains.js';

/**
 * USD prices of the native coin (token null) and of tokens on a chain. Null when the
 * price service did not answer, so a missing price is not mistaken for a worthless token.
 */
export type PriceLookup = (
  chain: ChainName,
  tokens: (Address | null)[],
) => Promise<Map<Address | null, number> | null>;

// DefiLlama names chains like this repository, and the native coin by its CoinGecko id
const NATIVE_COIN = 'coingecko:ethereum';

/** Prices below this confidence are DefiLlama's guesses, typical for spam tokens */
const MIN_CONFIDENCE = 0.8;
const MAX_CACHED = 20_000;
const BATCH = 30;

type LlamaResponse = {
  coins: Record<string, { price: number; confidence?: number }>;
};

const coinKey = (chain: ChainName, token: Address | null) =>
  token ? `${chain}:${getAddress(token)}` : NATIVE_COIN;

/**
 * Current prices from the DefiLlama coins API, cached for `ttlMs`. Failures give
 * no price instead of an error: an alert without a dollar amount is still an alert.
 */
export const priceLookup = ({
  url = 'https://coins.llama.fi/prices/current',
  fetchImpl = fetch,
  ttlMs = 5 * 60_000,
  timeoutMs = 5000,
  retryAfterMs = 60_000,
  now = Date.now,
}: {
  url?: string;
  fetchImpl?: typeof fetch;
  ttlMs?: number;
  timeoutMs?: number;
  /** After a failed request the service is left alone for this long */
  retryAfterMs?: number;
  now?: () => number;
} = {}): PriceLookup => {
  const cache = new Map<string, { at: number; price: number | null }>();
  let failedAt = -Infinity;

  const load = async (keys: string[]) => {
    if (cache.size >= MAX_CACHED) cache.clear();
    // Batches keep URLs short enough for the API
    for (let i = 0; i < keys.length; i += BATCH) {
      const batch = keys.slice(i, i + BATCH);
      const response = await fetchImpl(`${url}/${batch.join(',')}`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`prices: HTTP ${response.status}`);
      const { coins } = (await response.json()) as LlamaResponse;
      for (const key of batch) {
        const coin = coins[key];
        const price =
          coin && (coin.confidence ?? 1) >= MIN_CONFIDENCE ? coin.price : null;
        cache.set(key, { at: now(), price });
      }
    }
  };

  return async (chain, tokens) => {
    const keys = [...new Set(tokens.map((token) => coinKey(chain, token)))];
    const missing = keys.filter((key) => {
      const entry = cache.get(key);
      return !entry || now() - entry.at > ttlMs;
    });

    let failed = false;
    if (missing.length) {
      if (now() - failedAt < retryAfterMs) {
        failed = true;
      } else {
        // Keep whatever is cached; ask again after a pause
        await load(missing).catch(() => {
          failed = true;
          failedAt = now();
        });
      }
    }

    const prices = new Map<Address | null, number>();
    for (const token of tokens) {
      const price = cache.get(coinKey(chain, token))?.price;
      if (price !== undefined && price !== null) prices.set(token, price);
    }
    return failed && prices.size < tokens.length ? null : prices;
  };
};

/** USD value of an amount in the smallest units */
export const usdValue = (value: bigint, decimals: number, price: number) =>
  (Number(value) / 10 ** decimals) * price;
