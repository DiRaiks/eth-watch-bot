import { toFunctionSelector, type Hex } from 'viem';

/** Methods worth recognising without a network call; selectors are computed, not copied */
const KNOWN_SIGNATURES = [
  // ERC-20 / ERC-721 / ERC-1155: transfers and approvals
  'transfer(address,uint256)',
  'transferFrom(address,address,uint256)',
  'approve(address,uint256)',
  'increaseAllowance(address,uint256)',
  'permit(address,address,uint256,uint256,uint8,bytes32,bytes32)',
  'setApprovalForAll(address,bool)',
  'safeTransferFrom(address,address,uint256)',
  'safeTransferFrom(address,address,uint256,bytes)',
  'safeTransferFrom(address,address,uint256,uint256,bytes)',
  'safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)',
  // Uniswap Permit2
  'approve(address,address,uint160,uint48)',
  'permit(address,((address,uint160,uint48,uint48),address,uint256),bytes)',
  // WETH and vaults
  'deposit()',
  'withdraw(uint256)',
  // Routers and wallets
  'multicall(bytes[])',
  'multicall(uint256,bytes[])',
  'execute(bytes,bytes[],uint256)',
  'execute(bytes,bytes[])',
  'swapExactETHForTokens(uint256,address[],address,uint256)',
  'swapExactTokensForTokens(uint256,uint256,address[],address,uint256)',
  'swapExactTokensForETH(uint256,uint256,address[],address,uint256)',
  'execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)',
] as const;

const SAFE_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

const nameOf = (signature: string) =>
  signature.slice(0, signature.indexOf('('));

const KNOWN = new Map<Hex, string>(
  KNOWN_SIGNATURES.map((signature) => [
    toFunctionSelector(signature),
    nameOf(signature),
  ]),
);

/** Methods that hand control over tokens to someone else */
export const RISKY_METHODS = new Set([
  'approve',
  'increaseAllowance',
  'permit',
  'setApprovalForAll',
]);

export type MethodName = {
  name: string;
  /** False for names from the public database: anyone can register a misleading one */
  trusted: boolean;
};

export type SignatureLookup = (selector: Hex) => Promise<MethodName | null>;

type OpenchainResponse = {
  ok: boolean;
  result?: {
    function?: Record<
      string,
      | { name: string; filtered: boolean; hasVerifiedContract?: boolean }[]
      | null
    >;
  };
};

/**
 * Names a method selector: from the built-in list, or from the openchain signature
 * database, taking only signatures seen in verified contracts. Results are cached.
 */
export const signatureLookup = ({
  remote = true,
  url = 'https://api.openchain.xyz/signature-database/v1/lookup',
  fetchImpl = fetch,
  timeoutMs = 3000,
  maxCached = 10_000,
  retryAfterMs = 60_000,
  now = Date.now,
}: {
  remote?: boolean;
  url?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxCached?: number;
  /** After a failed request the service is left alone for this long */
  retryAfterMs?: number;
  now?: () => number;
} = {}): SignatureLookup => {
  const cache = new Map<Hex, Promise<MethodName | null>>();
  let failedAt = -Infinity;

  const fetchName = async (selector: Hex): Promise<MethodName | null> => {
    const response = await fetchImpl(
      `${url}?function=${selector}&filter=true`,
      {
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!response.ok)
      throw new Error(`signature lookup: HTTP ${response.status}`);
    const body = (await response.json()) as OpenchainResponse;
    const match = body.result?.function?.[selector]?.find(
      (entry) => !entry.filtered && entry.hasVerifiedContract,
    );
    const name = match && nameOf(match.name);
    // Names come from a public database: plain identifiers only, nothing to mislead with
    return name && SAFE_NAME.test(name) ? { name, trusted: false } : null;
  };

  return async (selector) => {
    const known = KNOWN.get(selector);
    if (known) return { name: known, trusted: true };
    if (!remote) return null;

    const cached = cache.get(selector);
    if (cached) return cached;
    if (now() - failedAt < retryAfterMs) return null;
    if (cache.size >= maxCached) cache.clear();
    const lookup = fetchName(selector).catch(() => {
      // A network error is not an answer: ask again later, and spare the service meanwhile
      cache.delete(selector);
      failedAt = now();
      return null;
    });
    cache.set(selector, lookup);
    return lookup;
  };
};
