import type { FastifyInstance } from 'fastify';

import { txUrl } from './chains.js';
import type { MessageStore } from './messages/handler.js';
import type { BlockScanner } from './scanner/scanner.js';

/** Scanner lag that marks the service as degraded */
const MAX_HEALTHY_LAG = 100;

export const registerRoutes = (
  app: FastifyInstance,
  { scanners, messages }: { scanners: BlockScanner[]; messages: MessageStore },
) => {
  // Always 200 while the process runs: an RPC outage should not restart the container
  app.get('/health', async () => {
    const chains = scanners.map((scanner) => scanner.status());
    const degraded = chains.some(
      (chain) => chain.error !== null || (chain.lag ?? 0) > MAX_HEALTHY_LAG,
    );
    return { status: degraded ? 'degraded' : 'ok', chains };
  });

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
