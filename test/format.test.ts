import { describe, expect, it } from 'vitest';

import {
  formatAmount,
  formatBlock,
  formatTime,
  shortAddress,
  truncate,
} from '../src/format.js';
import { ALICE } from './helpers.js';

describe('formatAmount', () => {
  it.each([
    [1_500_000_000_000_000_000n, 18, '1.5'],
    [1_234_567_890_000_000_000_000_000n, 18, '1 234 567.89'],
    [1_000_000n, 6, '1'],
    [1_234_567n, 6, '1.2345'],
    [123n, 18, '0.000000000000000123'],
    [1_234_500_000_000n, 18, '0.000001234'],
    [0n, 18, '0'],
    [42n, 0, '42'],
  ])('formats %s with %i decimals as %s', (value, decimals, expected) => {
    expect(formatAmount(value, decimals)).toBe(expected);
  });
});

describe('helpers', () => {
  it('shortens addresses', () => {
    expect(shortAddress(ALICE)).toBe('0xd8dA…6045');
  });

  it('groups block numbers', () => {
    expect(formatBlock(21_000_123)).toBe('21 000 123');
  });

  it('prints UTC time', () => {
    expect(formatTime(Date.UTC(2026, 9, 25, 14, 5))).toBe('25.10 14:05 UTC');
  });

  it('truncates long text', () => {
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('abc', 4)).toBe('abc');
    expect(truncate('👍👍👍', 2)).toBe('👍…');
  });
});
