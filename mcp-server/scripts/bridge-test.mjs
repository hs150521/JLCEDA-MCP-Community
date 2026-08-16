import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { WebSocket } from 'ws';
import { EdaBridgeServer } from '../dist/mcp/bridge-client.js';

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
}

async function expectPolicyClose(url) {
  const socket = new WebSocket(url);
  const [code] = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for policy close')), 3000);
    socket.once('close', (...args) => {
      clearTimeout(timer);
      resolve(args);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  assert.equal(code, 1008);
}

function waitForMessage(socket, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error('Timed out waiting for WebSocket message'));
    }, timeoutMs);
    const onMessage = (data) => {
      const message = JSON.parse(data.toString());
      if (!predicate(message)) {
        return;
      }
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(message);
    };
    socket.on('message', onMessage);
  });
}

async function waitUntil(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for condition');
}

function attachTaskResponder(socket, clientId, transform) {
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.type !== 'bridge/task') {
      return;
    }
    socket.send(JSON.stringify({
      type: 'bridge/result',
      clientId,
      requestId: message.requestId,
      leaseTerm: message.leaseTerm,
      result: transform(message),
    }));
  });
}

async function registerEda(url, clientId) {
  const socket = await connect(url);
  const welcome = waitForMessage(socket, (message) => message.type === 'bridge/welcome');
  const role = waitForMessage(socket, (message) => message.type === 'bridge/role');
  socket.send(JSON.stringify({ type: 'bridge/hello', clientId, bridgeVersion: '2.1.0' }));
  assert.equal((await welcome).clientId, clientId);
  const initialRole = await role;
  socket.send(JSON.stringify({ type: 'bridge/ready', clientId, readyAt: Date.now() }));
  const heartbeat = waitForMessage(socket, (message) => message.type === 'bridge/heartbeat-ack');
  socket.send(JSON.stringify({ type: 'bridge/heartbeat', clientId, sentAt: Date.now() }));
  await heartbeat;
  return { socket, initialRole };
}

const port = await reservePort();
const url = `ws://127.0.0.1:${port}`;
const originalToken = process.env.JLCEDA_BRIDGE_TOKEN;
process.env.JLCEDA_BRIDGE_TOKEN = 'bridge-test-token';
const tokenQuery = '?token=bridge-test-token';
const mainServer = new EdaBridgeServer(port);
const secondaryServer = new EdaBridgeServer(port);
let expiryServer;
let blue;
let red;

try {
  await mainServer.start();
  assert.equal(mainServer.getMode(), 'main');

  await expectPolicyClose(`${url}/bridge/ws`);
  await expectPolicyClose(`${url}/mcp-internal?token=wrong-token`);
  await expectPolicyClose(`${url}/unsupported${tokenQuery}`);

  blue = await registerEda(`${url}/bridge/ws${tokenQuery}`, 'blue-page');
  assert.equal(blue.initialRole.role, 'active');
  attachTaskResponder(blue.socket, 'blue-page', (message) => ({ source: 'blue', path: message.path }));
  assert.deepEqual(
    await mainServer.request('/bridge/test/blue', { value: 1 }, 2000),
    { source: 'blue', path: '/bridge/test/blue' },
  );

  red = await registerEda(`${url}/bridge/ws${tokenQuery}`, 'red-page');
  assert.equal(red.initialRole.role, 'standby');
  attachTaskResponder(red.socket, 'red-page', (message) => ({ source: 'red', path: message.path }));
  const promoted = waitForMessage(
    red.socket,
    (message) => message.type === 'bridge/role' && message.role === 'active',
  );
  blue.socket.close();
  await promoted;
  assert.deepEqual(
    await mainServer.request('/bridge/test/red', { value: 2 }, 2000),
    { source: 'red', path: '/bridge/test/red' },
  );

  await secondaryServer.start();
  assert.equal(secondaryServer.getMode(), 'client');
  assert.deepEqual(
    await secondaryServer.request('/bridge/test/shared', { value: 3 }, 2000),
    { source: 'red', path: '/bridge/test/shared' },
  );

  const expiryPort = await reservePort();
  expiryServer = new EdaBridgeServer(expiryPort, { peerTtlMs: 250, peerSweepIntervalMs: 25 });
  await expiryServer.start();
  const stale = await registerEda(
    `ws://127.0.0.1:${expiryPort}/bridge/ws${tokenQuery}`,
    'stale-page',
  );
  const [staleCloseCode] = await new Promise((resolve) => {
    stale.socket.once('close', (...args) => resolve(args));
  });
  assert.equal(staleCloseCode, 4000);
  expiryServer.close();
  expiryServer = undefined;

  mainServer.close();
  await waitUntil(() => secondaryServer.getMode() === 'main');
  red = await registerEda(`${url}/bridge/ws${tokenQuery}`, 'red-reconnected');
  attachTaskResponder(red.socket, 'red-reconnected', (message) => ({
    source: 'promoted-server',
    path: message.path,
  }));
  assert.deepEqual(
    await secondaryServer.request('/bridge/test/failover', { value: 4 }, 2000),
    { source: 'promoted-server', path: '/bridge/test/failover' },
  );

  process.stdout.write('Bridge protocol integration test passed\n');
} finally {
  blue?.socket.close();
  red?.socket.close();
  expiryServer?.close();
  secondaryServer.close();
  mainServer.close();
  if (originalToken === undefined) {
    delete process.env.JLCEDA_BRIDGE_TOKEN;
  } else {
    process.env.JLCEDA_BRIDGE_TOKEN = originalToken;
  }
}
