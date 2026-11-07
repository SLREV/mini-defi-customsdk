import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer as createHttpServer, Server } from 'node:http';
import { AddressInfo, connect, Socket } from 'node:net';
import { createServer as createViteServer } from 'vite';
import { Connection } from '@solana/web3.js';
import { localValidatorProxy } from '../scripts/localValidatorProxy';

const listen = (server: Server): Promise<number> => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
});
const close = (server: Server): Promise<void> => new Promise((resolve) => server.close(() => resolve()));

async function main(): Promise<void> {
  let rpcPath = '';
  let wsPath = '';
  const sockets = new Set<Socket>();
  const rpc = createHttpServer((req, res) => {
    rpcPath = req.url ?? '';
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      const request = JSON.parse(body) as { id: string; method: string };
      assert.equal(request.method, 'getGenesisHash');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: 'local-test-genesis' }));
    });
  });
  const ws = createHttpServer();
  ws.on('upgrade', (req, socket) => {
    wsPath = req.url ?? '';
    sockets.add(socket as Socket);
    socket.on('close', () => sockets.delete(socket as Socket));
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  const rpcPort = await listen(rpc);
  const wsPort = await listen(ws);
  const vite = await createViteServer({
    configFile: false,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, hmr: false, proxy: localValidatorProxy(rpcPort, wsPort) },
  });
  try {
    await vite.listen();
    const port = (vite.httpServer!.address() as AddressInfo).port;
    const connection = new Connection(`http://127.0.0.1:${port}/local-validator-rpc`, 'confirmed');
    assert.equal(await connection.getGenesisHash(), 'local-test-genesis');
    assert.equal(rpcPath, '/');
    await new Promise<void>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1');
      const timeout = setTimeout(() => { socket.destroy(); reject(new Error('WebSocket proxy timeout')); }, 5000);
      socket.on('connect', () => socket.write(
        `GET /local-validator-ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`
      ));
      socket.once('data', (data) => {
        clearTimeout(timeout);
        socket.destroy();
        try { assert.match(data.toString(), /^HTTP\/1\.1 101/); resolve(); } catch (err) { reject(err); }
      });
      socket.on('error', (err) => { clearTimeout(timeout); reject(err); });
    });
    assert.equal(wsPath, '/');
    console.log('LOCAL RPC AND WEBSOCKET PROXY TESTS PASSED!');
  } finally {
    for (const socket of sockets) socket.destroy();
    await vite.close();
    await Promise.all([close(rpc), close(ws)]);
  }
}
main().catch((err: unknown) => { console.error(err); process.exitCode = 1; });
