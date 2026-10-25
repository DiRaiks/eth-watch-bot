import { encodeFunctionData, erc20Abi, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { decodeMessage, isMeaningfulText } from '../src/messages/decode.js';
import { BOB, textInput } from './helpers.js';

describe('decodeMessage', () => {
  it.each([
    'Hello from the chain',
    'gm everyone',
    'Привет, блокчейн!',
    'Congratulations',
    'Line one\nLine two',
  ])('finds the message %j', (text) => {
    expect(decodeMessage(textInput(text))).toBe(text);
  });

  it('strips zero padding and surrounding spaces', () => {
    const input = `${textInput('  hello world  ')}000000` as Hex;
    expect(decodeMessage(input)).toBe('hello world');
  });

  it('ignores contract calls', () => {
    const transfer = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [BOB, 10n ** 18n],
    });
    expect(decodeMessage(transfer)).toBeNull();
  });

  it.each([
    ['empty input', '0x'],
    ['too short', textInput('hey')],
    ['odd length', '0x48656c6c6f2'],
    ['invalid UTF-8', '0xc328c328c328c328'],
    ['control characters', textInput('hello\u0001world here')],
    ['oversized', textInput('word '.repeat(2000))],
  ])('rejects %s', (_case, input) => {
    expect(decodeMessage(input as Hex)).toBeNull();
  });
});

describe('isMeaningfulText', () => {
  it.each([
    'data:,{"p":"erc-20","op":"mint","tick":"eths","amt":"1000"}',
    '{"p":"erc-20","op":"mint"}',
    "{'op':'mint','tick':'abc'}",
    '=:ETH.ETH:0x1234567890abcdef:0/1/0',
    'SWAP:BTC.BTC:bc1qxyz',
    'BFX_REFILL_SWEEP',
    'vitalik.eth',
    'aGVsbG8gd29ybGQgdGhpcyBpcyBiYXNlNjQ',
    '12345 67890 !!!',
    'ab',
    'ok',
  ])('rejects machine text %j', (text) => {
    expect(isMeaningfulText(text)).toBe(false);
  });

  it.each(['Happy birthday Alice', 'Hello', 'Спасибо'])(
    'accepts %j',
    (text) => {
      expect(isMeaningfulText(text)).toBe(true);
    },
  );
});
