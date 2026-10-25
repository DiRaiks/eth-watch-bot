import {
  decodeFunctionData,
  parseAbiItem,
  toFunctionSelector,
  type AbiFunction,
  type AbiParameter,
  type Address,
  type Hex,
} from 'viem';

import { knownSignature } from './signatures.js';

export type CallArg = {
  /** Null for signatures from the public database: their names are not facts */
  name: string | null;
  type: string;
  value: unknown;
  /** Fields of a tuple, for named signatures only */
  components?: CallArg[];
};

/** Larger calldata is not decoded: a message has no room for it anyway */
const MAX_INPUT_LENGTH = 2 + 64 * 1024;
const MAX_PARSED = 1000;

/** Signatures repeat from block to block; parsing them once is enough */
const parsed = new Map<string, AbiFunction>();
const parse = (signature: string) => {
  let item = parsed.get(signature);
  if (!item) {
    item = parseAbiItem(`function ${signature}`) as AbiFunction;
    if (parsed.size >= MAX_PARSED) parsed.clear();
    parsed.set(signature, item);
  }
  return item;
};

const toArg = (
  param: AbiParameter,
  value: unknown,
  named: boolean,
): CallArg => {
  const arg: CallArg = {
    name: named ? param.name || null : null,
    type: param.type,
    value,
  };
  if (named && param.type === 'tuple' && 'components' in param) {
    // viem returns tuples with named fields as objects, others as arrays
    const fields = value as Record<string, unknown> | unknown[];
    arg.components = param.components.map((field, index) =>
      toArg(
        field,
        Array.isArray(fields) ? fields[index] : fields[field.name ?? ''],
        named,
      ),
    );
  }
  return arg;
};

/**
 * Arguments of a call, decoded with its signature; null when the input does not fit
 * the signature (a selector collision, malformed or oversized data).
 */
export const decodeCall = (
  signature: string,
  input: Hex,
  { named }: { named: boolean },
): CallArg[] | null => {
  if (input.length > MAX_INPUT_LENGTH) return null;
  try {
    const item = parse(signature);
    const { args = [] } = decodeFunctionData({ abi: [item], data: input });
    return item.inputs.map((param, index) => toArg(param, args[index], named));
  } catch {
    return null;
  }
};

/** Where a built-in method keeps a token amount, and which token it is counted in */
type AmountRule = {
  amount: number;
  /** The called contract, or the address argument at this index */
  token: 'contract' | number;
};

const AMOUNT_RULES = new Map<Hex, AmountRule>([
  [
    toFunctionSelector('transfer(address,uint256)'),
    { amount: 1, token: 'contract' },
  ],
  [
    toFunctionSelector('transferFrom(address,address,uint256)'),
    { amount: 2, token: 'contract' },
  ],
  [
    toFunctionSelector('approve(address,uint256)'),
    { amount: 1, token: 'contract' },
  ],
  [
    toFunctionSelector('increaseAllowance(address,uint256)'),
    { amount: 1, token: 'contract' },
  ],
  // Permit2
  [
    toFunctionSelector('approve(address,address,uint160,uint48)'),
    { amount: 2, token: 0 },
  ],
]);

/** The token amount of a call to a built-in method, and the token it is counted in */
export const callAmount = (
  selector: Hex,
  contract: Address,
  args: CallArg[],
): { index: number; token: Address } | null => {
  const rule = AMOUNT_RULES.get(selector);
  if (!rule) return null;
  const token = rule.token === 'contract' ? contract : args[rule.token]?.value;
  return typeof token === 'string' && args[rule.amount]
    ? { index: rule.amount, token: token as Address }
    : null;
};

/** The token whose decimals a call's amount needs, before the method is looked up */
export const callToken = (
  selector: Hex | null,
  input: Hex,
  contract: Address,
): Address | null => {
  const signature =
    selector && AMOUNT_RULES.has(selector) && knownSignature(selector);
  if (!signature) return null;
  const args = decodeCall(signature, input, { named: true });
  return (args && callAmount(selector, contract, args)?.token) || null;
};
