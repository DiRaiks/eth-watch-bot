import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPublicClient, type PublicClient } from 'viem';
import { mainnet } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkRpcs, rpcHost, rpcTransport } from '../src/rpc.js';

/** A JSON-RPC server that answers eth_chainId and eth_blockNumber, or fails */
const rpcServer = (chainId: number, block: number) => {
  const state = { failing: false, calls: 0 };
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      state.calls++;
      if (state.failing) {
        response.writeHead(503).end('overloaded');
        return;
      }
      const { id, method } = JSON.parse(body) as { id: number; method: string };
      const result =
        method === 'eth_chainId'
          ? `0x${chainId.toString(16)}`
          : `0x${block.toString(16)}`;
      response
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  });
  return { server, state };
};

const listen = (server: Server) =>
  new Promise<string>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  );

const first = rpcServer(1, 100);
const second = rpcServer(1, 200);
const otherChain = rpcServer(8453, 300);
let urls: { first: string; second: string; other: string };

beforeAll(async () => {
  urls = {
    first: await listen(first.server),
    second: await listen(second.server),
    other: await listen(otherChain.server),
  };
});

afterAll(() => {
  for (const { server } of [first, second, otherChain]) server.close();
});

describe('rpcTransport', () => {
  it('moves to the next RPC when one fails, and says which one answers', async () => {
    const rpc = rpcTransport([urls.first, urls.second]);
    const client = createPublicClient({
      chain: mainnet,
      transport: rpc.transport,
    }) as PublicClient;
    rpc.watch(client.transport);

    expect(rpc.current()).toBeNull();
    expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(100n);
    expect(rpc.current()).toBe(rpcHost(urls.first));

    first.state.failing = true;
    expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(200n);
    expect(rpc.current()).toBe(rpcHost(urls.second));

    // The first is preferred again once it recovers
    first.state.failing = false;
    expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(100n);
    expect(rpc.current()).toBe(rpcHost(urls.first));
  });

  it('uses a single RPC directly', () => {
    const rpc = rpcTransport([urls.first]);
    expect(rpc.current()).toBe(rpcHost(urls.first));
  });
});

describe('checkRpcs', () => {
  it('leaves out RPCs of another network and keeps silent ones', async () => {
    const silent = 'http://127.0.0.1:9';
    const check = await checkRpcs([urls.first, urls.other, silent], 1);
    expect(check.usable).toEqual([urls.first, silent]);
    expect(check.wrong).toEqual([{ host: rpcHost(urls.other), chainId: 8453 }]);
  });
});

describe('rpcHost', () => {
  it('never shows the path, where API keys live', () => {
    expect(rpcHost('https://eth-mainnet.g.alchemy.com/v2/SECRET')).toBe(
      'eth-mainnet.g.alchemy.com',
    );
    expect(rpcHost('not a url')).toBe('rpc');
  });
});
