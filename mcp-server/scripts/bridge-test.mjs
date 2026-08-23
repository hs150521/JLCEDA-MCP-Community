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
    if (await predicate()) {
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
      type: 'bridge/task-started',
      clientId,
      requestId: message.requestId,
      leaseTerm: message.leaseTerm,
      startedAt: Date.now(),
    }));
    socket.send(JSON.stringify({
      type: 'bridge/result',
      clientId,
      requestId: message.requestId,
      leaseTerm: message.leaseTerm,
      result: transform(message),
    }));
  });
}

async function registerEda(url, clientId, context = undefined) {
  const socket = await connect(url);
  const welcome = waitForMessage(socket, (message) => message.type === 'bridge/welcome');
  const role = waitForMessage(socket, (message) => message.type === 'bridge/role');
  socket.send(JSON.stringify({ type: 'bridge/hello', clientId, bridgeVersion: '2.1.0', context }));
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
let queueServer;
let recoveryServer;
let disconnectServer;
let reconnectServer;
let blue;
let red;
let queued;
let stuck;
let replacement;
let disconnectActive;
let disconnectReplacement;
let reconnectOld;
let reconnectNew;
let reconnectTarget;

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
  const clientsBeforeSelection = await mainServer.request('/bridge/admin/clients', {}, 2000);
  assert.equal(clientsBeforeSelection.activeClientId, 'blue-page');
  assert.deepEqual(clientsBeforeSelection.clients.map((client) => client.clientId), ['blue-page', 'red-page']);
  await mainServer.request('/bridge/admin/select-client', { clientId: 'red-page' }, 2000);
  assert.deepEqual(
    await mainServer.request('/bridge/test/selected-red', {}, 2000),
    { source: 'red', path: '/bridge/test/selected-red' },
  );
  const contextHeartbeat = waitForMessage(red.socket, (message) => message.type === 'bridge/heartbeat-ack');
  red.socket.send(JSON.stringify({
    type: 'bridge/heartbeat',
    clientId: 'red-page',
    sentAt: Date.now(),
    context: { projectUuid: 'project-2026', projectName: '2026', pageKind: 'schematic', pageUuid: 'red-sheet', pageName: 'RED HUB' },
  }));
  await contextHeartbeat;
  const clientsAfterHeartbeat = await mainServer.request('/bridge/admin/clients', {}, 2000);
  assert.equal(clientsAfterHeartbeat.clients[1].context.pageName, 'RED HUB');
  await assert.rejects(
    mainServer.request('/bridge/admin/select-client', { clientId: 'missing-page' }, 2000),
    /not connected and ready/,
  );
  await mainServer.request('/bridge/admin/select-client', { clientId: 'blue-page' }, 2000);
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
  const sharedClients = await secondaryServer.request('/bridge/admin/clients', {}, 2000);
  assert.equal(sharedClients.activeClientId, 'red-page');
  assert.deepEqual(
    await secondaryServer.request('/bridge/test/shared', { value: 3 }, 2000),
    { source: 'red', path: '/bridge/test/shared' },
  );

  const queuePort = await reservePort();
  queueServer = new EdaBridgeServer(queuePort);
  await queueServer.start();
  queued = await registerEda(
    `ws://127.0.0.1:${queuePort}/bridge/ws${tokenQuery}`,
    'queued-page',
  );
  let queuedTaskIndex = 0;
  queued.socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.type !== 'bridge/task') {
      return;
    }
    const taskIndex = queuedTaskIndex;
    queuedTaskIndex += 1;
    const queueDelayMs = taskIndex === 0 ? 0 : 100;
    setTimeout(() => {
      queued.socket.send(JSON.stringify({
        type: 'bridge/task-started',
        clientId: 'queued-page',
        requestId: message.requestId,
        leaseTerm: message.leaseTerm,
        startedAt: Date.now(),
      }));
      setTimeout(() => {
        queued.socket.send(JSON.stringify({
          type: 'bridge/result',
          clientId: 'queued-page',
          requestId: message.requestId,
          leaseTerm: message.leaseTerm,
          result: { taskIndex },
        }));
      }, 40);
    }, queueDelayMs);
  });
  const firstQueuedRequest = queueServer.request('/bridge/test/queued-1', {}, 80);
  const secondQueuedRequest = queueServer.request('/bridge/test/queued-2', {}, 80);
  assert.deepEqual(await firstQueuedRequest, { taskIndex: 0 });
  assert.deepEqual(await secondQueuedRequest, { taskIndex: 1 });
  queued.socket.close();
  queued = undefined;
  queueServer.close();
  queueServer = undefined;

  const recoveryPort = await reservePort();
  recoveryServer = new EdaBridgeServer(recoveryPort);
  await recoveryServer.start();
  stuck = await registerEda(
    `ws://127.0.0.1:${recoveryPort}/bridge/ws${tokenQuery}`,
    'stuck-page',
  );
  let receivedStuckTask = false;
  stuck.socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.type === 'bridge/task') {
      receivedStuckTask = true;
    }
  });
  replacement = await registerEda(
    `ws://127.0.0.1:${recoveryPort}/bridge/ws${tokenQuery}`,
    'replacement-page',
  );
  attachTaskResponder(replacement.socket, 'replacement-page', (message) => ({ source: 'replacement', path: message.path }));
  const stuckRequest = recoveryServer.request('/bridge/test/stuck', {}, 2000);
  await waitUntil(() => receivedStuckTask);
  await assert.rejects(
    recoveryServer.request('/bridge/admin/select-client', { clientId: 'replacement-page' }, 2000),
    /pending task/,
  );
  await recoveryServer.request('/bridge/admin/select-client', { clientId: 'replacement-page', force: true }, 2000);
  await assert.rejects(stuckRequest, /force-switched/);
  assert.deepEqual(
    await recoveryServer.request('/bridge/test/recovered', {}, 2000),
    { source: 'replacement', path: '/bridge/test/recovered' },
  );
  stuck.socket.close();
  stuck = undefined;
  replacement.socket.close();
  replacement = undefined;
  recoveryServer.close();
  recoveryServer = undefined;

  const disconnectPort = await reservePort();
  disconnectServer = new EdaBridgeServer(disconnectPort);
  await disconnectServer.start();
  disconnectActive = await registerEda(
    `ws://127.0.0.1:${disconnectPort}/bridge/ws${tokenQuery}`,
    'disconnect-active',
  );
  let receivedDisconnectedTask = false;
  disconnectActive.socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.type === 'bridge/task') {
      receivedDisconnectedTask = true;
    }
  });
  disconnectReplacement = await registerEda(
    `ws://127.0.0.1:${disconnectPort}/bridge/ws${tokenQuery}`,
    'disconnect-replacement',
  );
  attachTaskResponder(disconnectReplacement.socket, 'disconnect-replacement', (message) => ({
    source: 'disconnect-replacement',
    path: message.path,
  }));
  const mcpSocket = new WebSocket(`ws://127.0.0.1:${disconnectPort}/mcp-internal${tokenQuery}`);
  const mcpReady = waitForMessage(mcpSocket, (message) => message.type === 'bridge/internal-ready');
  await new Promise((resolve, reject) => {
    mcpSocket.once('open', resolve);
    mcpSocket.once('error', reject);
  });
  await mcpReady;
  mcpSocket.send(JSON.stringify({
    type: 'bridge/task',
    requestId: 'disconnected-mcp-request',
    path: '/bridge/test/disconnected',
    payload: {},
    timeoutMs: 15000,
  }));
  await waitUntil(() => receivedDisconnectedTask);
  mcpSocket.close();
  await waitUntil(async () => {
    try {
      await disconnectServer.request('/bridge/admin/select-client', { clientId: 'disconnect-replacement' }, 2000);
      return true;
    } catch {
      return false;
    }
  });
  assert.deepEqual(
    await disconnectServer.request('/bridge/test/disconnected-recovered', {}, 2000),
    { source: 'disconnect-replacement', path: '/bridge/test/disconnected-recovered' },
  );
  disconnectActive.socket.close();
  disconnectActive = undefined;
  disconnectReplacement.socket.close();
  disconnectReplacement = undefined;
  disconnectServer.close();
  disconnectServer = undefined;

  const reconnectPort = await reservePort();
  reconnectServer = new EdaBridgeServer(reconnectPort);
  await reconnectServer.start();
  reconnectOld = await registerEda(
    `ws://127.0.0.1:${reconnectPort}/bridge/ws${tokenQuery}`,
    'reconnect-page',
  );
  let receivedReconnectTask = false;
  reconnectOld.socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.type === 'bridge/task') {
      receivedReconnectTask = true;
    }
  });
  reconnectTarget = await registerEda(
    `ws://127.0.0.1:${reconnectPort}/bridge/ws${tokenQuery}`,
    'reconnect-target',
  );
  attachTaskResponder(reconnectTarget.socket, 'reconnect-target', (message) => ({
    source: 'reconnect-target',
    path: message.path,
  }));
  const reconnectPending = reconnectServer.request('/bridge/test/reconnect-pending', {}, 2000);
  const reconnectPendingAssertion = assert.rejects(reconnectPending, /reconnected/);
  await waitUntil(() => receivedReconnectTask);
  reconnectNew = await registerEda(
    `ws://127.0.0.1:${reconnectPort}/bridge/ws${tokenQuery}`,
    'reconnect-page',
  );
  await reconnectPendingAssertion;
  await reconnectServer.request('/bridge/admin/select-client', { clientId: 'reconnect-target' }, 2000);
  assert.deepEqual(
    await reconnectServer.request('/bridge/test/reconnect-recovered', {}, 2000),
    { source: 'reconnect-target', path: '/bridge/test/reconnect-recovered' },
  );
  reconnectOld.socket.close();
  reconnectOld = undefined;
  reconnectNew.socket.close();
  reconnectNew = undefined;
  reconnectTarget.socket.close();
  reconnectTarget = undefined;
  reconnectServer.close();
  reconnectServer = undefined;

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
  queued?.socket.close();
  stuck?.socket.close();
  replacement?.socket.close();
  disconnectActive?.socket.close();
  disconnectReplacement?.socket.close();
  reconnectOld?.socket.close();
  reconnectNew?.socket.close();
  reconnectTarget?.socket.close();
  expiryServer?.close();
  queueServer?.close();
  recoveryServer?.close();
  disconnectServer?.close();
  reconnectServer?.close();
  secondaryServer.close();
  mainServer.close();
  if (originalToken === undefined) {
    delete process.env.JLCEDA_BRIDGE_TOKEN;
  } else {
    process.env.JLCEDA_BRIDGE_TOKEN = originalToken;
  }
}
