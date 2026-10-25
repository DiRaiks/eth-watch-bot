import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PREFS,
  formatTimeZone,
  isQuietTime,
  localDay,
  localHour,
  readPrefs,
  type ChatPrefs,
} from '../src/watch/prefs.js';
import {
  applySetting,
  settingsKeyboard,
  settingsText,
} from '../src/watch/settings.js';

const prefs = (change: Partial<ChatPrefs> = {}): ChatPrefs => ({
  ...DEFAULT_PREFS,
  ...change,
});
const at = (hour: number) => Date.UTC(2026, 9, 25, hour, 30);

describe('readPrefs', () => {
  it('falls back to defaults for missing or malformed values', () => {
    expect(readPrefs({})).toEqual(DEFAULT_PREFS);
    expect(
      readPrefs({
        prefs: {
          mutedChains: ['base', 'solana', 7],
          minIncomingUsd: -5,
          quiet: { from: 30, to: 'x' },
          timeZone: 'Mars/Olympus',
          spam: 'maybe',
          mode: 'weekly',
          digestHour: 24,
        },
      }),
    ).toEqual({
      ...DEFAULT_PREFS,
      mutedChains: ['base'],
      quiet: { from: 23, to: 8 },
    });
  });

  it('keeps valid values', () => {
    const saved = prefs({
      mutedChains: ['arbitrum'],
      minIncomingUsd: 100,
      quiet: { from: 0, to: 9 },
      timeZone: 'America/New_York',
      spam: 'hide',
      mode: 'digest',
      digestHour: 20,
    });
    expect(readPrefs({ prefs: saved })).toEqual(saved);
  });
});

describe('time', () => {
  it('works in the chat time zone', () => {
    expect(localHour(prefs({ timeZone: 'Europe/Moscow' }), at(22))).toBe(1);
    // 02:30 UTC on 25 October is 22:30 the day before in New York (summer time)
    expect(localHour(prefs({ timeZone: 'America/New_York' }), at(2))).toBe(22);
    expect(localDay(prefs({ timeZone: 'Europe/Moscow' }), at(22))).toBe(
      '2026-10-26',
    );
    expect(formatTimeZone('Europe/Moscow', at(12))).toBe('Moscow, GMT+3');
    expect(formatTimeZone('America/New_York', at(12))).toBe('New York, GMT-4');
    expect(formatTimeZone('UTC', at(12))).toBe('UTC');
  });

  it('follows daylight saving time', () => {
    // Berlin leaves summer time on 2026-10-25: noon UTC is 14:00 before, 13:00 after
    const berlin = prefs({ timeZone: 'Europe/Berlin' });
    expect(localHour(berlin, Date.UTC(2026, 9, 24, 12))).toBe(14);
    expect(localHour(berlin, Date.UTC(2026, 9, 26, 12))).toBe(13);
  });

  it('knows quiet hours across midnight', () => {
    const night = prefs({ timeZone: 'UTC', quiet: { from: 23, to: 8 } });
    expect(isQuietTime(night, at(23))).toBe(true);
    expect(isQuietTime(night, at(7))).toBe(true);
    expect(isQuietTime(night, at(8))).toBe(false);
    const morning = prefs({ timeZone: 'UTC', quiet: { from: 0, to: 9 } });
    expect(isQuietTime(morning, at(5))).toBe(true);
    expect(isQuietTime(morning, at(12))).toBe(false);
    expect(isQuietTime(prefs(), at(3))).toBe(false);
  });
});

describe('settings buttons', () => {
  const chains = ['ethereum', 'base'] as const;

  it('applies each kind of button', () => {
    const current = prefs();
    expect(applySetting(current, 'set:chain:base', [...chains])).toEqual({
      mutedChains: ['base'],
    });
    expect(
      applySetting(prefs({ mutedChains: ['base'] }), 'set:chain:base', [
        ...chains,
      ]),
    ).toEqual({
      mutedChains: [],
    });
    expect(applySetting(current, 'set:min:100', [...chains])).toEqual({
      minIncomingUsd: 100,
    });
    expect(applySetting(current, 'set:quiet:23-8', [...chains])).toEqual({
      quiet: { from: 23, to: 8 },
    });
    expect(applySetting(current, 'set:quiet:off', [...chains])).toEqual({
      quiet: null,
    });
    expect(applySetting(current, 'set:tz:next', [...chains])).toEqual({
      timeZone: 'Asia/Tbilisi',
    });
    expect(applySetting(current, 'set:tz:prev', [...chains])).toEqual({
      timeZone: 'Europe/Kyiv',
    });
    // The list wraps around
    expect(
      applySetting(prefs({ timeZone: 'Asia/Vladivostok' }), 'set:tz:next', [
        ...chains,
      ]),
    ).toEqual({ timeZone: 'America/Los_Angeles' });
    expect(applySetting(current, 'set:spam:hide', [...chains])).toEqual({
      spam: 'hide',
    });
    expect(applySetting(current, 'set:mode:digest', [...chains])).toEqual({
      mode: 'digest',
    });
  });

  it('rejects stale or forged buttons', () => {
    const current = prefs();
    for (const data of [
      'set:chain:optimism',
      'set:min:5',
      'set:quiet:1-2',
      'set:tz:1',
      'set:spam:x',
      'set:mode:x',
      'set:unknown',
    ]) {
      expect(applySetting(current, data, [...chains])).toBeNull();
    }
  });

  it('shows the current state', () => {
    const current = prefs({
      mutedChains: ['base'],
      minIncomingUsd: 10,
      quiet: { from: 23, to: 8 },
    });
    const text = settingsText(current, [...chains]).value;
    expect(text).toContain('Сети: Ethereum');
    expect(text).toContain('Порог для входящих: от $10');
    expect(text).toContain('Тихие часы: 23:00–08:00 (Moscow, GMT+3)');
    const buttons = settingsKeyboard(current, [...chains])
      .inline_keyboard.flat()
      .map((b) => b.text);
    expect(buttons).toEqual(
      expect.arrayContaining([
        '✅ Ethereum',
        '▫️ Base',
        '• от $10',
        '• 🌙 23:00–08:00',
        '🕒 Moscow, GMT+3',
      ]),
    );
    // A single chain needs no chain buttons
    expect(
      settingsKeyboard(current, ['ethereum'])
        .inline_keyboard.flat()
        .some((b) => b.text.includes('Ethereum')),
    ).toBe(false);
  });
});
