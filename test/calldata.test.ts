import {
  encodeFunctionData,
  type AbiFunction,
  maxUint256,
  parseAbi,
  parseAbiItem,
  type Address,
  type Hex,
} from 'viem';
import { describe, expect, it } from 'vitest';

import { callToken, decodeCall } from '../src/enrich/calldata.js';
import { signatureLookup, type MethodName } from '../src/enrich/signatures.js';
import type { TokenInfo } from '../src/scanner/types.js';
import type { Activity } from '../src/watch/activity.js';
import { activityLine, type Enrichment } from '../src/watch/messages.js';
import { ALICE, BOB, CAROL, txHash, USDC } from './helpers.js';

const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as Address;
const NFT = '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D' as Address;

const encode = (signature: string, args: readonly unknown[]) =>
  encodeFunctionData({
    abi: [parseAbiItem(`function ${signature}`) as AbiFunction],
    args,
  });

const builtIn = signatureLookup({ remote: false });
const method = async (selector: Hex) => (await builtIn(selector))!;

const transferInput = encode('transfer(address,uint256)', [
  CAROL,
  250_000n * 10n ** 6n,
]);
const approveAll = encode('approve(address,uint256)', [CAROL, maxUint256]);

describe('decodeCall', () => {
  it('decodes built-in methods with parameter names', async () => {
    const { signature } = await method('0xa9059cbb');
    expect(decodeCall(signature!, transferInput, { named: true })).toEqual([
      { name: 'to', type: 'address', value: CAROL },
      { name: 'amount', type: 'uint256', value: 250_000_000_000n },
    ]);

    const forAll = encode('setApprovalForAll(address,bool)', [BOB, true]);
    const { signature: forAllSignature } = await method('0xa22cb465');
    expect(decodeCall(forAllSignature!, forAll, { named: true })).toEqual([
      { name: 'operator', type: 'address', value: BOB },
      { name: 'approved', type: 'bool', value: true },
    ]);
  });

  it('decodes the Permit2 approve', async () => {
    const input = encode('approve(address,address,uint160,uint48)', [
      USDC,
      CAROL,
      2n ** 160n - 1n,
      1_800_000_000,
    ]);
    const { name, signature } = await method(input.slice(0, 10) as Hex);
    expect(name).toBe('approve');
    expect(
      decodeCall(signature!, input, { named: true })?.map((a) => a.name),
    ).toEqual(['token', 'spender', 'amount', 'expiration']);
    expect(callToken(input.slice(0, 10) as Hex, input, PERMIT2)).toBe(USDC);
  });

  it('drops parameter names of untrusted signatures', () => {
    const input = encode('claim(uint256 amount)', [5n]);
    expect(decodeCall('claim(uint256)', input, { named: false })).toEqual([
      { name: null, type: 'uint256', value: 5n },
    ]);
  });

  it('answers null when the input does not fit the signature', () => {
    // Too short for the parameters, a collision with another method, a broken signature
    expect(
      decodeCall('transfer(address,uint256)', '0xa9059cbb0000', {
        named: true,
      }),
    ).toBeNull();
    expect(
      decodeCall('approve(address,uint256)', transferInput, { named: true }),
    ).toBeNull();
    expect(decodeCall('claim(uint7)', '0x12345678', { named: true })).toBe(
      null,
    );
    const huge = `0xa9059cbb${'00'.repeat(70_000)}` as Hex;
    expect(
      decodeCall('transfer(address,uint256)', huge, { named: true }),
    ).toBeNull();
  });

  it('names the token whose decimals a call needs', () => {
    expect(callToken('0xa9059cbb', transferInput, USDC)).toBe(USDC);
    expect(callToken('0x12345678', '0x12345678', USDC)).toBeNull();
    expect(callToken(null, '0x', USDC)).toBeNull();
    expect(callToken('0xa9059cbb', '0xa9059cbb', USDC)).toBeNull();
  });
});

const data = (
  methods: [Hex, MethodName | null][],
  tokens: [Address, TokenInfo][] = [[USDC, { symbol: 'USDC', decimals: 6 }]],
): Enrichment => ({
  tokens: new Map(tokens),
  methods: new Map(methods),
  prices: new Map(),
});

