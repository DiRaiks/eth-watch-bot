import { toFunctionSelector, type Hex } from 'viem';

/**
 * Methods worth recognising without a network call; selectors are computed, not copied.
 * Parameter names are shown in messages, so they describe what the value means.
 */
const KNOWN_SIGNATURES = [
  // ERC-20 / ERC-721 / ERC-1155: transfers and approvals
  'transfer(address to,uint256 amount)',
  'transferFrom(address from,address to,uint256 amount)',
  'approve(address spender,uint256 amount)',
  'increaseAllowance(address spender,uint256 amount)',
  'permit(address owner,address spender,uint256 amount,uint256 deadline,uint8 v,bytes32 r,bytes32 s)',
  'setApprovalForAll(address operator,bool approved)',
  'safeTransferFrom(address from,address to,uint256 tokenId)',
  'safeTransferFrom(address from,address to,uint256 tokenId,bytes data)',
  'safeTransferFrom(address from,address to,uint256 id,uint256 amount,bytes data)',
  'safeBatchTransferFrom(address from,address to,uint256[] ids,uint256[] amounts,bytes data)',
  // Uniswap Permit2
  'approve(address token,address spender,uint160 amount,uint48 expiration)',
  'permit(address owner,((address token,uint160 amount,uint48 expiration,uint48 nonce) details,address spender,uint256 sigDeadline) permitSingle,bytes signature)',
  // WETH and vaults
  'deposit()',
  'withdraw(uint256 amount)',
  // Routers and wallets
  'multicall(bytes[] calls)',
  'multicall(uint256 deadline,bytes[] calls)',
  'execute(bytes commands,bytes[] inputs,uint256 deadline)',
  'execute(bytes commands,bytes[] inputs)',
  'swapExactETHForTokens(uint256 amountOutMin,address[] path,address to,uint256 deadline)',
  'swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline)',
  'swapExactTokensForETH(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline)',
  'execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures)',
] as const;

const SAFE_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
/** Types only, as the signature database stores them: no names, nothing but the ABI grammar */
const SAFE_TYPES = /^\([a-z0-9,()[\]]{0,1000}\)$/;

const nameOf = (signature: string) =>
  signature.slice(0, signature.indexOf('('));

const KNOWN = new Map<Hex, string>(
  KNOWN_SIGNATURES.map((signature) => [
    toFunctionSelector(signature),
    signature,
  ]),
);

/** The built-in signature of a selector, with parameter names */
export const knownSignature = (selector: Hex): string | null =>
  KNOWN.get(selector) ?? null;

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
  /**
   * Full signature to decode the call with; null when it could not be used. Signatures
   * from the database carry no parameter names.
   */
  signature: string | null;
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
    if (!match) return null;
    const name = nameOf(match.name);
    // Names come from a public database: plain identifiers only, nothing to mislead with
    if (!SAFE_NAME.test(name)) return null;
    const types = match.name.slice(name.length);
    return {
      name,
      trusted: false,
      signature: SAFE_TYPES.test(types) ? match.name : null,
    };
  };

  return async (selector) => {
    const known = KNOWN.get(selector);
    if (known) return { name: nameOf(known), trusted: true, signature: known };
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
