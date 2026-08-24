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
let edaFirstServer;
let queuedDisconnectServer;
let reconnectServer;
let blue;
let red;
let queued;
let stuck;
let replacement;
let disconnectActive;
let disconnectReplacement;
let disconnectReconnected;
let edaFirstOld;
let edaFirstNew;
let queuedDisconnectOld;
let queuedDisconnectNew;
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
    { documentUuid: 'recovery-document', projectUuid: 'recovery-project', pageKind: 'schematic', pageUuid: 'recovery-page' },
  );
  let receivedStuckTask = false;
  stuck.socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.type === 'bridge/task') {
      receivedStuckTask = true;
      stuck.socket.send(JSON.stringify({
        type: 'bridge/task-started',
        clientId: 'stuck-page',
        requestId: message.requestId,
        leaseTerm: message.leaseTerm,
        startedAt: Date.now(),
      }));
    }
  });
  replacement = await registerEda(
    `ws://127.0.0.1:${recoveryPort}/bridge/ws${tokenQuery}`,
    'replacement-page',
    { documentUuid: 'recovery-document', projectUuid: 'recovery-project', pageKind: 'schematic', pageUuid: 'recovery-page' },
  );
  attachTaskResponder(replacement.socket, 'replacement-page', (message) => message.path === '/bridge/jlceda/context'
    ? { currentDocumentInfo: { uuid: 'recovery-document', parentProjectUuid: 'recovery-project' }, currentProjectInfo: { uuid: 'recovery-project' } }
    : ({ source: 'replacement', path: message.path }));
  const stuckRequest = recoveryServer.request('/bridge/jlceda/api/invoke', {}, 100);
  await waitUntil(() => receivedStuckTask);
  await assert.rejects(
    recoveryServer.request('/bridge/admin/select-client', { clientId: 'replacement-page' }, 2000),
    /pending task/,
  );
  await assert.rejects(stuckRequest, /Request execution timeout/);
  const recoveryMessagePromise = waitForMessage(stuck.socket, (message) => message.type === 'bridge/recover');
  const recoveryStart = await recoveryServer.request('/bridge/admin/recover-client', { confirm: true }, 2000);
  assert.equal(recoveryStart.readbackRequired, true);
  assert.match(recoveryStart.warning, /may have completed/);
  assert.equal(recoveryStart.diagnostic.mutating, true);
  const recoveryMessage = await recoveryMessagePromise;
  assert.equal(recoveryMessage.recoveryId, recoveryStart.recoveryId);
  stuck.socket.close();
  stuck = undefined;
  const freshRecoveryClient = await registerEda(
    `ws://127.0.0.1:${recoveryPort}/bridge/ws${tokenQuery}`,
    'recovered-page',
    { documentUuid: 'recovery-document', projectUuid: 'recovery-project', pageKind: 'schematic', pageUuid: 'recovery-page' },
  );
  attachTaskResponder(freshRecoveryClient.socket, 'recovered-page', (message) => message.path === '/bridge/jlceda/context'
    ? { currentDocumentInfo: { uuid: 'recovery-document', parentProjectUuid: 'recovery-project' }, currentProjectInfo: { uuid: 'recovery-project' } }
    : ({ source: 'replacement', path: message.path }));
  await assert.rejects(
    recoveryServer.request('/bridge/test/write-blocked', {}, 2000),
    /writes are blocked pending recovery readback/,
  );
  const recoveryReadback = await recoveryServer.request('/bridge/admin/recover-client', {
    action: 'readback',
    confirm: true,
    recoveryId: recoveryStart.recoveryId,
    clientId: 'recovered-page',
    expectedDocumentUuid: 'recovery-document',
    expectedProjectUuid: 'recovery-project',
  }, 2000);
  assert.equal(recoveryReadback.readbackVerified, true);
  assert.deepEqual(
    await recoveryServer.request('/bridge/test/recovery-write-after-readback', {}, 2000),
    { source: 'replacement', path: '/bridge/test/recovery-write-after-readback' },
  );
  freshRecoveryClient.socket.close();
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
      disconnectActive.socket.send(JSON.stringify({
        type: 'bridge/task-started',
        clientId: 'disconnect-active',
        requestId: message.requestId,
        leaseTerm: message.leaseTerm,
        startedAt: Date.now(),
      }));
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
    path: '/bridge/jlceda/api/invoke',
    payload: {},
    timeoutMs: 300,
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
  disconnectReconnected = await registerEda(
    `ws://127.0.0.1:${disconnectPort}/bridge/ws${tokenQuery}`,
    'disconnect-active',
  );
  attachTaskResponder(disconnectReconnected.socket, 'disconnect-active', (message) => ({
    source: 'disconnect-reconnected',
    path: message.path,
  }));
  await disconnectServer.request('/bridge/admin/select-client', { clientId: 'disconnect-active' }, 2000);
  await assert.rejects(
    disconnectServer.request('/bridge/jlceda/api/invoke', {}, 2000),
    /quarantined after reconnect/,
  );
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.deepEqual(
    await disconnectServer.request('/bridge/jlceda/api/invoke', {}, 2000),
    { source: 'disconnect-reconnected', path: '/bridge/jlceda/api/invoke' },
  );
  disconnectActive.socket.close();
  disconnectActive = undefined;
  disconnectReplacement.socket.close();
  disconnectReplacement = undefined;
  disconnectReconnected.socket.close();
  disconnectReconnected = undefined;
  disconnectServer.close();
  disconnectServer = undefined;

  const edaFirstPort = await reservePort();
  edaFirstServer = new EdaBridgeServer(edaFirstPort);
  await edaFirstServer.start();
  edaFirstOld = await registerEda(
    `ws://127.0.0.1:${edaFirstPort}/bridge/ws${tokenQuery}`,
    'eda-first-page',
  );
  let receivedEdaFirstTask = false;
  edaFirstOld.socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.type === 'bridge/task') {
      receivedEdaFirstTask = true;
      edaFirstOld.socket.send(JSON.stringify({
        type: 'bridge/task-started',
        clientId: 'eda-first-page',
        requestId: message.requestId,
        leaseTerm: message.leaseTerm,
        startedAt: Date.now(),
      }));
    }
  });
  const edaFirstPending = edaFirstServer.request('/bridge/jlceda/api/invoke', {}, 300);
  await waitUntil(() => receivedEdaFirstTask);
  edaFirstOld.socket.close();
  await assert.rejects(edaFirstPending, /disconnected/);
  await waitUntil(async () => {
    const snapshot = await edaFirstServer.request('/bridge/admin/clients', {}, 2000);
    return snapshot.clients.length === 0;
  });
  edaFirstNew = await registerEda(
    `ws://127.0.0.1:${edaFirstPort}/bridge/ws${tokenQuery}`,
    'eda-first-page',
  );
  attachTaskResponder(edaFirstNew.socket, 'eda-first-page', (message) => ({
    source: 'eda-first-reconnected',
    path: message.path,
  }));
  await assert.rejects(
    edaFirstServer.request('/bridge/jlceda/api/invoke', {}, 2000),
    /quarantined after reconnect/,
  );
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.deepEqual(
    await edaFirstServer.request('/bridge/jlceda/api/invoke', {}, 2000),
    { source: 'eda-first-reconnected', path: '/bridge/jlceda/api/invoke' },
  );
  edaFirstOld = undefined;
  edaFirstNew.socket.close();
  edaFirstNew = undefined;
  edaFirstServer.close();
  edaFirstServer = undefined;

  const queuedDisconnectPort = await reservePort();
  queuedDisconnectServer = new EdaBridgeServer(queuedDisconnectPort);
  await queuedDisconnectServer.start();
  queuedDisconnectOld = await registerEda(
    `ws://127.0.0.1:${queuedDisconnectPort}/bridge/ws${tokenQuery}`,
    'queued-disconnect-page',
  );
  let queuedDisconnectTaskCount = 0;
  let queuedDisconnectFirstStarted = false;
  let queuedDisconnectSecondReceived = false;
  queuedDisconnectOld.socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.type !== 'bridge/task') {
      return;
    }
    const taskIndex = queuedDisconnectTaskCount;
    queuedDisconnectTaskCount += 1;
    if (taskIndex === 0) {
      queuedDisconnectFirstStarted = true;
      queuedDisconnectOld.socket.send(JSON.stringify({
        type: 'bridge/task-started',
        clientId: 'queued-disconnect-page',
        requestId: message.requestId,
        leaseTerm: message.leaseTerm,
        startedAt: Date.now(),
      }));
      return;
    }
    queuedDisconnectSecondReceived = true;
  });
  const queuedDisconnectFirst = queuedDisconnectServer.request('/bridge/jlceda/api/invoke', {}, 600);
  const queuedDisconnectSecond = queuedDisconnectServer.request('/bridge/jlceda/api/invoke', {}, 600);
  await waitUntil(() => queuedDisconnectFirstStarted && queuedDisconnectSecondReceived);
  queuedDisconnectOld.socket.close();
  await assert.rejects(queuedDisconnectFirst, /disconnected/);
  await assert.rejects(queuedDisconnectSecond, /disconnected/);
  await waitUntil(async () => {
    const snapshot = await queuedDisconnectServer.request('/bridge/admin/clients', {}, 2000);
    return snapshot.clients.length === 0;
  });
  queuedDisconnectNew = await registerEda(
    `ws://127.0.0.1:${queuedDisconnectPort}/bridge/ws${tokenQuery}`,
    'queued-disconnect-page',
  );
  attachTaskResponder(queuedDisconnectNew.socket, 'queued-disconnect-page', (message) => ({
    source: 'queued-disconnect-reconnected',
    path: message.path,
  }));
  await assert.rejects(
    queuedDisconnectServer.request('/bridge/jlceda/api/invoke', {}, 2000),
    /quarantined after reconnect/,
  );
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.deepEqual(
    await queuedDisconnectServer.request('/bridge/jlceda/api/invoke', {}, 2000),
    { source: 'queued-disconnect-reconnected', path: '/bridge/jlceda/api/invoke' },
  );
  queuedDisconnectOld = undefined;
  queuedDisconnectNew.socket.close();
  queuedDisconnectNew = undefined;
  queuedDisconnectServer.close();
  queuedDisconnectServer = undefined;

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
      reconnectOld.socket.send(JSON.stringify({
        type: 'bridge/task-started',
        clientId: 'reconnect-page',
        requestId: message.requestId,
        leaseTerm: message.leaseTerm,
        startedAt: Date.now(),
      }));
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
  const reconnectPending = reconnectServer.request('/bridge/jlceda/api/invoke', {}, 1000);
  const reconnectPendingAssertion = assert.rejects(reconnectPending, /reconnected/);
  await waitUntil(() => receivedReconnectTask);
  reconnectNew = await registerEda(
    `ws://127.0.0.1:${reconnectPort}/bridge/ws${tokenQuery}`,
    'reconnect-page',
  );
  attachTaskResponder(reconnectNew.socket, 'reconnect-page', (message) => ({
    source: 'reconnect-page-new',
    path: message.path,
  }));
  await reconnectPendingAssertion;
  await reconnectServer.request('/bridge/admin/select-client', { clientId: 'reconnect-target' }, 2000);
  assert.deepEqual(
    await reconnectServer.request('/bridge/test/reconnect-recovered', {}, 2000),
    { source: 'reconnect-target', path: '/bridge/test/reconnect-recovered' },
  );
  await reconnectServer.request('/bridge/admin/select-client', { clientId: 'reconnect-page' }, 2000);
  await assert.rejects(
    reconnectServer.request('/bridge/jlceda/api/invoke', {}, 2000),
    /quarantined after reconnect/,
  );
  await new Promise((resolve) => setTimeout(resolve, 1050));
  assert.deepEqual(
    await reconnectServer.request('/bridge/jlceda/api/invoke', {}, 2000),
    { source: 'reconnect-page-new', path: '/bridge/jlceda/api/invoke' },
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
  disconnectReconnected?.socket.close();
  edaFirstOld?.socket.close();
  edaFirstNew?.socket.close();
  queuedDisconnectOld?.socket.close();
  queuedDisconnectNew?.socket.close();
  reconnectOld?.socket.close();
  reconnectNew?.socket.close();
  reconnectTarget?.socket.close();
  expiryServer?.close();
  queueServer?.close();
  recoveryServer?.close();
  disconnectServer?.close();
  edaFirstServer?.close();
  queuedDisconnectServer?.close();
  reconnectServer?.close();
  secondaryServer.close();
  mainServer.close();
  if (originalToken === undefined) {
    delete process.env.JLCEDA_BRIDGE_TOKEN;
  } else {
    process.env.JLCEDA_BRIDGE_TOKEN = originalToken;
  }
}