const call = (contract: Address, input: Hex): Activity => ({
  address: ALICE,
  hash: txHash(1),
  order: 0,
  importance: 'outgoing',
  spam: null,
  kind: 'call',
  contract,
  selector: input.slice(0, 10) as Hex,
  input,
});

const line = async (
  contract: Address,
  input: Hex,
  lookup: MethodName | null = null,
  tokens?: [Address, TokenInfo][],
) => {
  const selector = input.slice(0, 10) as Hex;
  const name = lookup ?? (await builtIn(selector));
  return activityLine(
    'ethereum',
    call(contract, input),
    data([[selector, name]], tokens),
  ).value;
};

describe('call parameters in messages', () => {
  it('shows a token transfer with the amount in the token', async () => {
    const text = await line(USDC, transferInput);
    expect(text).toContain('<b>transfer</b>(to <a href=');
    expect(text).toContain('>0xae7a…fE84</a>, amount 250 000 USDC)');
  });

  it('shows an unlimited approval as all', async () => {
    const text = await line(USDC, approveAll);
    expect(text).toContain('⚠️ <b>approve</b>(spender <a href=');
    expect(text).toContain('amount <b>все</b>)');
  });

  it('shows token ids for NFTs and raw numbers for unknown tokens', async () => {
    const approveNft = encode('approve(address,uint256)', [CAROL, 42n]);
    expect(
      await line(NFT, approveNft, null, [
        [NFT, { symbol: 'BAYC', decimals: null }],
      ]),
    ).toContain('amount #42)');
    const transfer = encode('transfer(address,uint256)', [CAROL, 12_345n]);
    expect(await line(CAROL, transfer)).toContain('amount 12 345)');
  });

  it('shows Permit2 approvals in the token, with the expiration date', async () => {
    const input = encode('approve(address,address,uint160,uint48)', [
      USDC,
      CAROL,
      5n * 10n ** 6n,
      Date.UTC(2026, 10, 1, 12) / 1000,
    ]);
    const text = await line(PERMIT2, input);
    // A known token is shown by its symbol
    expect(text).toContain('(token <a href=');
    expect(text).toContain('>USDC</a>, spender');
    expect(text).toContain('amount 5 USDC, expiration 01.11 12:00 UTC)');
  });

  it('shows untrusted signatures as a hint, without parameter names', async () => {
    const input = encode('claim(address to,uint256 amount)', [BOB, 7n]);
    const text = await line(CAROL, input, {
      name: 'claim',
      trusted: false,
      signature: 'claim(address,uint256)',
    });
    expect(text).toMatch(
      /метод <code>0x[0-9a-f]{8}<\/code> \(похоже на claim\(<a href="[^"]+">0x0000…05Fa<\/a>, 7\)\)/,
    );
  });

  it('falls back to the name alone when the input does not decode', async () => {
    const text = await line(CAROL, '0x12345678abcd', {
      name: 'claim',
      trusted: false,
      signature: 'claim(address,uint256)',
    });
    expect(text).toContain('(похоже на claim)');
    expect(await line(USDC, '0xa9059cbb00')).toMatch(/<b>transfer<\/b>$/);
  });

  it('summarises bytes, arrays, strings, booleans and long lists', async () => {
    const signature =
      'run(bytes data,address[] path,string note,bool flag,uint256 big)';
    const input = encode(signature, [
      `0x${'ab'.repeat(40)}`,
      [ALICE, BOB],
      '<script>alert(1)</script> and more text',
      true,
      maxUint256 - 1n,
    ]);
    const text = await line(CAROL, input, {
      name: 'run',
      trusted: true,
      signature,
    });
    expect(text).toContain(
      '<b>run</b>(data 0xabababab… (40 байт), path [2 шт.], note «&lt;script&gt;alert(1)&lt;/scrip…», flag да, …)',
    );

    const short = 'set(bytes4 id,int256 delta,uint256 big,(uint256,bool) pair)';
    const shortInput = encode(short, [
      '0x12345678',
      -1_500n,
      10n ** 30n,
      [1n, false],
    ]);
    expect(
      await line(CAROL, shortInput, {
        name: 'set',
        trusted: true,
        signature: short,
      }),
    ).toContain('(id 0x12345678, delta -1 500, big 1.00e30, pair (1, нет))');
  });

  it('shows the fields of a Permit2 signature, so the spender is visible', async () => {
    const signature =
      'permit(address,((address,uint160,uint48,uint48),address,uint256),bytes)';
    const input = encode(signature, [
      ALICE,
      [[USDC, 2n ** 160n - 1n, 1_800_000_000, 0], CAROL, 1_800_000_000n],
      `0x${'11'.repeat(65)}`,
    ]);
    const text = await line(PERMIT2, input);
    expect(text).toContain('⚠️ <b>permit</b>(owner <a href=');
    expect(text).toContain('permitSingle (details (token <a href=');
    expect(text).toContain(
      'amount <b>все</b>, expiration 15.01 08:00 UTC, nonce 0)',
    );
    expect(text).toContain('spender <a href=');
    expect(text).toContain('>0xae7a…fE84</a>, sigDeadline 15.01 08:00 UTC)');
    expect(text).toContain('signature 0x11111111… (65 байт))');
  });

  it('keeps "all" for amounts: not for token ids, deadlines or unnamed values', async () => {
    const approveNft = encode('approve(address,uint256)', [CAROL, maxUint256]);
    expect(
      await line(NFT, approveNft, null, [
        [NFT, { symbol: 'BAYC', decimals: null }],
      ]),
    ).toContain(`amount #${maxUint256})`);

    const swap = encode(
      'swapExactTokensForETH(uint256,uint256,address[],address,uint256)',
      [maxUint256, 0n, [USDC], ALICE, maxUint256],
    );
    const text = await line(CAROL, swap);
    expect(text).toContain(
      '(amountIn <b>все</b>, amountOutMin 0, path [1 шт.]',
    );
    const multicall = encode('multicall(uint256,bytes[])', [maxUint256, []]);
    expect(await line(CAROL, multicall)).toContain(
      '(deadline 1.15e77, calls [0 шт.])',
    );

    const untrusted = encode('claim(uint256)', [maxUint256]);
    expect(
      await line(CAROL, untrusted, {
        name: 'claim',
        trusted: false,
        signature: 'claim(uint256)',
      }),
    ).toContain('(похоже на claim(1.15e77))');
  });

  it('flattens line breaks and invisible characters in strings', async () => {
    const input = encode('note(string)', ['ok\n✅ Безопасно\u202Etxt']);
    const text = await line(CAROL, input, {
      name: 'note',
      trusted: false,
      signature: 'note(string)',
    });
    expect(text).toContain('(похоже на note(«ok ✅ Безопасно txt»))');
  });
});

describe('payable calls', () => {
  const lido = '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84' as Address;
  const referral = '0x11d00000000000000000000000000000000011d0' as Address;
  const input = encodeFunctionData({
    abi: parseAbi(['function submit(address)']),
    args: [referral],
  });
  const selector = input.slice(0, 10) as Hex;
  const base = {
    hash: txHash(1),
    order: 0,
    spam: null,
    value: 10n ** 15n,
    selector,
    input,
  } as const;

  it('shows the method next to coins sent with it, e.g. staking', async () => {
    const sent: Activity = {
      ...base,
      address: ALICE,
      importance: 'outgoing',
      kind: 'send-native',
      to: lido,
    };
    const text = activityLine(
      'ethereum',
      sent,
      data([[selector, await builtIn(selector)]]),
    ).value;
    expect(text).toContain('Отправлено <b>0.001 ETH</b>');
    expect(text).toContain('· <b>submit</b>(referral');
    expect(text).toContain('0x11d0…11d0');
  });

  it('shows the method of a payable call of a watched contract', async () => {
    const received: Activity = {
      ...base,
      address: lido,
      importance: 'incoming',
      kind: 'receive-native',
      from: ALICE,
    };
    const text = activityLine(
      'ethereum',
      received,
      data([[selector, await builtIn(selector)]]),
    ).value;
    expect(text).toContain('Получено <b>0.001 ETH</b>');
    expect(text).toContain('<b>submit</b>');
  });

  it('keeps a plain transfer as it was', () => {
    const plain: Activity = {
      ...base,
      selector: null,
      input: '0x',
      address: ALICE,
      importance: 'outgoing',
      kind: 'send-native',
      to: BOB,
    };
    const text = activityLine('ethereum', plain, data([])).value;
    expect(text).not.toContain('·');
  });
});
