import type { HealthReport } from '@dirai-kit/fastify/ops';
import type { FastifyInstance } from 'fastify';

import { txUrl } from './chains.js';
import type { MessageStore } from './messages/handler.js';
import type { BlockScanner } from './scanner/scanner.js';

/** Scanner lag that marks the service as degraded */
const MAX_HEALTHY_LAG = 100;

/**
 * The report of /health (served by the ops plugin, always with 200 while the process
 * runs: an RPC or Telegram outage should not restart the container; the status says
 * what is wrong). /metrics is not routed by the public proxy (deploy/Caddyfile).
 */
export const healthReport =
  (
    app: FastifyInstance,
    {
      scanners,
      telegram,
    }: {
      scanners: () => BlockScanner[];
      /** Whether the bot talks to Telegram (a token is set) */
      telegram: boolean;
    },
  ) =>
  async (): Promise<HealthReport> => {
    const chains = scanners().map((scanner) => scanner.status());
    const bot = telegram ? await app.tgHealth.check() : null;
    const degraded =
      chains.some(
        (chain) => chain.error !== null || (chain.lag ?? 0) > MAX_HEALTHY_LAG,
      ) ||
      (bot !== null && !bot.ok);
    return { status: degraded ? 'degraded' : 'ok', chains, telegram: bot };
  };

export const registerRoutes = (
  app: FastifyInstance,
  { messages }: { messages: MessageStore },
) => {
  app.get<{ Querystring: { limit: number } }>(
    '/v1/messages',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const recent = await messages.recent(request.query.limit);
      return {
        messages: recent.map((message) => ({
          ...message,
          url: txUrl(message.chain, message.hash),
        })),
      };
    },
  );
};
