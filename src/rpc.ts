import { fallback, http, type Transport } from 'viem';

const TIMEOUT_MS = 20_000;
const CHECK_TIMEOUT_MS = 10_000;

/** Only the host is ever shown or logged: RPC URLs often carry an API key in the path */
export const rpcHost = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return 'rpc';
  }
};

export type RpcTransport = {
  transport: Transport;
  /** Host of the RPC that answered last; null before the first answer */
  current(): string | null;
  /** Called with the client's transport, which reports every answer of a fallback */
  watch(clientTransport: unknown): void;
};

/**
 * RPCs of one chain in order of preference. With several, a request that fails or
 * times out on one goes to the next, so a free RPC hitting its limits does not stop
 * the scanner.
 */
export const rpcTransport = (urls: string[]): RpcTransport => {
  if (urls.length === 1) {
    const host = rpcHost(urls[0]!);
    return {
      transport: http(urls[0], { retryCount: 2, timeout: TIMEOUT_MS }),
      current: () => host,
      watch: () => undefined,
    };
  }

  let current: string | null = null;
  return {
    transport: fallback(
      urls.map((url) => http(url, { timeout: TIMEOUT_MS })),
      { retryCount: 2 },
    ),
    current: () => current,
    watch(clientTransport) {
      const { onResponse } = clientTransport as {
        onResponse?: (
          fn: (event: {
            status: 'success' | 'error';
            transport: { value?: { url?: string } };
          }) => void,
        ) => void;
      };
      onResponse?.(({ status, transport }) => {
        if (status === 'success' && transport.value?.url) {
          current = rpcHost(transport.value.url);
        }
      });
    },
  };
};

export type RpcCheck = {
  /** URLs to use: all but those that answered with another chain id */
  usable: string[];
  /** Hosts that serve another chain, with what they answered */
  wrong: { host: string; chainId: number }[];
};

/**
 * Asks every RPC for its chain id, so a URL of another network in the list is left
 * out. An RPC that does not answer now stays in: it may be back later.
 */
export const checkRpcs = async (
  urls: string[],
  chainId: number,
  fetchFn: typeof fetch = fetch,
): Promise<RpcCheck> => {
  const answers = await Promise.all(
    urls.map(async (url) => {
      try {
        const response = await fetchFn(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'eth_chainId',
            params: [],
          }),
          signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
        });
        const { result } = (await response.json()) as { result?: unknown };
        return typeof result === 'string' ? Number(BigInt(result)) : null;
      } catch {
        return null;
      }
    }),
  );
  const wrong = urls.flatMap((url, i) => {
    const answer = answers[i];
    return answer != null && answer !== chainId
      ? [{ host: rpcHost(url), chainId: answer }]
      : [];
  });
  const usable = urls.filter((_, i) => {
    const answer = answers[i];
    return answer == null || answer === chainId;
  });
  return { usable, wrong };
};
