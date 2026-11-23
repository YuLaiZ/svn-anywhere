import { createServer, type AddressInfo, type Socket } from 'node:net';
import { expect, it } from 'vitest';
import { readRemoteDirectory } from '../src/core/remoteBrowse';

it('真实 SVN 客户端在远端无响应时只进行一次传输重试', async () => {
  const sockets = new Set<Socket>();
  let connections = 0;
  const retries: string[] = [];
  const server = createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const url = 'svn://127.0.0.1:' + (server.address() as AddressInfo).port + '/repo';
    const result = await readRemoteDirectory('svn', url, {
      revision: 1, timeoutMs: 500,
      retryReadOnly: { delayMs: 5, onRetry: (error) => retries.push(error.code ?? '') },
    });
    expect(result).toMatchObject({ status: 'error', error: { kind: 'network', message: expect.stringContaining('超时') } });
    expect(retries).toEqual(['TIMEOUT']);
    expect(connections).toBe(2);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
