import { describe, expect, it } from 'vitest';

import type { Activity } from '../src/watch/activity.js';
import { formatTx, type Enrichment } from '../src/watch/messages.js';
import { DEFAULT_PREFS, readPrefs } from '../src/watch/prefs.js';
import { applySetting, settingsKeyboard } from '../src/watch/settings.js';
import { ALICE, BOB, txHash, USDC } from './helpers.js';

const data: Enrichment = {
  tokens: new Map([[USDC, { symbol: 'USDC', decimals: 6 }]]),
  methods: new Map(),
  prices: new Map(),
};
const base = { hash: txHash(1), order: 0, spam: null } as const;
const watch = { address: ALICE, label: 'Trash_2' };

const sent: Activity = {
  ...base,
  address: ALICE,
  importance: 'outgoing',
  kind: 'send-native',
  to: BOB,
  value: 10n ** 15n,
};
const taken: Activity = {
  ...base,
  address: ALICE,
  importance: 'alert',
  kind: 'send-token',
  token: USDC,
  from: ALICE,
  to: BOB,
  value: 5_000_000n,
  sentBy: BOB,
};

const message = (item: Activity, hideDetails: boolean) =>
  formatTx(
    'ethereum',
    26_272_915,
    {
      hash: txHash(1),
      watches: [watch],
      items: [item],
      importance: item.importance,
    },
    data,
    () => 'Trash_2',
    { hideDetails },
  ).value;

describe('alert details', () => {
  it('names the event in the first line, without amounts or addresses', () => {
    const [header] = message(sent, true).split('\n');
    expect(header).toBe('🔔 <b>Trash_2</b> · Ethereum · исходящая');
    expect(message(taken, true).split('\n')[0]).toBe(
      '🚨 <b>Trash_2</b> · Ethereum · списание не вами',
    );
  });

  it('puts amounts, addresses and the link under a spoiler when asked', () => {
    const hidden = message(sent, true);
    const spoiler = hidden.slice(hidden.indexOf('<tg-spoiler>'));
    expect(spoiler).toContain('0.001 ETH');
    expect(spoiler).toContain('блок 26 272 915');
    expect(hidden.split('<tg-spoiler>')[0]).not.toContain('0.001');

    const shown = message(sent, false);
    expect(shown).not.toContain('tg-spoiler');
    expect(shown).toContain('0.001 ETH');
  });

  it('keeps the advice of an alert outside the spoiler', () => {
    const text = message(taken, true);
    expect(text.indexOf('revoke.cash')).toBeGreaterThan(
      text.indexOf('</tg-spoiler>'),
    );
  });
});

describe('details setting', () => {
  it('hides details by default and switches from /settings', () => {
    expect(DEFAULT_PREFS.details).toBe('hidden');
    expect(readPrefs({ prefs: { details: 'shown' } }).details).toBe('shown');
    expect(readPrefs({ prefs: { details: 'odd' } }).details).toBe('hidden');

    const change = applySetting(DEFAULT_PREFS, 'set:details:shown', [
      'ethereum',
    ]);
    expect(change).toEqual({ details: 'shown' });
    const buttons = settingsKeyboard({ ...DEFAULT_PREFS, ...change }, [
      'ethereum',
    ])
      .inline_keyboard.flat()
      .map((b) => b.text);
    expect(buttons).toEqual(
      expect.arrayContaining(['✅ Детали открыты', 'Детали под спойлером']),
    );
  });
});
