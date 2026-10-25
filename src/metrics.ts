import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Registry,
} from '@prometheus-io/client';

import type { ChainName } from './chains.js';
import type { BlockScanner } from './scanner/scanner.js';
import type { Importance } from './watch/activity.js';

export type Metrics = ReturnType<typeof createMetrics>;

/**
 * Prometheus metrics of the bot: scanner progress per chain (read at scrape time),
 * alerts sent by importance, messages found in blocks, and Node.js process metrics.
 * The kit adds Telegram metrics (tg_*) to the same registry.
 */
export const createMetrics = (scanners: () => BlockScanner[]) => {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  const registers = [registry];

  const perChain = (
    name: string,
    help: string,
    value: (status: ReturnType<BlockScanner['status']>) => number | null,
  ) =>
    new Gauge({
      name,
      help,
      labelNames: ['chain'],
      registers,
      collect() {
        for (const scanner of scanners()) {
          const current = value(scanner.status());
          if (current !== null) this.set({ chain: scanner.chain }, current);
        }
      },
    });

  perChain(
    'eth_watch_head_block',
    'Latest block seen on the chain',
    (s) => s.head,
  );
  perChain(
    'eth_watch_last_block',
    'Last block every handler has processed',
    (s) => s.lastBlock,
  );
  perChain('eth_watch_lag_blocks', 'Blocks behind the head', (s) => s.lag);
  perChain(
    'eth_watch_scanner_up',
    '1 while the scanner runs without errors',
    (s) => (s.error === null && !s.stopped ? 1 : 0),
  );

  const alerts = new Counter({
    name: 'eth_watch_notifications_total',
    help: 'Transaction messages sent to chats, by chain and importance',
    labelNames: ['chain', 'importance'],
    registers,
  });
  const messages = new Counter({
    name: 'eth_watch_block_messages_total',
    help: 'Text messages found in transactions, by chain',
    labelNames: ['chain'],
    registers,
  });

  // The same numbers for the admin /health, without parsing the registry
  const sent: Record<Importance, number> = {
    alert: 0,
    outgoing: 0,
    incoming: 0,
  };
  let found = 0;

  return {
    registry,
    notificationSent: (chain: ChainName, importance: Importance) => {
      sent[importance] += 1;
      alerts.inc({ chain, importance });
    },
    messageFound: (chain: ChainName) => {
      found += 1;
      messages.inc({ chain });
    },
    /** Totals since the process started */
    totals: () => ({ sent: { ...sent }, found }),
  };
};
