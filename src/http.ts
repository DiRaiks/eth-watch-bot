import type { MetricsRegistry } from '@dirai-kit/tg';
import type { FastifyInstance } from 'fastify';

import { txUrl } from './chains.js';
import type { MessageStore } from './messages/handler.js';
import type { BlockScanner } from './scanner/scanner.js';

/** Scanner lag that marks the service as degraded */
const MAX_HEALTHY_LAG = 100;

export const registerRoutes = (
  app: FastifyInstance,
  {
    scanners,
    messages,
    metrics,
    telegram,
  }: {
    scanners: BlockScanner[];
    messages: MessageStore;
    metrics: MetricsRegistry;
    /** Whether the bot talks to Telegram (a token is set) */
    telegram: boolean;
  },
) => {
  // Always 200 while the process runs: an RPC or Telegram outage should not restart
  // the container; the status says what is wrong
  app.get('/health', async () => {
    const chains = scanners.map((scanner) => scanner.status());
    const bot = telegram ? await app.tgHealth.check() : null;
    const degraded =
      chains.some(
        (chain) => chain.error !== null || (chain.lag ?? 0) > MAX_HEALTHY_LAG,
      ) ||
      (bot !== null && !bot.ok);
    return { status: degraded ? 'degraded' : 'ok', chains, telegram: bot };
  });

  // Not routed by the public proxy (deploy/Caddyfile): scrape it inside the network
  app.get('/metrics', async (_request, reply) =>
    reply.type(metrics.contentType).send(await metrics.metrics()),
  );

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
