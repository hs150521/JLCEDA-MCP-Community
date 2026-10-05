import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { WebSocket } from 'ws';
import { EdaBridgeServer } from '../dist/mcp/bridge-client.js';
import { BRIDGE_CONTRACT, footprintApiAccess, isReadOnlyBridgeRequest, validateBridgeClientMessage } from '../dist/mcp/bridge-contract.js';
import { ToolDispatcher } from '../dist/mcp/tool-dispatcher.js';

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

async function registerEda(url, clientId, context = undefined, sendInitialHeartbeat = true, probeMode = 'ack') {
  const socket = await connect(url);
  if (probeMode === 'ack') {
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === 'bridge/probe' && message.clientId === clientId)
        socket.send(JSON.stringify({ type: 'bridge/probe-ack', clientId, probeId: message.probeId }));
    });
  }
  const welcome = waitForMessage(socket, (message) => message.type === 'bridge/welcome');
  const role = waitForMessage(socket, (message) => message.type === 'bridge/role');
  socket.send(JSON.stringify({ type: 'bridge/hello', clientId, bridgeVersion: '2.1.0', context,
    ...(probeMode === 'legacy' ? {} : { selectionProbeVersion: 1 }) }));
  const welcomeMessage = await welcome;
  assert.equal(welcomeMessage.clientId, clientId);
  assert.equal(welcomeMessage.protocolVersion, 1);
  const initialRole = await role;
  socket.send(JSON.stringify({ type: 'bridge/ready', clientId, readyAt: Date.now() }));
  if (sendInitialHeartbeat) {
    const heartbeat = waitForMessage(socket, (message) => message.type === 'bridge/heartbeat-ack');
    socket.send(JSON.stringify({ type: 'bridge/heartbeat', clientId, sentAt: Date.now() }));
    await heartbeat;
  }
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
let livenessServer;
let queueServer;
let connectivityServer;
let recoveryServer;
let disconnectServer;
let edaFirstServer;
let queuedDisconnectServer;
let reconnectServer;
let blue;
let red;
let queued;
let connectivityClient;
let stuck;
let replacement;
let wrongRecoveryPage;
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
let disconnectedRecoveryServer;
let disconnectedRecoveryOld;
let disconnectedRecoveryTarget;
let disconnectedRecoveryFresh;
let nativeLayoutServer;
let nativeLayoutOld;
let nativeLayoutNew;
let lateUnknownServer;
let lateUnknownClient;
let lateConnectivityServer;
let lateConnectivityActive;
let lateConnectivityStandby;
let unverifiedWriteServer;
let unverifiedWriteActive;
let unverifiedWriteStandby;

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
    await secondaryServer.request('/bridge/jlceda/api/invoke', { value: 3 }, 2000),
    { source: 'red', path: '/bridge/jlceda/api/invoke' },
  );

  const forwardingPort = await reservePort();
  const forwardingMain = new EdaBridgeServer(forwardingPort);
  const forwardingSecondary = new EdaBridgeServer(forwardingPort);
  let forwardingEda;
  try {
    await forwardingMain.start();
    forwardingEda = await registerEda(
      `ws://127.0.0.1:${forwardingPort}/bridge/ws${tokenQuery}`,
      'forwarding-page',
    );
    await forwardingSecondary.start();
    assert.equal(forwardingSecondary.getMode(), 'client');

    let receivedFirstForwardedTask = false;
    let receivedSecondForwardedTask = false;
    let firstForwardedRequest;
    let secondForwardedRequest;
    let forwardedTaskCount = 0;
    forwardingEda.socket.on('message', (data) => {
      const message = JSON.parse(data.toString());
      if (message.type !== 'bridge/task') {
        return;
      }
      const taskIndex = forwardedTaskCount;
      forwardedTaskCount += 1;
      if (taskIndex === 0) {
        firstForwardedRequest = message;
        receivedFirstForwardedTask = true;
        forwardingEda.socket.send(JSON.stringify({
          type: 'bridge/task-started',
          clientId: 'forwarding-page',
          requestId: message.requestId,
          leaseTerm: message.leaseTerm,
          startedAt: Date.now(),
        }));
        setTimeout(() => {
          forwardingEda.socket.send(JSON.stringify({
            type: 'bridge/result',
            clientId: 'forwarding-page',
            requestId: message.requestId,
            leaseTerm: message.leaseTerm,
            result: { task: 'first' },
          }));
          forwardingEda.socket.send(JSON.stringify({
            type: 'bridge/task-started',
            clientId: 'forwarding-page',
            requestId: secondForwardedRequest.requestId,
            leaseTerm: secondForwardedRequest.leaseTerm,
            startedAt: Date.now(),
          }));
          setTimeout(() => {
            forwardingEda.socket.send(JSON.stringify({
              type: 'bridge/result',
              clientId: 'forwarding-page',
              requestId: secondForwardedRequest.requestId,
              leaseTerm: secondForwardedRequest.leaseTerm,
              result: { task: 'second' },
            }));
          }, 15);
        }, 140);
        return;
      }
      if (taskIndex === 1) {
        secondForwardedRequest = message;
        receivedSecondForwardedTask = true;
        return;
      }
      forwardingEda.socket.send(JSON.stringify({
        type: 'bridge/task-started',
        clientId: 'forwarding-page',
        requestId: message.requestId,
        leaseTerm: message.leaseTerm,
        startedAt: Date.now(),
      }));
      setTimeout(() => {
        forwardingEda.socket.send(JSON.stringify({
          type: 'bridge/task-started',
          clientId: 'forwarding-page',
          requestId: message.requestId,
          leaseTerm: message.leaseTerm,
          startedAt: Date.now(),
        }));
      }, 20);
      if (taskIndex === 2) {
        setTimeout(() => {
          forwardingEda.socket.send(JSON.stringify({
            type: 'bridge/result',
            clientId: 'forwarding-page',
            requestId: message.requestId,
            leaseTerm: message.leaseTerm,
            result: { task: 'late-after-duplicate-started' },
          }));
        }, 60);
      }
    });

    const firstForwarded = forwardingMain.request('/bridge/jlceda/api/invoke', { marker: 'first' }, 500);
    await waitUntil(() => receivedFirstForwardedTask);
    const secondForwarded = forwardingSecondary.request('/bridge/jlceda/api/invoke', { marker: 'second' }, 50);
    let secondForwardedOutcome = 'pending';
    void secondForwarded.then(
      () => { secondForwardedOutcome = 'resolved'; },
      () => { secondForwardedOutcome = 'rejected'; },
    );
    await waitUntil(() => receivedSecondForwardedTask);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(secondForwardedOutcome, 'pending', 'client mode must not apply execution timeout while the main server queues the task');
    assert.deepEqual(await firstForwarded, { task: 'first' });
    assert.deepEqual(await secondForwarded, { task: 'second' });
    const duplicateStartedSocket = new WebSocket(`ws://127.0.0.1:${forwardingPort}/mcp-internal${tokenQuery}`);
    const duplicateStartedReady = waitForMessage(duplicateStartedSocket, (message) => message.type === 'bridge/internal-ready');
    await new Promise((resolve, reject) => {
      duplicateStartedSocket.once('open', resolve);
      duplicateStartedSocket.once('error', reject);
    });
    await duplicateStartedReady;
    const duplicateStartedResult = waitForMessage(
      duplicateStartedSocket,
      (message) => message.type === 'bridge/result' && message.requestId === 'duplicate-started-request',
    );
    duplicateStartedSocket.send(JSON.stringify({
      type: 'bridge/task',
      requestId: 'duplicate-started-request',
      path: '/bridge/jlceda/context',
      payload: { marker: 'duplicate-started' },
      timeoutMs: 50,
    }));
    assert.match(String((await duplicateStartedResult).error), /Request execution timeout after 50ms/);
    duplicateStartedSocket.close();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await assert.rejects(
      forwardingSecondary.request('/bridge/jlceda/context', { marker: 'started-without-result' }, 50),
      /(?:Internal bridge request execution timeout|Request execution timeout) after 50ms/,
    );
  } finally {
    forwardingEda?.socket.close();
    forwardingSecondary.close();
    forwardingMain.close();
  }

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

  const connectivityPath = '/bridge/jlceda/schematic/connectivity';
  assert.equal(validateBridgeClientMessage({
    type: 'bridge/task-started', clientId: 'pcb-client', requestId: 'layout-1', leaseTerm: 1, startedAt: Date.now(),
    context: { pageKind: 'pcb', pageUuid: 'actual-pcb', documentUuid: 'actual-document' },
  }), undefined);
  for (const schematicPinAdapter of ['component_pin_instance', 'native_pin']) {
    assert.equal(validateBridgeClientMessage({ type: 'bridge/task-started', clientId: 'pin-client', requestId: 'pin-1',
      leaseTerm: 1, startedAt: Date.now(), schematicPinAdapter }), undefined);
  }
  assert.equal(validateBridgeClientMessage({ type: 'bridge/task-started', clientId: 'footprint-client', requestId: 'footprint-1',
    leaseTerm: 1, startedAt: Date.now(), context: { pageKind: 'footprint', documentType: 4, documentUuid: 'fp', pageUuid: 'fp', libraryUuid: 'lib', tabId: 'tab' } }), undefined);
  assert.equal(BRIDGE_CONTRACT.footprintApi.readOnlyApiFullNames.length, 21);
  assert.equal(BRIDGE_CONTRACT.footprintApi.mutatingApiFullNames.length, 20);
  for (const name of BRIDGE_CONTRACT.footprintApi.readOnlyApiFullNames) {
    assert.equal(footprintApiAccess(name), 'read');
    assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/api/invoke', { apiFullName: name, args: ['primitive-1'] }), true);
  }
  for (const name of BRIDGE_CONTRACT.footprintApi.mutatingApiFullNames) assert.equal(footprintApiAccess(name), 'write');
  assert.equal(footprintApiAccess('eda.pcb_PrimitiveAttribute.create'), undefined);
  assert.match(validateBridgeClientMessage({ type: 'bridge/task-started', clientId: 'pin-client', requestId: 'pin-1',
    leaseTerm: 1, startedAt: Date.now(), schematicPinAdapter: 'unknown' }), /schematicPinAdapter/);
  for (const action of ['navigate_to_coordinates', 'navigate_to_region', 'zoom_to_board_outline']) {
    assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/pcb/document', { action }), true);
  }
  for (const action of ['select_primitives', 'clear_selection', 'start_ratline', 'stop_ratline', 'save', 'import_changes']) {
    assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/pcb/document', { action }), false);
  }
  for (const action of [undefined, 'status', 'selection', 'primitive_by_id', 'navigate_to_coordinates', 'navigate_to_region']) {
    assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/schematic/document', action === undefined ? {} : { action }), true);
  }
  for (const action of ['select_primitives', 'clear_selection', 'save', 'import_changes']) {
    assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/schematic/document', { action }), false);
  }
  assert.equal(isReadOnlyBridgeRequest(connectivityPath, { action: 'wire_preview' }), true);
  for (const action of ['wire_create', 'netport_create', 'netport_move']) {
    assert.equal(isReadOnlyBridgeRequest(connectivityPath, { action }), false);
  }
  assert.equal(isReadOnlyBridgeRequest(connectivityPath, {}), false);
  assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/pcb/connectivity', { action: 'line_create' }), false);
  assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/pcb/connectivity', { action: 'via_create' }), false);
  assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/component/place/check', { sessionId: 'session-1' }), false);
  const invokePath = '/bridge/jlceda/api/invoke';
  assert.equal(isReadOnlyBridgeRequest(invokePath, { apiFullName: 'eda.pcb_primitivecomponent.getall', args: [] }), true);
  for (const apiFullName of ['eda.pcb_PrimitiveLine.getAll', 'eda.pcb_PrimitiveArc.getAll', 'eda.pcb_PrimitivePolyline.getAll', 'eda.pcb_PrimitiveVia.getAll']) {
    assert.equal(isReadOnlyBridgeRequest(invokePath, { apiFullName, args: [] }), true);
    assert.equal(isReadOnlyBridgeRequest(invokePath, { apiFullName, args: ['VCC'] }), true);
  }
  assert.equal(isReadOnlyBridgeRequest(invokePath, { apiFullName: ' EDA.SCH_PRIMITIVECOMPONENT.GETALL ', args: [null, false] }), true);
  assert.equal(isReadOnlyBridgeRequest(invokePath, { apiFullName: 'EDA.SCH_PRIMITIVECOMPONENT.GETALL', args: [null, true] }), false);
  assert.equal(isReadOnlyBridgeRequest(invokePath, { apiFullName: 'EDA.SCH_PRIMITIVECOMPONENT.CREATE', args: [] }), false);
  const connectivityPort = await reservePort();
  connectivityServer = new EdaBridgeServer(connectivityPort);
  await connectivityServer.start();
  connectivityClient = await registerEda(
    `ws://127.0.0.1:${connectivityPort}/bridge/ws${tokenQuery}`,
    'connectivity-page',
  );
  let previewTasksStarted = 0;
  connectivityClient.socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.type !== 'bridge/task') return;
    connectivityClient.socket.send(JSON.stringify({
      type: 'bridge/task-started',
      clientId: 'connectivity-page',
      requestId: message.requestId,
      leaseTerm: message.leaseTerm,
      startedAt: Date.now(),
    }));
    if (message.payload.action === 'wire_preview') {
      previewTasksStarted += 1;
      return;
    }
    connectivityClient.socket.send(JSON.stringify({
      type: 'bridge/result',
      clientId: 'connectivity-page',
      requestId: message.requestId,
      leaseTerm: message.leaseTerm,
      result: { action: message.payload.action },
    }));
  });
  const previewPayload = { action: 'wire_preview', line: [0, 0, 10, 0] };
  const timedOutPreview = assert.rejects(
    connectivityServer.request(connectivityPath, previewPayload, 100),
    /Request execution timeout/,
  );
  await waitUntil(() => previewTasksStarted === 1);
  await timedOutPreview;
  const timeoutSnapshot = await connectivityServer.request('/bridge/admin/clients', {}, 2000);
  const timeoutDiagnostics = timeoutSnapshot.clients[0].quarantine.diagnostics;
  assert.equal(timeoutDiagnostics.length, 1);
  assert.equal(timeoutDiagnostics[0].mutating, false);
  await new Promise((resolve) => setTimeout(resolve, 125));
  assert.deepEqual(
    await connectivityServer.request(connectivityPath, { action: 'wire_create', line: [0, 0, 10, 0] }, 2000),
    { action: 'wire_create' },
  );
  const disconnectedPreview = assert.rejects(
    connectivityServer.request(connectivityPath, previewPayload, 2000),
    /disconnected/,
  );
  await waitUntil(() => previewTasksStarted === 2);
  const previewStartedAck = waitForMessage(connectivityClient.socket, message => message.type === 'bridge/heartbeat-ack');
  connectivityClient.socket.send(JSON.stringify({ type: 'bridge/heartbeat', clientId: 'connectivity-page', sentAt: Date.now() }));
  await previewStartedAck;
  connectivityClient.socket.close();
  await disconnectedPreview;
  const disconnectSnapshot = await connectivityServer.request('/bridge/admin/clients', {}, 2000);
  const disconnectDiagnostics = disconnectSnapshot.clients.find(client => client.clientId === 'connectivity-page').quarantine.diagnostics;
  assert.equal(disconnectDiagnostics.length, 1, 'Disconnecting a started preview must not add a mutation diagnostic');
  assert.equal(disconnectDiagnostics[0].mutating, false);
  connectivityClient = undefined;
  connectivityServer.close();
  connectivityServer = undefined;

  const recoveryPort = await reservePort();
  recoveryServer = new EdaBridgeServer(recoveryPort);
  await recoveryServer.start();
  stuck = await registerEda(
    `ws://127.0.0.1:${recoveryPort}/bridge/ws${tokenQuery}`,
    'stuck-page',
    { documentUuid: 'stale-recovery-document', projectUuid: 'stale-recovery-project', pageKind: 'schematic', pageUuid: 'stale-recovery-page' },
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
        context: { documentUuid: 'recovery-document', projectUuid: 'recovery-project', pageKind: 'schematic', pageUuid: 'recovery-page' },
      }));
      setTimeout(() => {
        if (stuck.socket.readyState === WebSocket.OPEN) {
          stuck.socket.send(JSON.stringify({
            type: 'bridge/result',
            clientId: 'stuck-page',
            requestId: message.requestId,
            leaseTerm: message.leaseTerm,
            error: {
              message: `Bridge task timed out after 50ms: ${message.path}`,
              code: 'BRIDGE_TASK_TIMEOUT',
              timeoutMs: 50,
            },
          }));
        }
      }, 50);
    }
  });
  replacement = await registerEda(
    `ws://127.0.0.1:${recoveryPort}/bridge/ws${tokenQuery}`,
    'replacement-page',
    { documentUuid: 'recovery-document', projectUuid: 'recovery-project', pageKind: 'schematic', pageUuid: 'recovery-page' },
  );
  attachTaskResponder(replacement.socket, 'replacement-page', (message) => message.path === '/bridge/jlceda/context'
    ? { currentDocumentInfo: { uuid: 'recovery-document', parentProjectUuid: 'recovery-project' }, currentProjectInfo: { uuid: 'recovery-project' }, currentSchematicPageInfo: { uuid: 'recovery-page' } }
    : ({ source: 'replacement', path: message.path }));
  const stuckRequest = recoveryServer.request('/bridge/jlceda/schematic/layout-check', { mode: 'fix', confirm: true }, 100);
  await waitUntil(() => receivedStuckTask);
  await assert.rejects(
    recoveryServer.request('/bridge/admin/select-client', { clientId: 'replacement-page' }, 2000),
    /pending task/,
  );
  await assert.rejects(stuckRequest, /Bridge task timed out/);
  const recoverySnapshot = await recoveryServer.request('/bridge/admin/clients', {}, 2000);
  const recoveryRequestId = recoverySnapshot.clients
    .find((client) => client.clientId === 'stuck-page')
    .quarantine.diagnostics
    .find((diagnostic) => diagnostic.mutating)
    .requestId;
  const recoveryMessagePromise = waitForMessage(stuck.socket, (message) => message.type === 'bridge/recover');
  const recoveryStart = await recoveryServer.request('/bridge/admin/recover-client', { confirm: true, requestId: recoveryRequestId }, 2000);
  assert.equal(recoveryStart.readbackRequired, true);
  assert.match(recoveryStart.warning, /may have completed/);
  assert.equal(recoveryStart.diagnostic.mutating, true);
  assert.equal(recoveryStart.diagnostic.path, '/bridge/jlceda/schematic/layout-check');
  assert.equal(recoveryStart.diagnostic.timeoutMs, 50);
  assert.equal(recoveryStart.diagnostic.context.pageUuid, 'recovery-page', 'write timeout must use the execution page rather than the heartbeat page');
  assert.equal(recoveryStart.diagnostic.context.documentUuid, 'recovery-document');
  const recoveryMessage = await recoveryMessagePromise;
  assert.equal(recoveryMessage.recoveryId, recoveryStart.recoveryId);
  const earlyRecoveryTarget = await registerEda(
    `ws://127.0.0.1:${recoveryPort}/bridge/ws${tokenQuery}`,
    'early-recovery-page',
    { documentUuid: 'recovery-document', projectUuid: 'recovery-project', pageKind: 'schematic', pageUuid: 'recovery-page' },
  );
  attachTaskResponder(earlyRecoveryTarget.socket, 'early-recovery-page', () => ({
    currentDocumentInfo: { uuid: 'recovery-document', parentProjectUuid: 'recovery-project' },
    currentProjectInfo: { uuid: 'recovery-project' },
    currentSchematicPageInfo: { uuid: 'recovery-page' },
  }));
  await assert.rejects(recoveryServer.request('/bridge/admin/recover-client', {
    action: 'readback', confirm: true, recoveryId: recoveryStart.recoveryId,
    clientId: 'early-recovery-page', readbackPath: '/bridge/jlceda/context',
  }, 2000), /original Bridge client must disconnect/);
  await assert.rejects(recoveryServer.request('/bridge/test/write-before-source-disconnect', {}, 2000), /writes are blocked pending recovery readback/);
  earlyRecoveryTarget.socket.close();
  stuck.socket.close();
  stuck = undefined;
  wrongRecoveryPage = await registerEda(
    `ws://127.0.0.1:${recoveryPort}/bridge/ws${tokenQuery}`,
    'wrong-recovery-page',
    { documentUuid: 'recovery-document', projectUuid: 'recovery-project', pageKind: 'schematic', pageUuid: 'another-page' },
  );
  await assert.rejects(recoveryServer.request('/bridge/admin/recover-client', {
    action: 'readback',
    confirm: true,
    recoveryId: recoveryStart.recoveryId,
    clientId: 'wrong-recovery-page',
    expectedPageUuid: 'another-page',
  }, 2000), /expectedPageUuid does not match/);
  const freshRecoveryClient = await registerEda(
    `ws://127.0.0.1:${recoveryPort}/bridge/ws${tokenQuery}`,
    'recovered-page',
    { documentUuid: 'recovery-document', projectUuid: 'recovery-project', pageKind: 'schematic', pageUuid: 'recovery-page' },
  );
  let recoveryReadbackPageUuid = 'recovery-page';
  let failRecoveryReadback = false;
  attachTaskResponder(freshRecoveryClient.socket, 'recovered-page', (message) => {
    if (message.path === '/bridge/jlceda/context') {
      return { currentDocumentInfo: { uuid: 'recovery-document', parentProjectUuid: 'recovery-project' }, currentProjectInfo: { uuid: 'recovery-project' }, currentSchematicPageInfo: { uuid: recoveryReadbackPageUuid } };
    }
    if (failRecoveryReadback && message.path === '/bridge/jlceda/api/invoke') {
      return { ok: false, error: 'component readback failed' };
    }
    return { source: 'replacement', path: message.path };
  });
  assert.deepEqual(
    await recoveryServer.request('/bridge/jlceda/context', {}, 2000),
    { currentDocumentInfo: { uuid: 'recovery-document', parentProjectUuid: 'recovery-project' }, currentProjectInfo: { uuid: 'recovery-project' }, currentSchematicPageInfo: { uuid: 'recovery-page' } },
  );
  await assert.rejects(
    recoveryServer.request('/bridge/test/write-blocked', {}, 2000),
    /writes are blocked pending recovery readback/,
  );
  assert.deepEqual(
    await recoveryServer.request('/bridge/jlceda/api/invoke', { apiFullName: 'eda.sch_PrimitiveComponent.getAllPrimitiveId', args: [null, false] }, 2000),
    { source: 'replacement', path: '/bridge/jlceda/api/invoke' },
  );
  assert.deepEqual(
    await recoveryServer.request('/bridge/jlceda/api/invoke', { apiFullName: 'eda.sch_PrimitiveComponent.getAllPrimitiveId', args: [] }, 2000),
    { source: 'replacement', path: '/bridge/jlceda/api/invoke' },
  );
  assert.deepEqual(
    await recoveryServer.request(connectivityPath, previewPayload, 2000),
    { source: 'replacement', path: connectivityPath },
  );
  for (const action of ['wire_create', 'netport_create', 'netport_move']) {
    await assert.rejects(
      recoveryServer.request(connectivityPath, { action }, 2000),
      /writes are blocked pending recovery readback/,
    );
  }
  assert.deepEqual(
    await recoveryServer.request('/bridge/jlceda/api/invoke', { apiFullName: 'eda.sch_PrimitiveComponent.getAll', args: [null, false] }, 2000),
    { source: 'replacement', path: '/bridge/jlceda/api/invoke' },
  );
  assert.deepEqual(
    await recoveryServer.request('/bridge/jlceda/api/invoke', { apiFullName: 'eda.pcb_PrimitiveComponent.getAll', args: [] }, 2000),
    { source: 'replacement', path: '/bridge/jlceda/api/invoke' },
  );
  await assert.rejects(
    recoveryServer.request('/bridge/jlceda/api/invoke', { apiFullName: 'eda.pcb_PrimitiveComponent.getAll', args: [1, false] }, 2000),
    /writes are blocked pending recovery readback/,
  );
  await assert.rejects(
    recoveryServer.request('/bridge/jlceda/api/invoke', { apiFullName: 'eda.sch_PrimitiveComponent.getAll', args: [null, true] }, 2000),
    /writes are blocked pending recovery readback/,
  );
  await assert.rejects(
    recoveryServer.request('/bridge/jlceda/api/invoke', { apiFullName: 'eda.sch_PrimitiveComponent.getAll', args: [1, false] }, 2000),
    /writes are blocked pending recovery readback/,
  );
  await assert.rejects(
    recoveryServer.request('/bridge/admin/recover-client', {
      action: 'readback',
      confirm: true,
      recoveryId: recoveryStart.recoveryId,
      clientId: 'recovered-page',
      expectedDocumentUuid: 'recovery-document',
      expectedProjectUuid: 'recovery-project',
      readbackPath: '/bridge/jlceda/schematic/layout-check',
      readbackPayload: { mode: 'fix', confirm: true },
    }, 2000),
    /read-only operation/,
  );
  const recoveryReadbackRequest = {
    action: 'readback',
    confirm: true,
    recoveryId: recoveryStart.recoveryId,
    clientId: 'recovered-page',
    expectedDocumentUuid: 'recovery-document',
    expectedProjectUuid: 'recovery-project',
    readbackPath: '/bridge/jlceda/api/invoke',
    readbackPayload: { apiFullName: 'eda.sch_PrimitiveComponent.getAllPrimitiveId', args: [null, false] },
  };
  recoveryReadbackPageUuid = 'another-page';
  await assert.rejects(
    recoveryServer.request('/bridge/admin/recover-client', recoveryReadbackRequest, 2000),
    /Readback pageUuid does not match/,
  );
  await assert.rejects(recoveryServer.request('/bridge/test/write-still-blocked', {}, 2000), /writes are blocked pending recovery readback/);
  recoveryReadbackPageUuid = 'recovery-page';
  failRecoveryReadback = true;
  await assert.rejects(
    recoveryServer.request('/bridge/admin/recover-client', recoveryReadbackRequest, 2000),
    /Recovery readback failed: component readback failed/,
  );
  await assert.rejects(recoveryServer.request('/bridge/test/write-after-failed-readback', {}, 2000), /writes are blocked pending recovery readback/);
  failRecoveryReadback = false;
  const recoveryReadback = await recoveryServer.request('/bridge/admin/recover-client', recoveryReadbackRequest, 2000);
  assert.equal(recoveryReadback.readbackVerified, true);
  assert.equal(recoveryReadback.readback.path, '/bridge/jlceda/api/invoke');
  assert.deepEqual(
    await recoveryServer.request('/bridge/test/recovery-write-after-readback', {}, 2000),
    { source: 'replacement', path: '/bridge/test/recovery-write-after-readback' },
  );
  freshRecoveryClient.socket.close();
  wrongRecoveryPage.socket.close();
  wrongRecoveryPage = undefined;
  replacement.socket.close();
  replacement = undefined;
  recoveryServer.close();
  recoveryServer = undefined;

  const disconnectedRecoveryPort = await reservePort();
  disconnectedRecoveryServer = new EdaBridgeServer(disconnectedRecoveryPort);
  await disconnectedRecoveryServer.start();
  disconnectedRecoveryOld = await registerEda(
    `ws://127.0.0.1:${disconnectedRecoveryPort}/bridge/ws${tokenQuery}`,
    'disconnected-recovery-old',
    { documentUuid: 'disconnected-document', projectUuid: 'disconnected-project', pageKind: 'pcb', pageUuid: 'disconnected-page' },
  );
  let disconnectedLayoutTask;
  disconnectedRecoveryOld.socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.type === 'bridge/task') {
      if (message.payload?.apiFullName === 'eda.pcb_Document.autoLayout') {
        disconnectedLayoutTask = message;
      }
      disconnectedRecoveryOld.socket.send(JSON.stringify({
        type: 'bridge/task-started',
        clientId: 'disconnected-recovery-old',
        requestId: message.requestId,
        leaseTerm: message.leaseTerm,
        startedAt: Date.now(),
        context: { documentUuid: 'disconnected-document', projectUuid: 'disconnected-project', pageKind: 'pcb', pageUuid: 'disconnected-page' },
      }));
    }
  });
  disconnectedRecoveryTarget = await registerEda(
    `ws://127.0.0.1:${disconnectedRecoveryPort}/bridge/ws${tokenQuery}`,
    'disconnected-recovery-target',
    { documentUuid: 'disconnected-document', projectUuid: 'disconnected-project', pageKind: 'pcb', pageUuid: 'disconnected-page' },
  );
  attachTaskResponder(disconnectedRecoveryTarget.socket, 'disconnected-recovery-target', (message) => message.path === '/bridge/jlceda/context'
    ? { currentDocumentInfo: { uuid: 'disconnected-document', parentProjectUuid: 'disconnected-project' }, currentProjectInfo: { uuid: 'disconnected-project' }, currentPcbInfo: { uuid: 'disconnected-page' } }
    : ({ source: 'disconnected-recovery-target', path: message.path }));
  const disconnectedRequest = disconnectedRecoveryServer.request('/bridge/jlceda/api/invoke', {
    apiFullName: 'eda.pcb_Document.autoLayout', args: [],
  }, 100);
  await assert.rejects(disconnectedRequest, /Request execution timeout/);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(disconnectedLayoutTask);
  const lateTimeoutProcessed = waitForMessage(disconnectedRecoveryOld.socket, (message) => message.type === 'bridge/heartbeat-ack');
  disconnectedRecoveryOld.socket.send(JSON.stringify({
    type: 'bridge/result',
    clientId: 'disconnected-recovery-old',
    requestId: disconnectedLayoutTask.requestId,
    leaseTerm: disconnectedLayoutTask.leaseTerm,
    error: { code: 'BRIDGE_TASK_TIMEOUT', message: 'Bridge task timed out after 100ms: /bridge/jlceda/api/invoke', timeoutMs: 100 },
  }));
  disconnectedRecoveryOld.socket.send(JSON.stringify({ type: 'bridge/heartbeat', clientId: 'disconnected-recovery-old', sentAt: Date.now() }));
  await lateTimeoutProcessed;
  const lateTimeoutSnapshot = await disconnectedRecoveryServer.request('/bridge/admin/clients', {}, 2000);
  assert.ok(lateTimeoutSnapshot.clients
    .find((client) => client.clientId === 'disconnected-recovery-old')
    .quarantine.diagnostics.some((diagnostic) => diagnostic.requestId === disconnectedLayoutTask.requestId),
  'late BRIDGE_TASK_TIMEOUT must preserve the pending write diagnostic');
  await assert.rejects(disconnectedRecoveryServer.request('/bridge/test/write-after-late-timeout', {}, 2000), /writes are blocked pending recovery readback/);
  const disconnectedReadOnlyTimeout = disconnectedRecoveryServer.request('/bridge/jlceda/context', {}, 100);
  await assert.rejects(disconnectedReadOnlyTimeout, /Request execution timeout/);
  disconnectedRecoveryOld.socket.close();
  await waitUntil(async () => {
    const snapshot = await disconnectedRecoveryServer.request('/bridge/admin/clients', {}, 2000);
    return snapshot.activeClientId === 'disconnected-recovery-target';
  });
  const disconnectedSnapshot = await disconnectedRecoveryServer.request('/bridge/admin/clients', {}, 2000);
  const disconnectedDiagnostic = disconnectedSnapshot.clients
    .find((client) => client.clientId === 'disconnected-recovery-old')
    .quarantine.diagnostics
    .find((diagnostic) => diagnostic.mutating);
  assert.equal(disconnectedDiagnostic.requiredReadback, 'pcb_component_positions');
  const disconnectedRequestId = disconnectedDiagnostic.requestId;
  const disconnectedStart = await disconnectedRecoveryServer.request('/bridge/admin/recover-client', { confirm: true, requestId: disconnectedRequestId }, 2000);
  assert.equal(disconnectedStart.sourceConnected, false);
  assert.equal(disconnectedStart.freshBridgeGenerationRequested, false);
  await assert.rejects(disconnectedRecoveryServer.request('/bridge/admin/recover-client', {
    action: 'readback',
    confirm: true,
    recoveryId: disconnectedStart.recoveryId,
    clientId: 'disconnected-recovery-target',
    hostRestartConfirmed: true,
    expectedDocumentUuid: 'disconnected-document',
    expectedProjectUuid: 'disconnected-project',
    readbackPath: '/bridge/jlceda/api/invoke',
    readbackPayload: { apiFullName: 'eda.pcb_PrimitiveComponent.getAll', args: [] },
  }, 2000), /not a fresh Bridge generation/);
  await assert.rejects(disconnectedRecoveryServer.request('/bridge/test/write-blocked', {}, 2000), /writes are blocked pending recovery readback/);
  disconnectedRecoveryTarget.socket.close();
  disconnectedRecoveryTarget = undefined;
  // Ordinary reconnects retain the runtime clientId, even though they use a
  // new WebSocket. Neither the old source nor the old standby is a new host.
  disconnectedRecoveryTarget = await registerEda(
    `ws://127.0.0.1:${disconnectedRecoveryPort}/bridge/ws${tokenQuery}`,
    'disconnected-recovery-target',
    { documentUuid: 'disconnected-document', projectUuid: 'disconnected-project', pageKind: 'pcb', pageUuid: 'disconnected-page' },
  );
  await assert.rejects(disconnectedRecoveryServer.request('/bridge/admin/recover-client', {
    action: 'readback', confirm: true, recoveryId: disconnectedStart.recoveryId,
    clientId: 'disconnected-recovery-target', hostRestartConfirmed: true, readbackPath: '/bridge/jlceda/api/invoke',
    readbackPayload: { apiFullName: 'eda.pcb_PrimitiveComponent.getAll', args: [] },
  }, 2000), /not a fresh Bridge generation/);
  disconnectedRecoveryTarget.socket.close();
  disconnectedRecoveryTarget = undefined;
  disconnectedRecoveryOld = await registerEda(
    `ws://127.0.0.1:${disconnectedRecoveryPort}/bridge/ws${tokenQuery}`,
    'disconnected-recovery-old',
    { documentUuid: 'disconnected-document', projectUuid: 'disconnected-project', pageKind: 'pcb', pageUuid: 'disconnected-page' },
  );
  await assert.rejects(disconnectedRecoveryServer.request('/bridge/admin/recover-client', {
    action: 'readback', confirm: true, recoveryId: disconnectedStart.recoveryId,
    clientId: 'disconnected-recovery-old', hostRestartConfirmed: true, readbackPath: '/bridge/jlceda/api/invoke',
    readbackPayload: { apiFullName: 'eda.pcb_PrimitiveComponent.getAll', args: [] },
  }, 2000), /not a fresh Bridge generation/);
  await assert.rejects(disconnectedRecoveryServer.request('/bridge/test/write-after-old-runtime-reconnect', {}, 2000), /writes are blocked pending recovery readback/);
  disconnectedRecoveryOld.socket.close();
  disconnectedRecoveryOld = undefined;
  disconnectedRecoveryFresh = await registerEda(
    `ws://127.0.0.1:${disconnectedRecoveryPort}/bridge/ws${tokenQuery}`,
    'disconnected-recovery-fresh',
    { documentUuid: 'disconnected-document', projectUuid: 'disconnected-project', pageKind: 'pcb', pageUuid: 'disconnected-page' },
  );
  let pcbReadbackPageUuid = 'different-pcb';
  let pcbPositionReadbackValid = true;
  attachTaskResponder(disconnectedRecoveryFresh.socket, 'disconnected-recovery-fresh', (message) => {
    if (message.path === '/bridge/jlceda/context') {
      return { currentDocumentInfo: { uuid: 'disconnected-document', parentProjectUuid: 'disconnected-project' }, currentProjectInfo: { uuid: 'disconnected-project' }, currentPcbInfo: { uuid: pcbReadbackPageUuid } };
    }
    if (message.path === '/bridge/jlceda/api/invoke') {
      assert.equal(message.payload.includeCompletePositions, true);
      return pcbPositionReadbackValid
        ? { apiFullName: 'eda.pcb_PrimitiveComponent.getAll', result: [{ uuid: 'pcb-component-1' }], componentPositions: [{ primitiveId: 'pcb-component-1', designator: 'U1', x: 100, y: 200, rotation: 0 }], componentCount: 1 }
        : { apiFullName: 'eda.pcb_PrimitiveComponent.getAll', result: [], componentPositions: [], componentCount: 1 };
    }
    return { source: 'disconnected-recovery-fresh', path: message.path };
  });
  await new Promise((resolve) => setTimeout(resolve, 180));
  await assert.rejects(disconnectedRecoveryServer.request('/bridge/admin/recover-client', {
    action: 'readback',
    confirm: true,
    recoveryId: disconnectedStart.recoveryId,
    clientId: 'disconnected-recovery-fresh',
  }, 2000), /autoLayout requires eda.pcb_PrimitiveComponent.getAll/);
  await assert.rejects(disconnectedRecoveryServer.request('/bridge/test/write-after-context-only', {}, 2000), /writes are blocked pending recovery readback/);
  const disconnectedReadbackRequest = {
    action: 'readback',
    confirm: true,
    recoveryId: disconnectedStart.recoveryId,
    clientId: 'disconnected-recovery-fresh',
    hostRestartConfirmed: true,
    expectedDocumentUuid: 'disconnected-document',
    expectedProjectUuid: 'disconnected-project',
    readbackPath: '/bridge/jlceda/api/invoke',
    readbackPayload: { apiFullName: 'eda.pcb_PrimitiveComponent.getAll', args: [] },
  };
  await assert.rejects(
    disconnectedRecoveryServer.request('/bridge/admin/recover-client', disconnectedReadbackRequest, 2000),
    /Readback pageUuid does not match/,
  );
  pcbReadbackPageUuid = 'disconnected-page';
  pcbPositionReadbackValid = false;
  await assert.rejects(
    disconnectedRecoveryServer.request('/bridge/admin/recover-client', disconnectedReadbackRequest, 2000),
    /did not return a complete component list/,
  );
  await assert.rejects(disconnectedRecoveryServer.request('/bridge/test/write-after-incomplete-pcb-readback', {}, 2000), /writes are blocked pending recovery readback/);
  pcbPositionReadbackValid = true;
  const disconnectedReadback = await disconnectedRecoveryServer.request('/bridge/admin/recover-client', disconnectedReadbackRequest, 2000);
  assert.equal(disconnectedReadback.readbackVerified, true);
  assert.equal(disconnectedReadback.readback.componentCount, 1);
  disconnectedRecoveryFresh.socket.close();
  disconnectedRecoveryFresh = undefined;
  disconnectedRecoveryTarget = undefined;
  disconnectedRecoveryServer.close();
  disconnectedRecoveryServer = undefined;

  const nativeLayoutPort = await reservePort();
  nativeLayoutServer = new EdaBridgeServer(nativeLayoutPort);
  await nativeLayoutServer.start();
  nativeLayoutOld = await registerEda(
    `ws://127.0.0.1:${nativeLayoutPort}/bridge/ws${tokenQuery}`,
    'native-layout-page',
    { documentUuid: 'stale-layout-document', projectUuid: 'stale-layout-project', pageKind: 'pcb', pageUuid: 'stale-layout-pcb' },
  );
  attachTaskResponder(nativeLayoutOld.socket, 'native-layout-page', () => ({
    apiFullName: 'eda.pcb_Document.autoLayout',
    ok: false,
    commitState: 'unknown',
    retryBlocked: true,
    pcbUuid: 'native-layout-pcb',
    layoutContext: { pageKind: 'pcb', pageUuid: 'native-layout-pcb', documentUuid: 'native-layout-document', projectUuid: 'native-layout-project' },
    error: 'RPC Call autoLayout Timed Out',
  }));
  const nativeLayoutResult = await nativeLayoutServer.request('/bridge/jlceda/api/invoke', {
    apiFullName: 'eda.pcb_Document.autoLayout', args: [],
  }, 2000);
  assert.equal(nativeLayoutResult.commitState, 'unknown');
  const nativeLayoutSnapshot = await nativeLayoutServer.request('/bridge/admin/clients', {}, 2000);
  const nativeLayoutDiagnostic = nativeLayoutSnapshot.clients[0].quarantine.diagnostics[0];
  assert.equal(nativeLayoutDiagnostic.requiredReadback, 'pcb_component_positions');
  assert.equal(nativeLayoutDiagnostic.uncertaintyReason, 'native autoLayout timeout');
  assert.equal(nativeLayoutDiagnostic.context.pageUuid, 'native-layout-pcb', 'execution-time result must replace the stale heartbeat page');
  assert.equal(nativeLayoutDiagnostic.context.documentUuid, 'native-layout-document');
  await assert.rejects(nativeLayoutServer.request('/bridge/test/write-after-native-layout-timeout', {}, 2000), /writes are blocked pending recovery readback/);
  const nativeLayoutRecovery = await nativeLayoutServer.request('/bridge/admin/recover-client', {
    confirm: true, requestId: nativeLayoutDiagnostic.requestId,
  }, 2000);
  assert.equal(nativeLayoutRecovery.sourceConnected, true);
  nativeLayoutNew = await registerEda(
    `ws://127.0.0.1:${nativeLayoutPort}/bridge/ws${tokenQuery}`,
    'native-layout-new',
    { documentUuid: 'native-layout-document', projectUuid: 'native-layout-project', pageKind: 'pcb', pageUuid: 'native-layout-pcb' },
  );
  attachTaskResponder(nativeLayoutNew.socket, 'native-layout-new', (message) => {
    if (message.path === '/bridge/jlceda/context')
      return { currentDocumentInfo: { uuid: 'native-layout-document', parentProjectUuid: 'native-layout-project' }, currentProjectInfo: { uuid: 'native-layout-project' }, currentPcbInfo: { uuid: 'native-layout-pcb' } };
    assert.equal(message.payload.includeCompletePositions, true);
    return { apiFullName: 'eda.pcb_PrimitiveComponent.getAll', result: [{ uuid: 'native-component-1' }], componentPositions: [{ primitiveId: 'native-component-1', designator: 'R1', x: 1, y: 2, rotation: 0 }], componentCount: 1 };
  });
  await assert.rejects(nativeLayoutServer.request('/bridge/admin/recover-client', {
    action: 'readback', confirm: true, recoveryId: nativeLayoutRecovery.recoveryId, clientId: 'native-layout-new',
    readbackPath: '/bridge/jlceda/context',
  }, 2000), /autoLayout requires eda.pcb_PrimitiveComponent.getAll/);
  const nativeLayoutReadbackRequest = {
    action: 'readback', confirm: true, recoveryId: nativeLayoutRecovery.recoveryId, clientId: 'native-layout-new',
    hostRestartConfirmed: true,
    readbackPath: '/bridge/jlceda/api/invoke',
    readbackPayload: { apiFullName: 'eda.pcb_PrimitiveComponent.getAll', args: [] },
  };
  await assert.rejects(nativeLayoutServer.request('/bridge/admin/recover-client', nativeLayoutReadbackRequest, 2000), /original Bridge client must disconnect/);
  await assert.rejects(nativeLayoutServer.request('/bridge/test/write-while-native-layout-source-connected', {}, 2000), /writes are blocked pending recovery readback/);
  nativeLayoutOld.socket.close();
  await waitUntil(async () => (await nativeLayoutServer.request('/bridge/admin/clients', {}, 2000)).clients
    .find((client) => client.clientId === 'native-layout-page')?.ready === false);
  const nativeLayoutReadback = await nativeLayoutServer.request('/bridge/admin/recover-client', nativeLayoutReadbackRequest, 2000);
  assert.equal(nativeLayoutReadback.readbackVerified, true);
  assert.equal(nativeLayoutReadback.writesRemainBlocked, false);
  nativeLayoutNew.socket.close();
  nativeLayoutOld = undefined;
  nativeLayoutNew = undefined;
  nativeLayoutServer.close();
  nativeLayoutServer = undefined;

  const nativeRoutingPort = await reservePort();
  const nativeRoutingServer = new EdaBridgeServer(nativeRoutingPort);
  let nativeRoutingOld;
  let nativeRoutingFresh;
  try {
    await nativeRoutingServer.start();
    const routingUrl = `ws://127.0.0.1:${nativeRoutingPort}/bridge/ws${tokenQuery}`;
    nativeRoutingOld = await registerEda(routingUrl, 'native-routing-old', {
      documentUuid: 'stale-routing-document', projectUuid: 'stale-routing-project', pageKind: 'pcb', pageUuid: 'stale-routing-pcb',
    });
    nativeRoutingOld.socket.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type !== 'bridge/task') return;
      nativeRoutingOld.socket.send(JSON.stringify({
        type: 'bridge/task-started', clientId: 'native-routing-old', requestId: message.requestId,
        leaseTerm: message.leaseTerm, startedAt: Date.now(),
        context: { documentUuid: 'routing-document', projectUuid: 'routing-project', pageKind: 'pcb', pageUuid: 'routing-pcb' },
      }));
      nativeRoutingOld.socket.send(JSON.stringify({
        type: 'bridge/result', clientId: 'native-routing-old', requestId: message.requestId, leaseTerm: message.leaseTerm,
        result: {
          apiFullName: 'eda.pcb_Document.autoRouting', ok: false, commitState: 'unknown', commitUnknown: true,
          retryBlocked: true, error: 'RPC Call autoRouting Timed Out',
          routingObservation: { status: 'changed', scope: 'requested_nets_only', pageUuid: 'routing-pcb', provisional: true,
            nets: [{ net: 'VCC', beforeLength: 0, beforeRoutingPrimitiveCount: 0, afterLength: 10.5, afterRoutingPrimitiveCount: 1 }],
            addedRoutingPrimitiveIds: { VCC: ['track-1'] }, removedRoutingPrimitiveIds: { VCC: [] } },
        },
      }));
    });
    const routingToolResult = await new ToolDispatcher(nativeRoutingServer).dispatch({
      name: 'api_invoke', arguments: { apiFullName: 'eda.pcb_Document.autoRouting', args: [{ RoutingNets: ['VCC'] }] },
    });
    const uncertain = routingToolResult.structuredContent;
    assert.equal(uncertain.commitUnknown, true);
    assert.equal(uncertain.routingObservation.status, 'changed', 'provisional readback should reach the caller');
    assert.equal(uncertain.routingObservation.nets[0].afterLength, 10.5);
    assert.deepEqual(uncertain.routingObservation.addedRoutingPrimitiveIds, { VCC: ['track-1'] });
    assert.equal(JSON.parse(routingToolResult.content[0].text).routingObservation.nets[0].afterRoutingPrimitiveCount, 1);
    const snapshot = await nativeRoutingServer.request('/bridge/admin/clients', {}, 2000);
    const diagnostic = snapshot.clients[0].quarantine.diagnostics[0];
    assert.equal(diagnostic.requiredReadback, 'pcb_routing_state');
    assert.equal(diagnostic.hostRestartRequired, true);
    assert.equal(diagnostic.uncertaintyReason, 'native autoRouting timeout');
    assert.equal(diagnostic.context.pageUuid, 'routing-pcb');
    await assert.rejects(nativeRoutingServer.request('/bridge/test/write-after-routing-timeout', {}, 2000), /writes are blocked pending recovery readback/);
    const recovery = await nativeRoutingServer.request('/bridge/admin/recover-client', { action: 'recover', confirm: true, requestId: diagnostic.requestId }, 2000);
    await assert.rejects(nativeRoutingServer.request('/bridge/test/write-before-routing-host-restart', {}, 2000), /writes are blocked pending recovery readback/);
    nativeRoutingFresh = await registerEda(routingUrl, 'native-routing-fresh', {
      documentUuid: 'routing-document', projectUuid: 'routing-project', pageKind: 'pcb', pageUuid: 'routing-pcb',
    });
    let readbackPageUuid = 'wrong-pcb';
    let incompleteViaReadback = false;
    let missingViaGeometry = false;
    let missingRoutingLock = false;
    let missingArcMode = false;
    let missingPolylineNet = false;
    let missingPolylineGeometry = false;
    let switchPageAfterNets = false;
    let routingPrimitiveCalls = 0;
    attachTaskResponder(nativeRoutingFresh.socket, 'native-routing-fresh', message => {
      if (message.path === '/bridge/jlceda/context')
        return { currentDocumentInfo: { uuid: 'routing-document', parentProjectUuid: 'routing-project' }, currentProjectInfo: { uuid: 'routing-project' }, currentPcbInfo: { uuid: readbackPageUuid } };
      if (message.path === '/bridge/jlceda/net/query-pcb') {
        assert.equal(message.payload.mode, 'all');
        if (switchPageAfterNets) readbackPageUuid = 'wrong-pcb';
        return { ok: true, mode: 'all', total: 2, offset: 0, returned: 2, nets: [{ net: 'VCC', length: 10.5 }, { net: 'GND', length: 0 }], truncated: false };
      }
      routingPrimitiveCalls += 1;
      assert.equal(message.path, '/bridge/jlceda/api/invoke');
      assert.equal(message.payload.includeCompleteRouting, true);
      const primitiveId = `${message.payload.apiFullName}-1`;
      const primitive = message.payload.apiFullName === 'eda.pcb_PrimitiveVia.getAll'
        ? { primitiveId, net: 'VCC', x: 1, y: 2, holeDiameter: 0.3, diameter: 0.6, viaType: 1, primitiveLock: false }
        : message.payload.apiFullName === 'eda.pcb_PrimitivePolyline.getAll'
          ? { primitiveId, net: null, layer: 11, polygonSource: '["L",0,0,1,1]', lineWidth: 0.2, primitiveLock: false }
          : { primitiveId, net: 'VCC', layer: 1, startX: 0, startY: 0, endX: 1, endY: 1, lineWidth: 0.2,
            primitiveLock: false,
            ...(message.payload.apiFullName === 'eda.pcb_PrimitiveArc.getAll' ? { arcAngle: 90, interactiveMode: 1 } : {}) };
      const routingPrimitives = [primitive];
      if (missingViaGeometry && message.payload.apiFullName === 'eda.pcb_PrimitiveVia.getAll') delete primitive.x;
      if (missingRoutingLock && message.payload.apiFullName === 'eda.pcb_PrimitiveLine.getAll') delete primitive.primitiveLock;
      if (missingArcMode && message.payload.apiFullName === 'eda.pcb_PrimitiveArc.getAll') delete primitive.interactiveMode;
      if (missingPolylineNet && message.payload.apiFullName === 'eda.pcb_PrimitivePolyline.getAll') delete primitive.net;
      if (missingPolylineGeometry && message.payload.apiFullName === 'eda.pcb_PrimitivePolyline.getAll') delete primitive.polygonSource;
      return { apiFullName: message.payload.apiFullName, routingPrimitives, routingPrimitiveCount: incompleteViaReadback && message.payload.apiFullName === 'eda.pcb_PrimitiveVia.getAll' ? 2 : 1 };
    });
    const routeReadback = {
      action: 'readback', confirm: true, recoveryId: recovery.recoveryId, clientId: 'native-routing-fresh', hostRestartConfirmed: true,
      readbackPath: '/bridge/jlceda/api/invoke', readbackPayload: { apiFullName: 'eda.pcb_PrimitiveLine.getAll', args: [] },
    };
    assert.equal(isReadOnlyBridgeRequest(routeReadback.readbackPath, routeReadback.readbackPayload), true,
      'the exact PCB Line.getAll recovery payload must be classified as read-only');
    await assert.rejects(nativeRoutingServer.request('/bridge/admin/recover-client', { ...routeReadback, hostRestartConfirmed: undefined }, 2000), /original EDA host was restarted/);
    await assert.rejects(nativeRoutingServer.request('/bridge/admin/recover-client', { ...routeReadback, readbackPath: '/bridge/jlceda/context', readbackPayload: {} }, 2000), /autoRouting requires eda.pcb_PrimitiveLine.getAll/);
    await assert.rejects(nativeRoutingServer.request('/bridge/admin/recover-client', routeReadback, 2000), /original Bridge client must disconnect/);
    nativeRoutingOld.socket.close();
    await waitUntil(async () => (await nativeRoutingServer.request('/bridge/admin/clients', {}, 2000)).clients.find(client => client.clientId === 'native-routing-old')?.ready === false);
    await assert.rejects(nativeRoutingServer.request('/bridge/admin/recover-client', routeReadback, 2000), /PCB document or page identity changed/);
    assert.equal(routingPrimitiveCalls, 0, 'wrong PCB must fail before the first routing readback');
    readbackPageUuid = 'routing-pcb';
    incompleteViaReadback = true;
    await assert.rejects(nativeRoutingServer.request('/bridge/admin/recover-client', routeReadback, 2000), /PCB routing readback.*incomplete/);
    await assert.rejects(nativeRoutingServer.request('/bridge/test/write-after-incomplete-routing-readback', {}, 2000), /writes are blocked pending recovery readback/);
    incompleteViaReadback = false;
    missingViaGeometry = true;
    await assert.rejects(nativeRoutingServer.request('/bridge/admin/recover-client', routeReadback, 2000), /PCB routing readback.*incomplete/);
    missingViaGeometry = false;
    missingRoutingLock = true;
    await assert.rejects(nativeRoutingServer.request('/bridge/admin/recover-client', routeReadback, 2000), /PCB routing readback.*incomplete/);
    missingRoutingLock = false;
    missingArcMode = true;
    await assert.rejects(nativeRoutingServer.request('/bridge/admin/recover-client', routeReadback, 2000), /PCB routing readback.*incomplete/);
    missingArcMode = false;
    missingPolylineNet = true;
    await assert.rejects(nativeRoutingServer.request('/bridge/admin/recover-client', routeReadback, 2000), /PCB routing readback.*incomplete/);
    missingPolylineNet = false;
    missingPolylineGeometry = true;
    await assert.rejects(nativeRoutingServer.request('/bridge/admin/recover-client', routeReadback, 2000), /PCB routing readback.*incomplete/);
    missingPolylineGeometry = false;
    switchPageAfterNets = true;
    await assert.rejects(nativeRoutingServer.request('/bridge/admin/recover-client', routeReadback, 2000), /Readback pageUuid does not match/);
    switchPageAfterNets = false;
    readbackPageUuid = 'routing-pcb';
    const verified = await nativeRoutingServer.request('/bridge/admin/recover-client', routeReadback, 2000);
    assert.equal(verified.readbackVerified, true);
    assert.equal(verified.routingSnapshot.primitives.line.length, 1);
    assert.equal(verified.routingSnapshot.primitives.arc.length, 1);
    assert.equal(verified.routingSnapshot.primitives.polyline.length, 1);
    assert.equal(verified.routingSnapshot.primitives.polyline[0].net, null);
    assert.equal(verified.routingSnapshot.primitives.polyline[0].polygonSource, '["L",0,0,1,1]');
    assert.equal(verified.routingSnapshot.primitives.via.length, 1);
    assert.equal(verified.routingSnapshot.nets[0].length, 10.5);
    assert.equal(verified.writesRemainBlocked, false);
  } finally {
    nativeRoutingOld?.socket.close();
    nativeRoutingFresh?.socket.close();
    nativeRoutingServer.close();
  }

  for (const [action, nativeCallSettled] of [['line_create', true], ['via_create', false]]) {
    const pcbWritePort = await reservePort();
    const pcbWriteServer = new EdaBridgeServer(pcbWritePort);
    let oldClient;
    let freshClient;
    try {
      await pcbWriteServer.start();
      const pcbWriteUrl = `ws://127.0.0.1:${pcbWritePort}/bridge/ws${tokenQuery}`;
      oldClient = await registerEda(pcbWriteUrl, `${action}-old`, {
        documentUuid: 'pcb-write-document', projectUuid: 'pcb-write-project', pageKind: 'pcb', pageUuid: 'pcb-write-page',
      });
      oldClient.socket.on('message', data => {
        const message = JSON.parse(data.toString());
        if (message.type !== 'bridge/task') return;
        oldClient.socket.send(JSON.stringify({
          type: 'bridge/task-started', clientId: `${action}-old`, requestId: message.requestId,
          leaseTerm: message.leaseTerm, startedAt: Date.now(),
          context: { documentUuid: 'pcb-write-document', projectUuid: 'pcb-write-project', pageKind: 'pcb', pageUuid: 'pcb-write-page' },
        }));
        oldClient.socket.send(JSON.stringify({
          type: 'bridge/result', clientId: `${action}-old`, requestId: message.requestId,
          leaseTerm: message.leaseTerm, result: { ok: false, action, commitUnknown: true, nativeCallSettled },
        }));
      });
      const payload = action === 'line_create'
        ? { action, net: 'VCC', layer: 1, startX: 0, startY: 0, endX: 10, endY: 0, lineWidth: 0.2 }
        : { action, net: 'VCC', x: 10, y: 0, holeDiameter: 0.3, diameter: 0.6 };
      assert.equal((await pcbWriteServer.request('/bridge/jlceda/pcb/connectivity', payload, 2000)).commitUnknown, true);
      const diagnostic = (await pcbWriteServer.request('/bridge/admin/clients', {}, 2000)).clients
        .find(client => client.clientId === `${action}-old`).quarantine.diagnostics[0];
      assert.equal(diagnostic.requiredReadback, 'pcb_routing_state');
      assert.equal(diagnostic.hostRestartRequired, !nativeCallSettled);
      assert.equal(diagnostic.context.pageUuid, 'pcb-write-page');
      await assert.rejects(pcbWriteServer.request('/bridge/jlceda/pcb/connectivity', payload, 2000), /writes are blocked pending recovery readback/);
      const recovery = await pcbWriteServer.request('/bridge/admin/recover-client', {
        action: 'recover', confirm: true, requestId: diagnostic.requestId,
      }, 2000);
      freshClient = await registerEda(pcbWriteUrl, `${action}-fresh`, {
        documentUuid: 'pcb-write-document', projectUuid: 'pcb-write-project', pageKind: 'pcb', pageUuid: 'pcb-write-page',
      });
      attachTaskResponder(freshClient.socket, `${action}-fresh`, message => {
        if (message.path === '/bridge/jlceda/context')
          return { currentDocumentInfo: { uuid: 'pcb-write-document', parentProjectUuid: 'pcb-write-project' },
            currentProjectInfo: { uuid: 'pcb-write-project' }, currentPcbInfo: { uuid: 'pcb-write-page' } };
        if (message.path === '/bridge/jlceda/net/query-pcb')
          return { ok: true, mode: 'all', total: 1, offset: 0, returned: 1,
            nets: [{ net: 'VCC', length: 10 }], truncated: false };
        if (message.path === '/bridge/jlceda/api/invoke') {
          const apiFullName = message.payload.apiFullName;
          const routingPrimitives = apiFullName === 'eda.pcb_PrimitiveLine.getAll'
            ? [{ primitiveId: 'line-1', net: 'VCC', layer: 1, startX: 0, startY: 0, endX: 10, endY: 0, lineWidth: 0.2, primitiveLock: false }]
            : apiFullName === 'eda.pcb_PrimitiveVia.getAll'
              ? [{ primitiveId: 'via-1', net: 'VCC', x: 10, y: 0, holeDiameter: 0.3, diameter: 0.6, viaType: 1, primitiveLock: false }]
              : [];
          return { apiFullName, routingPrimitives, routingPrimitiveCount: routingPrimitives.length };
        }
        return { ok: true };
      });
      const readbackRequest = { action: 'readback', confirm: true, recoveryId: recovery.recoveryId,
        clientId: `${action}-fresh`, readbackPath: '/bridge/jlceda/api/invoke',
        readbackPayload: { apiFullName: 'eda.pcb_PrimitiveLine.getAll', args: [] } };
      if (!nativeCallSettled)
        await assert.rejects(pcbWriteServer.request('/bridge/admin/recover-client', readbackRequest, 2000), /original EDA host was restarted/);
      oldClient.socket.close();
      await waitUntil(async () => (await pcbWriteServer.request('/bridge/admin/clients', {}, 2000)).clients
        .find(client => client.clientId === `${action}-old`)?.ready === false);
      const verified = await pcbWriteServer.request('/bridge/admin/recover-client', {
        ...readbackRequest, ...(nativeCallSettled ? {} : { hostRestartConfirmed: true }),
      }, 2000);
      assert.equal(verified.readbackVerified, true);
      assert.equal(verified.routingSnapshot.primitives.line.length, 1);
      assert.equal(verified.routingSnapshot.primitives.via.length, 1);
      assert.equal(verified.routingSnapshot.nets[0].net, 'VCC');
      assert.equal((await pcbWriteServer.request('/bridge/jlceda/pcb/connectivity', payload, 2000)).ok, true);
    } finally {
      oldClient?.socket.close();
      freshClient?.socket.close();
      pcbWriteServer.close();
    }
  }

  for (const [caseName, writePayload, nativeCallSettled] of [
    ['create-arc', { action: 'create', kind: 'arc', net: 'VCC', layer: 1, startX: 0, startY: 0, endX: 10, endY: 10, arcAngle: 90 }, false],
    ['create-polyline', { action: 'create', kind: 'polyline', net: 'VCC', layer: 1, polygonSource: [0, 0, 'L', 10, 0, 10, 10] }, true],
    ['modify-via', { action: 'modify', kind: 'via', primitiveId: 'via-1', property: { diameter: 0.6 } }, false],
    ['delete-line', { action: 'delete', kind: 'line', primitiveId: 'line-1' }, true],
    ['board-create-line', { action: 'create', kind: 'line', startX: 0, startY: 0, endX: 10, endY: 0 }, false],
    ['board-modify-arc', { action: 'modify', kind: 'arc', primitiveId: 'board-arc-1', property: { arcAngle: 45 } }, true],
  ]) {
    const editPath = caseName.startsWith('board-')
      ? '/bridge/jlceda/pcb/board-outline-manage'
      : '/bridge/jlceda/pcb/routing-edit';
    const editPort = await reservePort();
    const editServer = new EdaBridgeServer(editPort);
    const editUrl = `ws://127.0.0.1:${editPort}/bridge/ws${tokenQuery}`;
    const context = { documentUuid: 'routing-edit-document', projectUuid: 'routing-edit-project',
      pageKind: 'pcb', pageUuid: 'routing-edit-page' };
    let oldClient;
    let freshClient;
    try {
      await editServer.start();
      oldClient = await registerEda(editUrl, `${caseName}-old`, context);
      oldClient.socket.on('message', data => {
        const message = JSON.parse(data.toString());
        if (message.type !== 'bridge/task') return;
        oldClient.socket.send(JSON.stringify({ type: 'bridge/task-started', clientId: `${caseName}-old`,
          requestId: message.requestId, leaseTerm: message.leaseTerm, startedAt: Date.now(), context }));
        oldClient.socket.send(JSON.stringify({ type: 'bridge/result', clientId: `${caseName}-old`,
          requestId: message.requestId, leaseTerm: message.leaseTerm,
          result: { ok: false, action: writePayload.action, kind: writePayload.kind,
            commitUnknown: true, readbackRequired: true, nativeCallSettled } }));
      });
      assert.equal((await editServer.request(editPath, writePayload, 2000)).commitUnknown, true);
      const diagnostic = (await editServer.request('/bridge/admin/clients', {}, 2000)).clients[0].quarantine.diagnostics[0];
      assert.equal(diagnostic.requiredReadback, 'pcb_routing_state');
      assert.equal(diagnostic.hostRestartRequired, !nativeCallSettled);
      assert.equal(diagnostic.context.pageUuid, context.pageUuid);
      await assert.rejects(editServer.request(editPath, writePayload, 2000),
        /writes are blocked pending recovery readback/);
      const recovery = await editServer.request('/bridge/admin/recover-client', {
        action: 'recover', confirm: true, requestId: diagnostic.requestId,
      }, 2000);
      oldClient.socket.close();
      await waitUntil(async () => (await editServer.request('/bridge/admin/clients', {}, 2000)).clients
        .find(client => client.clientId === `${caseName}-old`)?.ready === false);
      freshClient = await registerEda(editUrl, `${caseName}-fresh`, context);
      attachTaskResponder(freshClient.socket, `${caseName}-fresh`, message => {
        if (message.path === '/bridge/jlceda/context')
          return { currentDocumentInfo: { uuid: context.documentUuid, parentProjectUuid: context.projectUuid },
            currentProjectInfo: { uuid: context.projectUuid }, currentPcbInfo: { uuid: context.pageUuid } };
        if (message.path === '/bridge/jlceda/net/query-pcb')
          return { ok: true, mode: 'all', total: 1, offset: 0, returned: 1,
            nets: [{ net: 'VCC', length: 12 }], truncated: false };
        if (message.path === '/bridge/jlceda/api/invoke') {
          const apiFullName = message.payload.apiFullName;
          assert.equal(message.payload.includeCompleteRouting, true);
          const routingPrimitives = apiFullName === 'eda.pcb_PrimitiveArc.getAll'
            ? [{ primitiveId: 'arc-1', net: 'VCC', layer: 1, startX: 0, startY: 0, endX: 10, endY: 10,
                arcAngle: 90, interactiveMode: 1, lineWidth: 0.2, primitiveLock: false }]
            : apiFullName === 'eda.pcb_PrimitivePolyline.getAll'
              ? [{ primitiveId: 'polyline-1', net: 'VCC', layer: 1,
                  polygonSource: '[0,0,"L",10,0,10,10]', lineWidth: 0.2, primitiveLock: false }]
              : apiFullName === 'eda.pcb_PrimitiveVia.getAll'
                ? [{ primitiveId: 'via-1', net: 'VCC', x: 10, y: 10, holeDiameter: 0.3,
                    diameter: 0.6, viaType: 0, primitiveLock: false }]
                : [{ primitiveId: 'line-1', net: 'VCC', layer: 1, startX: 0, startY: 0,
                    endX: 10, endY: 0, lineWidth: 0.2, primitiveLock: false },
                  { primitiveId: 'board-line-1', net: '', layer: 11, startX: 0, startY: 0,
                    endX: 10, endY: 0, lineWidth: 0.2, primitiveLock: false }];
          return { apiFullName, routingPrimitives, routingPrimitiveCount: routingPrimitives.length };
        }
        return { ok: true };
      });
      const readbackRequest = { action: 'readback', confirm: true, recoveryId: recovery.recoveryId,
        clientId: `${caseName}-fresh`, readbackPath: '/bridge/jlceda/api/invoke',
        readbackPayload: { apiFullName: 'eda.pcb_PrimitiveLine.getAll', args: [] },
        ...(!nativeCallSettled ? { hostRestartConfirmed: true } : {}) };
      await assert.rejects(editServer.request('/bridge/admin/recover-client', {
        ...readbackRequest, readbackPath: editPath, readbackPayload: { action: 'read' },
      }, 2000), /requires eda.pcb_PrimitiveLine.getAll/);
      if (!nativeCallSettled)
        await assert.rejects(editServer.request('/bridge/admin/recover-client', {
          ...readbackRequest, hostRestartConfirmed: undefined,
        }, 2000), /original EDA host was restarted/);
      const verified = await editServer.request('/bridge/admin/recover-client', readbackRequest, 2000);
      assert.equal(verified.readbackVerified, true);
      assert.ok(verified.routingSnapshot.primitives.line.some(item => item.primitiveId === 'board-line-1' && item.layer === 11));
      assert.equal(verified.routingSnapshot.primitives.arc.length, 1);
      assert.equal(verified.routingSnapshot.primitives.polyline.length, 1);
      assert.equal(verified.routingSnapshot.primitives.via.length, 1);
      assert.equal(verified.routingSnapshot.nets[0].net, 'VCC');
      assert.equal(verified.writesRemainBlocked, false);
    } finally {
      oldClient?.socket.close();
      freshClient?.socket.close();
      editServer.close();
    }
  }

  const lateRoutingPort = await reservePort();
  const lateRoutingServer = new EdaBridgeServer(lateRoutingPort);
  let lateRoutingPeer;
  try {
    await lateRoutingServer.start();
    lateRoutingPeer = await registerEda(`ws://127.0.0.1:${lateRoutingPort}/bridge/ws${tokenQuery}`, 'late-routing-peer');
    let heldTask;
    lateRoutingPeer.socket.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type !== 'bridge/task') return;
      heldTask = message;
      lateRoutingPeer.socket.send(JSON.stringify({
        type: 'bridge/task-started', clientId: 'late-routing-peer', requestId: message.requestId, leaseTerm: message.leaseTerm,
        startedAt: Date.now(), context: { documentUuid: 'late-routing-document', projectUuid: 'late-routing-project', pageKind: 'pcb', pageUuid: 'late-routing-pcb' },
      }));
    });
    await assert.rejects(lateRoutingServer.request('/bridge/jlceda/api/invoke', { apiFullName: 'eda.pcb_Document.autoRouting', args: [] }, 100), /Request execution timeout/);
    assert.ok(heldTask);
    const lateBefore = await lateRoutingServer.request('/bridge/admin/clients', {}, 2000);
    assert.equal(lateBefore.clients[0].quarantine.diagnostics[0].requiredReadback, 'pcb_routing_state');
    const processed = waitForMessage(lateRoutingPeer.socket, message => message.type === 'bridge/heartbeat-ack');
    lateRoutingPeer.socket.send(JSON.stringify({
      type: 'bridge/result', clientId: 'late-routing-peer', requestId: heldTask.requestId, leaseTerm: heldTask.leaseTerm,
      result: { apiFullName: 'eda.pcb_Document.autoRouting', result: { success: true, totalNetsCount: 2, successNetsCount: 2 } },
    }));
    lateRoutingPeer.socket.send(JSON.stringify({ type: 'bridge/heartbeat', clientId: 'late-routing-peer', sentAt: Date.now() }));
    await processed;
    const lateAfter = await lateRoutingServer.request('/bridge/admin/clients', {}, 2000);
    assert.equal(lateAfter.clients[0].quarantine.diagnostics[0].requestId, lateBefore.clients[0].quarantine.diagnostics[0].requestId,
      'a late autoRouting start result must not erase a caller-visible timeout before full PCB readback');
    await assert.rejects(lateRoutingServer.request('/bridge/test/write-after-late-routing', {}, 2000), /writes are blocked pending recovery readback/);
  } finally {
    lateRoutingPeer?.socket.close();
    lateRoutingServer.close();
  }

  const latePcbWritePort = await reservePort();
  const latePcbWriteServer = new EdaBridgeServer(latePcbWritePort);
  let latePcbWritePeer;
  try {
    await latePcbWriteServer.start();
    latePcbWritePeer = await registerEda(`ws://127.0.0.1:${latePcbWritePort}/bridge/ws${tokenQuery}`,
      'late-pcb-write', { documentUuid: 'pcb-document', projectUuid: 'pcb-project', pageKind: 'pcb', pageUuid: 'pcb-page' });
    let heldTask;
    latePcbWritePeer.socket.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type !== 'bridge/task') return;
      heldTask = message;
      latePcbWritePeer.socket.send(JSON.stringify({ type: 'bridge/task-started', clientId: 'late-pcb-write',
        requestId: message.requestId, leaseTerm: message.leaseTerm, startedAt: Date.now(),
        context: { documentUuid: 'pcb-document', projectUuid: 'pcb-project', pageKind: 'pcb', pageUuid: 'pcb-page' } }));
    });
    await assert.rejects(latePcbWriteServer.request('/bridge/jlceda/pcb/connectivity', {
      action: 'line_create', net: 'VCC', layer: 1, startX: 0, startY: 0, endX: 10, endY: 0, lineWidth: 1,
    }, 100), /Request execution timeout/);
    assert.ok(heldTask);
    const before = (await latePcbWriteServer.request('/bridge/admin/clients', {}, 2000)).clients[0].quarantine.diagnostics[0];
    assert.equal(before.hostRestartRequired, true);
    const processed = waitForMessage(latePcbWritePeer.socket, message => message.type === 'bridge/heartbeat-ack');
    latePcbWritePeer.socket.send(JSON.stringify({ type: 'bridge/result', clientId: 'late-pcb-write',
      requestId: heldTask.requestId, leaseTerm: heldTask.leaseTerm,
      result: { ok: true, verified: true, primitiveId: 'new-line' } }));
    latePcbWritePeer.socket.send(JSON.stringify({ type: 'bridge/heartbeat', clientId: 'late-pcb-write', sentAt: Date.now() }));
    await processed;
    const after = (await latePcbWriteServer.request('/bridge/admin/clients', {}, 2000)).clients[0].quarantine.diagnostics[0];
    assert.equal(after.hostRestartRequired, false, 'verified late create result proves the native call settled');
    assert.equal(after.requiredReadback, 'pcb_routing_state', 'late success still requires complete PCB readback');
  } finally {
    latePcbWritePeer?.socket.close();
    latePcbWriteServer.close();
  }

  const latePinNetworkPort = await reservePort();
  const latePinNetworkServer = new EdaBridgeServer(latePinNetworkPort);
  let latePinNetworkPeer;
  try {
    await latePinNetworkServer.start();
    const pageContext = { documentUuid: 'pin-document', projectUuid: 'pin-project',
      pageKind: 'schematic', pageUuid: 'pin-page' };
    latePinNetworkPeer = await registerEda(`ws://127.0.0.1:${latePinNetworkPort}/bridge/ws${tokenQuery}`,
      'late-pin-network', pageContext);
    let heldTask;
    latePinNetworkPeer.socket.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type !== 'bridge/task') return;
      heldTask = message;
      latePinNetworkPeer.socket.send(JSON.stringify({ type: 'bridge/task-started', clientId: 'late-pin-network',
        requestId: message.requestId, leaseTerm: message.leaseTerm, startedAt: Date.now(), context: pageContext }));
    });
    await assert.rejects(latePinNetworkServer.request('/bridge/jlceda/schematic/component-edit',
      { action: 'modify', primitiveId: 'r1', property: { x: 10 } }, 100), /Request execution timeout/);
    assert.ok(heldTask);
    const before = (await latePinNetworkServer.request('/bridge/admin/clients', {}, 2000)).clients[0].quarantine.diagnostics[0];
    assert.equal(before.requiredReadback, 'schematic_component_state');
    const processed = waitForMessage(latePinNetworkPeer.socket, message => message.type === 'bridge/heartbeat-ack');
    latePinNetworkPeer.socket.send(JSON.stringify({ type: 'bridge/result', clientId: 'late-pin-network',
      requestId: heldTask.requestId, leaseTerm: heldTask.leaseTerm,
      result: { ok: false, reason: 'pin_network_changed', commitUnknown: true, nativeCallSettled: true } }));
    latePinNetworkPeer.socket.send(JSON.stringify({ type: 'bridge/heartbeat', clientId: 'late-pin-network', sentAt: Date.now() }));
    await processed;
    const after = (await latePinNetworkServer.request('/bridge/admin/clients', {}, 2000)).clients[0].quarantine.diagnostics[0];
    assert.equal(after.requiredReadback, 'schematic_connectivity_primitives');
    assert.equal(after.hostRestartRequired, false);
  } finally {
    latePinNetworkPeer?.socket.close();
    latePinNetworkServer.close();
  }

  const lateUnknownPort = await reservePort();
  lateUnknownServer = new EdaBridgeServer(lateUnknownPort);
  await lateUnknownServer.start();
  lateUnknownClient = await registerEda(
    `ws://127.0.0.1:${lateUnknownPort}/bridge/ws${tokenQuery}`,
    'late-unknown-page',
    { documentUuid: 'stale-late-document', projectUuid: 'stale-late-project', pageKind: 'pcb', pageUuid: 'stale-late-pcb' },
  );
  let lateUnknownTask;
  lateUnknownClient.socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.type !== 'bridge/task') return;
    lateUnknownTask = message;
    lateUnknownClient.socket.send(JSON.stringify({
      type: 'bridge/task-started', clientId: 'late-unknown-page',
      requestId: message.requestId, leaseTerm: message.leaseTerm, startedAt: Date.now(),
      context: { documentUuid: 'late-unknown-document', projectUuid: 'late-unknown-project', pageKind: 'pcb', pageUuid: 'late-unknown-pcb' },
    }));
  });
  await assert.rejects(lateUnknownServer.request('/bridge/jlceda/api/invoke', {
    apiFullName: 'eda.pcb_Document.autoLayout', args: [],
  }, 100), /Request execution timeout/);
  assert.ok(lateUnknownTask);
  const beforeLateResult = await lateUnknownServer.request('/bridge/admin/clients', {}, 2000);
  assert.equal(beforeLateResult.clients[0].quarantine.diagnostics[0].context.pageUuid, 'late-unknown-pcb',
    'a Server timeout must retain task-start PCB identity rather than the stale heartbeat');
  assert.equal(beforeLateResult.clients[0].quarantine.diagnostics[0].context.documentUuid, 'late-unknown-document');
  const lateUnknownProcessed = waitForMessage(lateUnknownClient.socket, (message) => message.type === 'bridge/heartbeat-ack');
  lateUnknownClient.socket.send(JSON.stringify({
    type: 'bridge/result', clientId: 'late-unknown-page',
    requestId: lateUnknownTask.requestId, leaseTerm: lateUnknownTask.leaseTerm,
    result: { apiFullName: 'eda.pcb_Document.autoLayout', ok: false, commitState: 'unknown', retryBlocked: true, pcbUuid: 'late-unknown-pcb', layoutContext: { documentUuid: 'late-unknown-document', projectUuid: 'late-unknown-project', pageKind: 'pcb', pageUuid: 'late-unknown-pcb' } },
  }));
  lateUnknownClient.socket.send(JSON.stringify({ type: 'bridge/heartbeat', clientId: 'late-unknown-page', sentAt: Date.now() }));
  await lateUnknownProcessed;
  const lateUnknownSnapshot = await lateUnknownServer.request('/bridge/admin/clients', {}, 2000);
  assert.equal(lateUnknownSnapshot.clients[0].quarantine.diagnostics[0].requestId, lateUnknownTask.requestId);
  await assert.rejects(lateUnknownServer.request('/bridge/test/write-after-late-unknown', {}, 2000), /writes are blocked pending recovery readback/);
  lateUnknownClient.socket.close();
  lateUnknownClient = undefined;
  lateUnknownServer.close();
  lateUnknownServer = undefined;

  const missingLayoutIdentityPort = await reservePort();
  const missingLayoutIdentityServer = new EdaBridgeServer(missingLayoutIdentityPort);
  let missingLayoutIdentityOld;
  let missingLayoutIdentityFresh;
  try {
    await missingLayoutIdentityServer.start();
    const identityUrl = `ws://127.0.0.1:${missingLayoutIdentityPort}/bridge/ws${tokenQuery}`;
    missingLayoutIdentityOld = await registerEda(identityUrl, 'missing-layout-identity-old', {
      documentUuid: 'heartbeat-document', projectUuid: 'heartbeat-project', pageKind: 'pcb', pageUuid: 'heartbeat-pcb',
    });
    missingLayoutIdentityOld.socket.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type !== 'bridge/task') return;
      missingLayoutIdentityOld.socket.send(JSON.stringify({
        type: 'bridge/task-started', clientId: 'missing-layout-identity-old',
        requestId: message.requestId, leaseTerm: message.leaseTerm, startedAt: Date.now(),
      }));
    });
    await assert.rejects(missingLayoutIdentityServer.request('/bridge/jlceda/api/invoke', {
      apiFullName: 'eda.pcb_Document.autoLayout', args: [],
    }, 100), /Request execution timeout/);
    const missingSnapshot = await missingLayoutIdentityServer.request('/bridge/admin/clients', {}, 2000);
    const missingDiagnostic = missingSnapshot.clients[0].quarantine.diagnostics[0];
    assert.equal(missingDiagnostic.context.pageUuid, undefined, 'heartbeat PCB must not be treated as execution identity');
    const recovery = await missingLayoutIdentityServer.request('/bridge/admin/recover-client', {
      action: 'recover', confirm: true, requestId: missingDiagnostic.requestId,
    }, 2000);
    missingLayoutIdentityFresh = await registerEda(identityUrl, 'missing-layout-identity-fresh', {
      documentUuid: 'heartbeat-document', projectUuid: 'heartbeat-project', pageKind: 'pcb', pageUuid: 'heartbeat-pcb',
    });
    await assert.rejects(missingLayoutIdentityServer.request('/bridge/admin/recover-client', {
      action: 'readback', confirm: true, recoveryId: recovery.recoveryId, clientId: 'missing-layout-identity-fresh',
      expectedDocumentUuid: 'heartbeat-document', expectedPageUuid: 'heartbeat-pcb',
      readbackPath: '/bridge/jlceda/api/invoke',
      readbackPayload: { apiFullName: 'eda.pcb_PrimitiveComponent.getAll', args: [] },
    }, 2000), /no verified execution-time PCB page identity/);
  } finally {
    missingLayoutIdentityOld?.socket.close();
    missingLayoutIdentityFresh?.socket.close();
    missingLayoutIdentityServer.close();
  }

  const lateConnectivityPort = await reservePort();
  lateConnectivityServer = new EdaBridgeServer(lateConnectivityPort);
  await lateConnectivityServer.start();
  lateConnectivityActive = await registerEda(
    `ws://127.0.0.1:${lateConnectivityPort}/bridge/ws${tokenQuery}`,
    'late-connectivity-active',
    { documentUuid: 'connectivity-document', projectUuid: 'connectivity-project', pageKind: 'schematic', pageUuid: 'connectivity-page' },
  );
  let lateConnectivityTask;
  lateConnectivityActive.socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.type !== 'bridge/task') return;
    lateConnectivityTask = message;
    lateConnectivityActive.socket.send(JSON.stringify({
      type: 'bridge/task-started', clientId: 'late-connectivity-active',
      requestId: message.requestId, leaseTerm: message.leaseTerm, startedAt: Date.now(),
    }));
  });
  lateConnectivityStandby = await registerEda(
    `ws://127.0.0.1:${lateConnectivityPort}/bridge/ws${tokenQuery}`,
    'late-connectivity-standby',
    { documentUuid: 'connectivity-document', projectUuid: 'connectivity-project', pageKind: 'schematic', pageUuid: 'connectivity-page' },
  );
  attachTaskResponder(lateConnectivityStandby.socket, 'late-connectivity-standby', (message) => ({
    source: 'late-connectivity-standby', path: message.path,
  }));
  await assert.rejects(lateConnectivityServer.request('/bridge/jlceda/schematic/connectivity', {
    action: 'wire_create', line: [0, 0, 10, 0],
  }, 100), /Request execution timeout/);
  assert.ok(lateConnectivityTask);
  const lateConnectivityProcessed = waitForMessage(lateConnectivityActive.socket, (message) => message.type === 'bridge/heartbeat-ack');
  lateConnectivityActive.socket.send(JSON.stringify({
    type: 'bridge/result', clientId: 'late-connectivity-active',
    requestId: lateConnectivityTask.requestId, leaseTerm: lateConnectivityTask.leaseTerm,
    result: { ok: false, action: 'wire_create', committed: false, commitUnknown: true },
  }));
  lateConnectivityActive.socket.send(JSON.stringify({ type: 'bridge/heartbeat', clientId: 'late-connectivity-active', sentAt: Date.now() }));
  await lateConnectivityProcessed;
  const lateConnectivitySnapshot = await lateConnectivityServer.request('/bridge/admin/clients', {}, 2000);
  assert.equal(lateConnectivitySnapshot.clients.find(client => client.clientId === 'late-connectivity-active').quarantine.diagnostics[0].requestId, lateConnectivityTask.requestId);
  await lateConnectivityServer.request('/bridge/admin/select-client', { clientId: 'late-connectivity-standby' }, 2000);
  assert.deepEqual(await lateConnectivityServer.request('/bridge/jlceda/context', {}, 2000), {
    source: 'late-connectivity-standby', path: '/bridge/jlceda/context',
  });
  await assert.rejects(lateConnectivityServer.request('/bridge/jlceda/schematic/connectivity', {
    action: 'netport_create', net: 'SIG', x: 0, y: 0,
  }, 2000), /writes are blocked pending recovery readback/);
  lateConnectivityActive.socket.close();
  lateConnectivityActive = undefined;
  lateConnectivityStandby.socket.close();
  lateConnectivityStandby = undefined;
  lateConnectivityServer.close();
  lateConnectivityServer = undefined;

  const unverifiedWritePort = await reservePort();
  unverifiedWriteServer = new EdaBridgeServer(unverifiedWritePort);
  await unverifiedWriteServer.start();
  unverifiedWriteActive = await registerEda(
    `ws://127.0.0.1:${unverifiedWritePort}/bridge/ws${tokenQuery}`,
    'unverified-write-active',
    { documentUuid: 'stale-unverified-document', projectUuid: 'stale-unverified-project', pageKind: 'schematic', pageUuid: 'stale-unverified-page' },
  );
  unverifiedWriteActive.socket.on('message', data => {
    const message = JSON.parse(data.toString());
    if (message.type !== 'bridge/task') return;
    unverifiedWriteActive.socket.send(JSON.stringify({
      type: 'bridge/task-started', clientId: 'unverified-write-active',
      requestId: message.requestId, leaseTerm: message.leaseTerm, startedAt: Date.now(),
      context: { documentUuid: 'unverified-document', projectUuid: 'unverified-project', pageKind: 'schematic', pageUuid: 'unverified-page' },
    }));
    unverifiedWriteActive.socket.send(JSON.stringify({
      type: 'bridge/result', clientId: 'unverified-write-active',
      requestId: message.requestId, leaseTerm: message.leaseTerm,
      result: { ok: false, action: 'wire_create', committed: false, commitUnknown: true },
    }));
  });
  unverifiedWriteStandby = await registerEda(
    `ws://127.0.0.1:${unverifiedWritePort}/bridge/ws${tokenQuery}`,
    'unverified-write-standby',
    { documentUuid: 'unverified-document', projectUuid: 'unverified-project', pageKind: 'schematic', pageUuid: 'unverified-page' },
  );
  attachTaskResponder(unverifiedWriteStandby.socket, 'unverified-write-standby', (message) => ({
    source: 'unverified-write-standby', path: message.path,
  }));
  const unverifiedResult = await unverifiedWriteServer.request('/bridge/jlceda/schematic/connectivity', {
    action: 'wire_create', line: [0, 0, 10, 0],
  }, 2000);
  assert.equal(unverifiedResult.commitUnknown, true);
  const unverifiedSnapshot = await unverifiedWriteServer.request('/bridge/admin/clients', {}, 2000);
  const unverifiedDiagnostic = unverifiedSnapshot.clients.find(client => client.clientId === 'unverified-write-active').quarantine.diagnostics[0];
  assert.equal(unverifiedDiagnostic.path, '/bridge/jlceda/schematic/connectivity');
  assert.equal(unverifiedDiagnostic.mutating, true);
  assert.equal(unverifiedDiagnostic.uncertaintyReason, 'write result could not be verified');
  assert.equal(unverifiedDiagnostic.context.pageUuid, 'unverified-page', 'unknown write must use the execution page rather than the heartbeat page');
  assert.equal(unverifiedDiagnostic.context.documentUuid, 'unverified-document');
  await unverifiedWriteServer.request('/bridge/admin/select-client', { clientId: 'unverified-write-standby' }, 2000);
  assert.deepEqual(await unverifiedWriteServer.request('/bridge/jlceda/context', {}, 2000), {
    source: 'unverified-write-standby', path: '/bridge/jlceda/context',
  });
  await assert.rejects(unverifiedWriteServer.request('/bridge/jlceda/schematic/connectivity', {
    action: 'netport_create', net: 'SIG', x: 0, y: 0,
  }, 2000), /writes are blocked pending recovery readback/);
  unverifiedWriteActive.socket.close();
  unverifiedWriteActive = undefined;
  unverifiedWriteStandby.socket.close();
  unverifiedWriteStandby = undefined;
  unverifiedWriteServer.close();
  unverifiedWriteServer = undefined;

  for (const [operation, mode, nativeCallSettled] of [
    ['invoke', 'unknown', true], ['invoke', 'timeout', false], ['invoke', 'disconnect', false],
    ['save', 'unknown', true], ['save', 'unknown', false], ['save', 'timeout', false], ['save', 'disconnect', false],
  ]) {
    const footprintPort = await reservePort();
    const footprintServer = new EdaBridgeServer(footprintPort);
    const footprintRelay = new EdaBridgeServer(footprintPort);
    const execution = { pageKind: 'footprint', documentType: 4, documentUuid: 'fp-document', pageUuid: 'fp-document', libraryUuid: 'fp-library', tabId: 'old-tab' };
    let oldFootprint;
    let freshFootprint;
    try {
      await footprintServer.start();
      await footprintRelay.start();
      const url = `ws://127.0.0.1:${footprintPort}/bridge/ws${tokenQuery}`;
      oldFootprint = await registerEda(url, `footprint-${mode}-old`, {
        pageKind: 'pcb', documentType: 3, documentUuid: 'stale-pcb-document', pageUuid: 'stale-pcb-page', projectUuid: 'stale-project',
      });
      oldFootprint.socket.on('message', data => {
        const message = JSON.parse(data.toString());
        if (message.type !== 'bridge/task') return;
        oldFootprint.socket.send(JSON.stringify({ type: 'bridge/task-started', clientId: `footprint-${mode}-old`,
          requestId: message.requestId, leaseTerm: message.leaseTerm, startedAt: Date.now(), context: execution }));
        if (mode === 'unknown') oldFootprint.socket.send(JSON.stringify({ type: 'bridge/result', clientId: `footprint-${mode}-old`,
          requestId: message.requestId, leaseTerm: message.leaseTerm, result: { ok: false, commitUnknown: true, nativeCallSettled } }));
        if (mode === 'disconnect') oldFootprint.socket.close();
      });
      const writePath = operation === 'save' ? '/bridge/jlceda/footprint/save' : '/bridge/jlceda/api/invoke';
      const write = operation === 'save' ? {} : { apiFullName: 'eda.pcb_PrimitiveVia.modify', args: ['via-1', { diameter: 20 }] };
      if (mode === 'unknown') assert.equal((await footprintRelay.request(writePath, write, 2000)).commitUnknown, true);
      else await assert.rejects(footprintRelay.request(writePath, write, mode === 'timeout' ? 50 : 2000), mode === 'timeout' ? /execution timeout/ : /disconnected/);
      const diagnostic = (await footprintRelay.request('/bridge/admin/clients', {}, 2000)).clients
        .find(client => client.clientId === `footprint-${mode}-old`).quarantine.diagnostics[0];
      assert.equal(diagnostic.requiredReadback, 'footprint_state');
      assert.equal(diagnostic.hostRestartRequired, !nativeCallSettled);
      assert.equal(diagnostic.context.libraryUuid, 'fp-library');
      assert.equal(diagnostic.context.projectUuid, undefined, '封装编辑不要求工程 UUID');
      const session = await footprintRelay.request('/bridge/admin/recover-client', { action: 'recover', confirm: true, requestId: diagnostic.requestId }, 2000);
      oldFootprint.socket.close();
      await waitUntil(async () => (await footprintRelay.request('/bridge/admin/clients', {}, 2000)).clients
        .find(client => client.clientId === `footprint-${mode}-old`)?.ready === false);
      const freshIdentity = { ...execution, tabId: 'new-tab' };
      freshFootprint = await registerEda(url, `footprint-${mode}-fresh`, freshIdentity);
      // Bridge 完整 DTO 将无孔原生 NaN 旋转归一为明确 null；三种 Relay 恢复路径都必须接受该实际状态。
      const smdPad = { primitiveId: 'smd-pad', primitiveType: 'Pad', primitiveLock: false,
        layer: 1, padNumber: '1', x: 10, y: 20, rotation: 0, net: null, pad: ['RECT', 80, 60], hole: null,
        holeOffsetX: 0, holeOffsetY: 0, holeRotation: null, metallization: false, padType: 0, specialPad: [],
        solderMaskAndPasteMaskExpansion: null, heatWelding: null };
      const snapshot = { ok: true, complete: true, scope: 'current_footprint_document', ...freshIdentity,
        pads: [smdPad], padCount: 1, vias: [], viaCount: 0,
        lines: [{ primitiveId: 'line-1', primitiveType: 'Line', primitiveLock: false, net: null, layer: 11, startX: 0, startY: 0, endX: 20, endY: 0, lineWidth: 1 }], lineCount: 1,
        arcs: [], arcCount: 0, polylines: [], polylineCount: 0, strings: [], stringCount: 0, attributes: [], attributeCount: 0, primitiveCount: 2 };
      let identityResult = freshIdentity;
      let readbackResult = snapshot;
      let changeTabAfterRead = false;
      attachTaskResponder(freshFootprint.socket, `footprint-${mode}-fresh`, message => {
        if (message.path === '/bridge/jlceda/context') return { footprintContext: identityResult };
        if (message.path === '/bridge/jlceda/footprint/read') {
          if (changeTabAfterRead) identityResult = { ...freshIdentity, tabId: 'changed-tab' };
          return readbackResult;
        }
        return { source: 'footprint-fresh', path: message.path };
      });
      const request = { action: 'readback', confirm: true, recoveryId: session.recoveryId, clientId: `footprint-${mode}-fresh`,
        ...(nativeCallSettled ? {} : { hostRestartConfirmed: true }), readbackPath: '/bridge/jlceda/footprint/read', readbackPayload: {} };
      if (!nativeCallSettled)
        await assert.rejects(footprintRelay.request('/bridge/admin/recover-client', { ...request, hostRestartConfirmed: undefined }, 2000), /original EDA host was restarted/);
      if (mode === 'unknown') {
        await assert.rejects(footprintRelay.request('/bridge/admin/recover-client', { ...request, readbackPath: '/bridge/jlceda/context' }, 2000), /requires complete footprint_read/);
        identityResult = { ...freshIdentity, libraryUuid: 'different-library' };
        await assert.rejects(footprintRelay.request('/bridge/admin/recover-client', request, 2000), /library, or tab identity/);
        identityResult = freshIdentity;
        readbackResult = { ...snapshot, libraryUuid: 'different-library' };
        await assert.rejects(footprintRelay.request('/bridge/admin/recover-client', request, 2000), /another document or library/);
        readbackResult = { ...snapshot, attributes: undefined };
        await assert.rejects(footprintRelay.request('/bridge/admin/recover-client', request, 2000), /lists or counts were incomplete/);
        readbackResult = { ...snapshot, lines: [{ ...snapshot.lines[0], lineWidth: null }] };
        await assert.rejects(footprintRelay.request('/bridge/admin/recover-client', request, 2000), /primitive state was incomplete/);
        for (const holeRotation of [null, undefined]) {
          readbackResult = { ...snapshot, pads: [{ ...smdPad, hole: ['ROUND', 35], holeRotation }] };
          await assert.rejects(footprintRelay.request('/bridge/admin/recover-client', request, 2000), /primitive state was incomplete/);
        }
        readbackResult = { ...snapshot, pads: [{ ...smdPad, holeRotation: undefined }] };
        await assert.rejects(footprintRelay.request('/bridge/admin/recover-client', request, 2000), /primitive state was incomplete/);
        for (const pad of [null, []]) {
          readbackResult = { ...snapshot, pads: [{ ...smdPad, pad }] };
          await assert.rejects(footprintRelay.request('/bridge/admin/recover-client', request, 2000), /primitive state was incomplete/);
        }
        readbackResult = snapshot;
        changeTabAfterRead = true;
        await assert.rejects(footprintRelay.request('/bridge/admin/recover-client', request, 2000), /library, or tab identity/);
        identityResult = freshIdentity;
        changeTabAfterRead = false;
      }
      const recovered = await footprintRelay.request('/bridge/admin/recover-client', request, 2000);
      assert.equal(recovered.readbackVerified, true);
      assert.equal(recovered.writesRemainBlocked, false);
      assert.equal(recovered.readback.tabId, 'new-tab', '重连后的新标签允许与旧执行标签不同');
      assert.equal(recovered.readback.pads[0].hole, null);
      assert.equal(recovered.readback.pads[0].holeRotation, null, '无孔原生 NaN 旋转归一后的明确 null 允许完整恢复');
      assert.deepEqual(recovered.readback.pads[0].specialPad, [], '空特殊轮廓与实际普通焊盘形状允许三个 Relay 路径完整恢复');
      assert.deepEqual(await footprintRelay.request(writePath, write, 2000), { source: 'footprint-fresh', path: writePath });
      assert.equal(recovered.saved, undefined, 'full editing-state recovery must not claim a durable library save');
    } finally {
      oldFootprint?.socket.close();
      freshFootprint?.socket.close();
      footprintRelay.close();
      footprintServer.close();
    }
  }

  for (const [action, nativeCallSettled] of [['wire_create', true], ['raw_wire_create', true], ['raw_wire_create', false], ['netport_create', true], ['netport_move', true], ['wire_create', false], ['netlabel_place', false], ['modify', true], ['delete', false], ['pin_modify', true], ['pin_modify', false], ['ordinary_pin_modify', true], ['ordinary_pin_modify', false], ['pin_modify_timeout', false], ['ordinary_pin_modify_timeout', false], ['unclassified_pin_modify_timeout', false], ['late_pin_modify_timeout', false]]) {
    const pinModify = action.includes('pin_modify');
    const rawWireCreate = action === 'raw_wire_create';
    const componentPin = pinModify && !action.startsWith('ordinary_') && !action.startsWith('unclassified_');
    const nativeTimeout = action.endsWith('_timeout');
    const connectivityRecoveryPort = await reservePort();
    const connectivityRecoveryServer = new EdaBridgeServer(connectivityRecoveryPort);
    const recoveryCaller = pinModify || rawWireCreate ? new EdaBridgeServer(connectivityRecoveryPort) : connectivityRecoveryServer;
    let oldClient;
    let freshClient;
    try {
      await connectivityRecoveryServer.start();
      if (recoveryCaller !== connectivityRecoveryServer) await recoveryCaller.start();
      const recoveryUrl = `ws://127.0.0.1:${connectivityRecoveryPort}/bridge/ws${tokenQuery}`;
      oldClient = await registerEda(recoveryUrl, `connectivity-${action}-old`, {
        documentUuid: 'connectivity-document', projectUuid: 'connectivity-project', pageKind: 'schematic', pageUuid: 'connectivity-page',
      });
      oldClient.socket.on('message', data => {
        const message = JSON.parse(data.toString());
        if (message.type !== 'bridge/task') return;
        oldClient.socket.send(JSON.stringify({
          type: 'bridge/task-started', clientId: `connectivity-${action}-old`,
          requestId: message.requestId, leaseTerm: message.leaseTerm, startedAt: Date.now(),
          context: { documentUuid: 'connectivity-document', projectUuid: 'connectivity-project', pageKind: 'schematic', pageUuid: 'connectivity-page' },
        }));
        if (pinModify && !action.startsWith('unclassified_')) {
          const reportAdapter = () => oldClient.socket.send(JSON.stringify({
            type: 'bridge/task-started', clientId: `connectivity-${action}-old`,
            requestId: message.requestId, leaseTerm: message.leaseTerm, startedAt: Date.now(),
            schematicPinAdapter: componentPin ? 'component_pin_instance' : 'native_pin',
          }));
          if (action.startsWith('late_')) setTimeout(reportAdapter, 100);
          else reportAdapter();
        }
        if (!nativeTimeout) oldClient.socket.send(JSON.stringify({
          type: 'bridge/result', clientId: `connectivity-${action}-old`,
          requestId: message.requestId, leaseTerm: message.leaseTerm,
          result: { ok: false, action: rawWireCreate ? 'wire_create' : action, commitUnknown: true, nativeCallSettled },
        }));
      });
      const writePath = pinModify || rawWireCreate ? '/bridge/jlceda/api/invoke' : action === 'netlabel_place' ? '/bridge/jlceda/netlabel/place'
        : action === 'modify' || action === 'delete' ? '/bridge/jlceda/schematic/wire-manage'
        : '/bridge/jlceda/schematic/connectivity';
      const writePayload = pinModify ? { apiFullName: 'eda.sch_PrimitivePin.modify', args: ['pin-16', { noConnected: false }] }
        : rawWireCreate ? { apiFullName: 'eda.sch_PrimitiveWire.create', args: [[0, 0, 10, 0], 'SIG', '#00AA00', 2, 0] }
        : action === 'netlabel_place'
        ? { placements: [{ componentId: 'component-1', pinIdentifier: '1', netName: 'SIG' }] }
        : action === 'modify' ? { action, primitiveId: 'wire-1', property: { color: '#00AA00' } }
        : action === 'delete' ? { action, primitiveId: 'wire-1' }
        : action === 'wire_create'
        ? { action, line: [0, 0, 10, 0] }
        : action === 'netport_create'
          ? { action, net: 'SIG', x: 10, y: 0 }
          : { action, id: 'port-1', x: 10, y: 0 };
      if (nativeTimeout) {
        await assert.rejects(recoveryCaller.request(writePath, writePayload, 50), /execution timeout/);
        if (action.startsWith('late_')) await waitUntil(async () => (await recoveryCaller.request('/bridge/admin/clients', {}, 2000)).clients
          .find(client => client.clientId === `connectivity-${action}-old`)?.quarantine.diagnostics[0]?.schematicPinAdapter === 'component_pin_instance');
      } else assert.equal((await recoveryCaller.request(writePath, writePayload, 2000)).commitUnknown, true);
      const diagnostic = (await recoveryCaller.request('/bridge/admin/clients', {}, 2000)).clients
        .find(client => client.clientId === `connectivity-${action}-old`).quarantine.diagnostics[0];
      assert.equal(diagnostic.requiredReadback, 'schematic_connectivity_primitives', `${action} needs primitive readback`);
      assert.equal(diagnostic.hostRestartRequired, !nativeCallSettled);
      assert.equal(diagnostic.context.pageUuid, 'connectivity-page');
      const recovery = await recoveryCaller.request('/bridge/admin/recover-client', {
        action: 'recover', confirm: true, requestId: diagnostic.requestId,
      }, 2000);
      oldClient.socket.close();
      await waitUntil(async () => (await recoveryCaller.request('/bridge/admin/clients', {}, 2000)).clients
        .find(client => client.clientId === `connectivity-${action}-old`)?.ready === false);
      freshClient = await registerEda(recoveryUrl, `connectivity-${action}-fresh`, {
        documentUuid: 'connectivity-document', projectUuid: 'connectivity-project', pageKind: 'schematic', pageUuid: 'connectivity-page',
      });
      const primitives = {
        scope: 'current_schematic_page', complete: true, pageUuid: 'connectivity-page',
        wireCount: 1, wires: [{ primitiveId: 'wire-1', net: 'SIG', line: [0, 0, 10, 0] }],
        netPortCount: 1, netPorts: [{ primitiveId: 'port-1', net: 'SIG', x: 10, y: 0 }],
        netFlagCount: 1, netFlags: [{ primitiveId: 'flag-1', net: 'SIG', x: 20, y: 0 }],
        netLabelCount: 0, netLabels: [],
      };
      const semantic = componentPin ? { componentCount: 1, networkCount: 0, networks: [], components: [
        { componentInstanceId: 'U1', pins: [
          { pinId: 'pin-16', pinNumber: '16', x: 530, y: 330, rotation: 180, noConnected: false, hasNoConnectMark: false },
          // schematic_read normalizes an available sibling NC getter returning undefined to false.
          { pinId: 'pin-17', pinNumber: '17', x: 540, y: 330, rotation: 180, noConnected: false, hasNoConnectMark: false },
        ] },
      ] } : { componentCount: 0, networkCount: 0, components: [], networks: [] };
      let readbackResult = { ok: true, schematicCircuitSnapshot: JSON.stringify(semantic), connectivityPrimitivesSnapshot: JSON.stringify(primitives) };
      attachTaskResponder(freshClient.socket, `connectivity-${action}-fresh`, message => message.path === '/bridge/jlceda/context'
        ? {
            currentDocumentInfo: { uuid: 'connectivity-document', parentProjectUuid: 'connectivity-project' },
            currentProjectInfo: { uuid: 'connectivity-project' },
            currentSchematicPageInfo: { uuid: 'connectivity-page' },
          }
        : message.path === '/bridge/jlceda/schematic/read'
          ? readbackResult
          : { source: 'connectivity-fresh', path: message.path });
      const readbackRequest = {
        action: 'readback', confirm: true, recoveryId: recovery.recoveryId,
        clientId: `connectivity-${action}-fresh`,
        ...(nativeCallSettled ? {} : { hostRestartConfirmed: true }),
        readbackPath: '/bridge/jlceda/schematic/read',
        readbackPayload: { includeConnectivityPrimitives: true },
      };
      if (!nativeCallSettled)
        await assert.rejects(recoveryCaller.request('/bridge/admin/recover-client', {
          ...readbackRequest, hostRestartConfirmed: undefined,
        }, 2000), /original EDA host was restarted/);
      await assert.rejects(recoveryCaller.request('/bridge/admin/recover-client', {
        ...readbackRequest, readbackPath: '/bridge/jlceda/context', readbackPayload: {},
      }, 2000), /requires schematic_read with includeConnectivityPrimitives=true/);
      await assert.rejects(recoveryCaller.request('/bridge/admin/recover-client', {
        ...readbackRequest, readbackPayload: {},
      }, 2000), /requires schematic_read with includeConnectivityPrimitives=true/);
      readbackResult = { ok: false, error: 'netlist read failed' };
      await assert.rejects(recoveryCaller.request('/bridge/admin/recover-client', readbackRequest, 2000), /netlist read failed/);
      readbackResult = { ok: true, schematicCircuitSnapshot: JSON.stringify(semantic), connectivityPrimitivesSnapshot: JSON.stringify({ ...primitives, wireCount: 2 }) };
      await assert.rejects(recoveryCaller.request('/bridge/admin/recover-client', readbackRequest, 2000), /connectivity readback was incomplete/);
      readbackResult = { ok: true, schematicCircuitSnapshot: JSON.stringify(semantic), connectivityPrimitivesSnapshot: JSON.stringify({ ...primitives, netFlagCount: 2 }) };
      await assert.rejects(recoveryCaller.request('/bridge/admin/recover-client', readbackRequest, 2000), /connectivity readback was incomplete/);
      readbackResult = { ok: true, schematicCircuitSnapshot: JSON.stringify(semantic), connectivityPrimitivesSnapshot: JSON.stringify({ ...primitives, pageUuid: 'other-page' }) };
      await assert.rejects(recoveryCaller.request('/bridge/admin/recover-client', readbackRequest, 2000), /from another page/);
      await assert.rejects(recoveryCaller.request(writePath, writePayload, 2000), /writes are blocked pending recovery readback/);
      if (pinModify) {
        assert.equal(diagnostic.targetSchematicPinPrimitiveId, 'pin-16');
        assert.equal(diagnostic.schematicPinAdapter, componentPin ? 'component_pin_instance' : action.startsWith('unclassified_') ? undefined : 'native_pin');
      }
      if (componentPin) {
        const badGeometry = structuredClone(semantic);
        badGeometry.components[0].pins[1].y = null;
        readbackResult = { ok: true, schematicCircuitSnapshot: JSON.stringify(badGeometry), connectivityPrimitivesSnapshot: JSON.stringify(primitives) };
        await assert.rejects(recoveryCaller.request('/bridge/admin/recover-client', readbackRequest, 2000), /component pin state was incomplete/);
        const badNc = structuredClone(semantic);
        badNc.components[0].pins[0].noConnected = null;
        readbackResult = { ok: true, schematicCircuitSnapshot: JSON.stringify(badNc), connectivityPrimitivesSnapshot: JSON.stringify(primitives) };
        await assert.rejects(recoveryCaller.request('/bridge/admin/recover-client', readbackRequest, 2000), /component pin state was incomplete/);
        const missingPin = structuredClone(semantic);
        missingPin.components[0].pins.shift();
        readbackResult = { ok: true, schematicCircuitSnapshot: JSON.stringify(missingPin), connectivityPrimitivesSnapshot: JSON.stringify(primitives) };
        await assert.rejects(recoveryCaller.request('/bridge/admin/recover-client', readbackRequest, 2000), /target pin was absent/);
      }
      readbackResult = { ok: true, schematicCircuitSnapshot: JSON.stringify(semantic), connectivityPrimitivesSnapshot: JSON.stringify(primitives) };
      const verified = await recoveryCaller.request('/bridge/admin/recover-client', readbackRequest, 2000);
      assert.equal(verified.readbackVerified, true);
      assert.equal(JSON.parse(verified.readback.connectivityPrimitivesSnapshot).wireCount, 1);
      assert.deepEqual(await recoveryCaller.request(writePath, writePayload, 2000), {
        source: 'connectivity-fresh', path: writePath,
      });
    } finally {
      oldClient?.socket.close();
      freshClient?.socket.close();
      if (recoveryCaller !== connectivityRecoveryServer) recoveryCaller.close();
      connectivityRecoveryServer.close();
    }
  }

  const connectivityTimeoutPort = await reservePort();
  const connectivityTimeoutServer = new EdaBridgeServer(connectivityTimeoutPort);
  let connectivityTimeoutClient;
  try {
    await connectivityTimeoutServer.start();
    connectivityTimeoutClient = await registerEda(`ws://127.0.0.1:${connectivityTimeoutPort}/bridge/ws${tokenQuery}`, 'connectivity-timeout', {
      documentUuid: 'timeout-document', projectUuid: 'timeout-project', pageKind: 'schematic', pageUuid: 'timeout-page',
    });
    connectivityTimeoutClient.socket.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type !== 'bridge/task') return;
      connectivityTimeoutClient.socket.send(JSON.stringify({
        type: 'bridge/task-started', clientId: 'connectivity-timeout',
        requestId: message.requestId, leaseTerm: message.leaseTerm, startedAt: Date.now(),
        context: { documentUuid: 'timeout-document', projectUuid: 'timeout-project', pageKind: 'schematic', pageUuid: 'timeout-page' },
      }));
    });
    await assert.rejects(connectivityTimeoutServer.request('/bridge/jlceda/schematic/connectivity', {
      action: 'wire_create', line: [0, 0, 10, 0],
    }, 100), /timeout/);
    const timeoutDiagnostic = (await connectivityTimeoutServer.request('/bridge/admin/clients', {}, 2000)).clients
      .find(client => client.clientId === 'connectivity-timeout').quarantine.diagnostics[0];
    assert.equal(timeoutDiagnostic.requiredReadback, 'schematic_connectivity_primitives', 'execution timeout needs the same complete readback');
    assert.equal(timeoutDiagnostic.hostRestartRequired, true);
  } finally {
    connectivityTimeoutClient?.socket.close();
    connectivityTimeoutServer.close();
  }

  const projectWritePort = await reservePort();
  const projectWriteServer = new EdaBridgeServer(projectWritePort);
  let projectWriteOld;
  let projectWriteFresh;
  try {
    await projectWriteServer.start();
    const projectUrl = `ws://127.0.0.1:${projectWritePort}/bridge/ws${tokenQuery}`;
    projectWriteOld = await registerEda(projectUrl, 'project-write-old', {
      projectUuid: 'stale-project', pageKind: 'schematic', pageUuid: 'stale-page',
    });
    projectWriteOld.socket.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type !== 'bridge/task') return;
      projectWriteOld.socket.send(JSON.stringify({
        type: 'bridge/task-started', clientId: 'project-write-old',
        requestId: message.requestId, leaseTerm: message.leaseTerm, startedAt: Date.now(),
        context: { documentUuid: 'project-write-page-a-document', projectUuid: 'current-project', pageKind: 'schematic', pageUuid: 'project-write-page-a' },
      }));
      projectWriteOld.socket.send(JSON.stringify({
        type: 'bridge/result', clientId: 'project-write-old',
        requestId: message.requestId, leaseTerm: message.leaseTerm,
        result: { commitUnknown: true, nativeCallSettled: true },
      }));
    });
    const projectWriteResult = await projectWriteServer.request('/bridge/jlceda/api/invoke', {
      apiFullName: 'eda.dmt_Project.modifyProjectFriendlyName', args: ['actual-project', 'renamed'],
    }, 2000);
    assert.equal(projectWriteResult.commitUnknown, true);
    const projectDiagnostic = (await projectWriteServer.request('/bridge/admin/clients', {}, 2000)).clients[0].quarantine.diagnostics[0];
    assert.equal(projectDiagnostic.pageBound, false);
    assert.equal(projectDiagnostic.targetProjectUuid, 'actual-project');
    assert.equal(projectDiagnostic.context.projectUuid, 'current-project');
    assert.equal(projectDiagnostic.context.pageUuid, 'project-write-page-a');
    const projectRecovery = await projectWriteServer.request('/bridge/admin/recover-client', {
      action: 'recover', confirm: true, requestId: projectDiagnostic.requestId,
    }, 2000);
    projectWriteOld.socket.close();
    await waitUntil(async () => (await projectWriteServer.request('/bridge/admin/clients', {}, 2000)).clients
      .find(client => client.clientId === 'project-write-old')?.ready === false);
    projectWriteFresh = await registerEda(projectUrl, 'project-write-fresh', {
      documentUuid: 'project-write-page-b-document', projectUuid: 'actual-project', pageKind: 'schematic', pageUuid: 'project-write-page-b',
    });
    attachTaskResponder(projectWriteFresh.socket, 'project-write-fresh', () => ({
      currentDocumentInfo: { uuid: 'project-write-page-b-document', parentProjectUuid: 'actual-project' },
      currentProjectInfo: { uuid: 'actual-project' },
      currentSchematicPageInfo: { uuid: 'project-write-page-b' },
    }));
    const projectReadback = await projectWriteServer.request('/bridge/admin/recover-client', {
      action: 'readback', confirm: true, recoveryId: projectRecovery.recoveryId,
      clientId: 'project-write-fresh', readbackPath: '/bridge/jlceda/context',
    }, 2000);
    assert.equal(projectReadback.readbackVerified, true);
  } finally {
    projectWriteOld?.socket.close();
    projectWriteFresh?.socket.close();
    projectWriteServer.close();
  }

  const legacyWritePort = await reservePort();
  const legacyWriteServer = new EdaBridgeServer(legacyWritePort);
  let legacyWriteOld;
  let legacyWriteFresh;
  try {
    await legacyWriteServer.start();
    const legacyUrl = `ws://127.0.0.1:${legacyWritePort}/bridge/ws${tokenQuery}`;
    legacyWriteOld = await registerEda(legacyUrl, 'legacy-write-old', {
      documentUuid: 'legacy-document', projectUuid: 'legacy-project', pageKind: 'schematic', pageUuid: 'legacy-page',
    });
    attachTaskResponder(legacyWriteOld.socket, 'legacy-write-old', () => ({ commitUnknown: true }));
    await legacyWriteServer.request('/bridge/jlceda/schematic/connectivity', {
      action: 'wire_create', line: [0, 0, 10, 0],
    }, 2000);
    const legacyDiagnostic = (await legacyWriteServer.request('/bridge/admin/clients', {}, 2000)).clients[0].quarantine.diagnostics[0];
    assert.equal(legacyDiagnostic.pageBound, true);
    assert.equal(legacyDiagnostic.context, undefined, 'old task-started without context must not reuse heartbeat identity');
    const legacyRecovery = await legacyWriteServer.request('/bridge/admin/recover-client', {
      action: 'recover', confirm: true, requestId: legacyDiagnostic.requestId,
    }, 2000);
    legacyWriteOld.socket.close();
    await waitUntil(async () => (await legacyWriteServer.request('/bridge/admin/clients', {}, 2000)).clients
      .find(client => client.clientId === 'legacy-write-old')?.ready === false);
    legacyWriteFresh = await registerEda(legacyUrl, 'legacy-write-fresh', {
      documentUuid: 'legacy-document', projectUuid: 'legacy-project', pageKind: 'schematic', pageUuid: 'legacy-page',
    });
    await assert.rejects(legacyWriteServer.request('/bridge/admin/recover-client', {
      action: 'readback', confirm: true, recoveryId: legacyRecovery.recoveryId,
      clientId: 'legacy-write-fresh', expectedDocumentUuid: 'legacy-document', expectedPageUuid: 'legacy-page',
      hostRestartConfirmed: true,
      readbackPath: '/bridge/jlceda/schematic/read', readbackPayload: { includeConnectivityPrimitives: true },
    }, 2000), /no verified execution-time page identity/);
  } finally {
    legacyWriteOld?.socket.close();
    legacyWriteFresh?.socket.close();
    legacyWriteServer.close();
  }

  const currentPageDeletePort = await reservePort();
  const currentPageDeleteServer = new EdaBridgeServer(currentPageDeletePort);
  let currentPageDeleteOld;
  let currentPageDeleteFresh;
  try {
    await currentPageDeleteServer.start();
    const currentPageUrl = `ws://127.0.0.1:${currentPageDeletePort}/bridge/ws${tokenQuery}`;
    currentPageDeleteOld = await registerEda(currentPageUrl, 'current-page-delete-old', {
      documentUuid: 'page-a', projectUuid: 'current-page-project', pageKind: 'schematic', pageUuid: 'page-a',
    });
    currentPageDeleteOld.socket.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type !== 'bridge/task') return;
      currentPageDeleteOld.socket.send(JSON.stringify({
        type: 'bridge/task-started', clientId: 'current-page-delete-old',
        requestId: message.requestId, leaseTerm: message.leaseTerm, startedAt: Date.now(),
        context: { documentUuid: 'page-a', projectUuid: 'current-page-project', pageKind: 'schematic', pageUuid: 'page-a' },
      }));
      currentPageDeleteOld.socket.send(JSON.stringify({
        type: 'bridge/result', clientId: 'current-page-delete-old',
        requestId: message.requestId, leaseTerm: message.leaseTerm,
        result: { commitUnknown: true, nativeCallSettled: false, uncertainIds: ['component-on-page-a'] },
      }));
    });
    await currentPageDeleteServer.request('/bridge/jlceda/api/invoke', {
      apiFullName: 'eda.sch_PrimitiveComponent.delete', args: ['component-on-page-a'],
    }, 2000);
    const currentPageDiagnostic = (await currentPageDeleteServer.request('/bridge/admin/clients', {}, 2000)).clients[0].quarantine.diagnostics[0];
    assert.equal(currentPageDiagnostic.pageBound, true);
    assert.equal(currentPageDiagnostic.requiredReadback, 'schematic_connectivity_primitives');
    assert.equal(currentPageDiagnostic.hostRestartRequired, true);
    const currentPageRecovery = await currentPageDeleteServer.request('/bridge/admin/recover-client', {
      action: 'recover', confirm: true, requestId: currentPageDiagnostic.requestId,
    }, 2000);
    currentPageDeleteOld.socket.close();
    await waitUntil(async () => (await currentPageDeleteServer.request('/bridge/admin/clients', {}, 2000)).clients
      .find(client => client.clientId === 'current-page-delete-old')?.ready === false);
    currentPageDeleteFresh = await registerEda(currentPageUrl, 'current-page-delete-fresh', {
      documentUuid: 'page-a', projectUuid: 'current-page-project', pageKind: 'schematic', pageUuid: 'page-a',
    });
    attachTaskResponder(currentPageDeleteFresh.socket, 'current-page-delete-fresh', message => message.path === '/bridge/jlceda/schematic/read'
      ? {
          ok: true, pageUuid: 'page-a',
          schematicCircuitSnapshot: JSON.stringify({ componentCount: 0, networkCount: 0, components: [], networks: [] }),
          connectivityPrimitivesSnapshot: JSON.stringify({
            scope: 'current_schematic_page', complete: true, pageUuid: 'page-a',
            wireCount: 0, wires: [], netPortCount: 0, netPorts: [], netFlagCount: 0, netFlags: [], netLabelCount: 0, netLabels: [],
          }),
        }
      : { currentDocumentInfo: { uuid: 'page-a', parentProjectUuid: 'current-page-project' }, currentProjectInfo: { uuid: 'current-page-project' }, currentSchematicPageInfo: { uuid: 'page-a' } });
    const currentPageReadback = {
      action: 'readback', confirm: true, recoveryId: currentPageRecovery.recoveryId,
      clientId: 'current-page-delete-fresh', hostRestartConfirmed: true, readbackPath: '/bridge/jlceda/schematic/read',
      readbackPayload: { includeConnectivityPrimitives: true },
    };
    await assert.rejects(currentPageDeleteServer.request('/bridge/admin/recover-client', {
      ...currentPageReadback, readbackPath: '/bridge/jlceda/context',
    }, 2000), /requires schematic_read with includeConnectivityPrimitives=true/);
    await assert.rejects(currentPageDeleteServer.request('/bridge/admin/recover-client', {
      ...currentPageReadback, expectedPageUuid: 'page-b',
    }, 2000), /expectedPageUuid does not match/);
    assert.equal((await currentPageDeleteServer.request('/bridge/admin/recover-client', currentPageReadback, 2000)).readbackVerified, true);
  } finally {
    currentPageDeleteOld?.socket.close();
    currentPageDeleteFresh?.socket.close();
    currentPageDeleteServer.close();
  }

  const placementCheckPort = await reservePort();
  const placementCheckServer = new EdaBridgeServer(placementCheckPort);
  let placementCheckOld;
  let placementCheckFresh;
  try {
    await placementCheckServer.start();
    const placementCheckUrl = `ws://127.0.0.1:${placementCheckPort}/bridge/ws${tokenQuery}`;
    placementCheckOld = await registerEda(placementCheckUrl, 'placement-check-old', {
      documentUuid: 'placement-document', projectUuid: 'placement-project', pageKind: 'schematic', pageUuid: 'placement-page',
    });
    placementCheckOld.socket.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type !== 'bridge/task') return;
      placementCheckOld.socket.send(JSON.stringify({
        type: 'bridge/task-started', clientId: 'placement-check-old', requestId: message.requestId,
        leaseTerm: message.leaseTerm, startedAt: Date.now(),
        context: { documentUuid: 'placement-document', projectUuid: 'placement-project', pageKind: 'schematic', pageUuid: 'placement-page' },
      }));
      placementCheckOld.socket.send(JSON.stringify({
        type: 'bridge/result', clientId: 'placement-check-old', requestId: message.requestId,
        leaseTerm: message.leaseTerm,
        result: { ok: false, commitUnknown: true, nativeCallSettled: true, primitiveIds: ['kept', 'extra'] },
      }));
    });
    // raw create 复用 placement 的完整 ID、位号和 BOM 回读恢复。
    assert.equal((await placementCheckServer.request('/bridge/jlceda/api/invoke',
      { apiFullName: ' EDA.SCH_PRIMITIVECOMPONENT.CREATE ', args: [] }, 2000)).commitUnknown, true);
    const placementDiagnostic = (await placementCheckServer.request('/bridge/admin/clients', {}, 2000)).clients[0].quarantine.diagnostics[0];
    assert.equal(placementDiagnostic.requiredReadback, 'schematic_component_ids');
    assert.equal(placementDiagnostic.hostRestartRequired, false);
    assert.equal(placementDiagnostic.pageBound, true);
    const placementRecovery = await placementCheckServer.request('/bridge/admin/recover-client', {
      action: 'recover', confirm: true, requestId: placementDiagnostic.requestId,
    }, 2000);
    placementCheckOld.socket.close();
    await waitUntil(async () => (await placementCheckServer.request('/bridge/admin/clients', {}, 2000)).clients
      .find(client => client.clientId === 'placement-check-old')?.ready === false);
    placementCheckFresh = await registerEda(placementCheckUrl, 'placement-check-fresh', {
      documentUuid: 'placement-document', projectUuid: 'placement-project', pageKind: 'schematic', pageUuid: 'placement-page',
    });
    let reportedPageUuid = 'other-page';
    let reportedComponentCount = 1;
    let includeComponentProperties = true;
    let switchPageAfterInventory = false;
    attachTaskResponder(placementCheckFresh.socket, 'placement-check-fresh', message => {
      if (message.path === '/bridge/jlceda/context')
        return { currentDocumentInfo: { uuid: 'placement-document', parentProjectUuid: 'placement-project' },
          currentProjectInfo: { uuid: 'placement-project' }, currentSchematicPageInfo: { uuid: reportedPageUuid } };
      if (message.path === '/bridge/jlceda/api/invoke') {
        assert.equal(message.payload.includeCompleteSchematicComponentIds, true);
        if (switchPageAfterInventory) reportedPageUuid = 'other-page';
        return { apiFullName: 'eda.sch_PrimitiveComponent.getAllPrimitiveId',
          schematicComponentIds: ['kept'], schematicComponentCount: reportedComponentCount,
          schematicComponentStates: [{ primitiveId: 'kept', designator: 'U4',
            ...(includeComponentProperties ? { otherPropertyJson: '{"supplierId":"C1"}' } : {}) }] };
      }
      if (message.path === '/bridge/jlceda/component/place-auto')
        return { ok: false, commitUnknown: true, nativeCallSettled: false };
      return { ok: true };
    });
    const placementReadback = { action: 'readback', confirm: true, recoveryId: placementRecovery.recoveryId,
      clientId: 'placement-check-fresh', readbackPath: '/bridge/jlceda/api/invoke',
      readbackPayload: { apiFullName: 'eda.sch_PrimitiveComponent.getAllPrimitiveId', args: [null, false] } };
    await assert.rejects(placementCheckServer.request('/bridge/admin/recover-client', {
      ...placementReadback, readbackPath: '/bridge/jlceda/context', readbackPayload: {},
    }, 2000), /placement requires current-page/);
    await assert.rejects(placementCheckServer.request('/bridge/admin/recover-client', placementReadback, 2000), /Schematic document or page identity changed/);
    reportedPageUuid = 'placement-page';
    reportedComponentCount = 2;
    await assert.rejects(placementCheckServer.request('/bridge/admin/recover-client', placementReadback, 2000), /component state readback was incomplete/);
    reportedComponentCount = 1;
    includeComponentProperties = false;
    await assert.rejects(placementCheckServer.request('/bridge/admin/recover-client', placementReadback, 2000), /component state readback was incomplete/);
    includeComponentProperties = true;
    switchPageAfterInventory = true;
    await assert.rejects(placementCheckServer.request('/bridge/admin/recover-client', placementReadback, 2000), /Readback pageUuid does not match/);
    reportedPageUuid = 'placement-page';
    switchPageAfterInventory = false;
    const verified = await placementCheckServer.request('/bridge/admin/recover-client', placementReadback, 2000);
    assert.equal(verified.readbackVerified, true);
    assert.deepEqual(verified.readback.schematicComponentIds, ['kept']);
    assert.deepEqual(verified.readback.schematicComponentStates, [{ primitiveId: 'kept', designator: 'U4', otherPropertyJson: '{"supplierId":"C1"}' }]);
    assert.equal((await placementCheckServer.request('/bridge/jlceda/component/place/check', { sessionId: 'placement-2' }, 2000)).ok, true);
    assert.equal((await placementCheckServer.request('/bridge/jlceda/component/place-auto', { components: [] }, 2000)).commitUnknown, true);
    const autoPlacementDiagnostic = (await placementCheckServer.request('/bridge/admin/clients', {}, 2000)).clients
      .find(client => client.clientId === 'placement-check-fresh').quarantine.diagnostics[0];
    assert.equal(autoPlacementDiagnostic.requiredReadback, 'schematic_component_ids');
    assert.equal(autoPlacementDiagnostic.hostRestartRequired, true);
  } finally {
    placementCheckOld?.socket.close();
    placementCheckFresh?.socket.close();
    placementCheckServer.close();
  }

  for (const [rawCreate, lateResult] of [[false, false], [false, true], [true, false], [true, true]]) {
    const placementTimeoutPort = await reservePort();
    const placementTimeoutServer = new EdaBridgeServer(placementTimeoutPort);
    let placementTimeoutOld;
    try {
      await placementTimeoutServer.start();
      placementTimeoutOld = await registerEda(`ws://127.0.0.1:${placementTimeoutPort}/bridge/ws${tokenQuery}`,
        `placement-timeout-${lateResult}`, { documentUuid: 'placement-document', projectUuid: 'placement-project',
          pageKind: 'schematic', pageUuid: 'placement-page' });
      let heldTask;
      placementTimeoutOld.socket.on('message', data => {
        const message = JSON.parse(data.toString());
        if (message.type !== 'bridge/task') return;
        heldTask = message;
        placementTimeoutOld.socket.send(JSON.stringify({ type: 'bridge/task-started', clientId: `placement-timeout-${lateResult}`,
          requestId: message.requestId, leaseTerm: message.leaseTerm, startedAt: Date.now(),
          context: { documentUuid: 'placement-document', projectUuid: 'placement-project',
            pageKind: 'schematic', pageUuid: 'placement-page' } }));
        if (!lateResult) {
          placementTimeoutOld.socket.send(JSON.stringify({ type: 'bridge/result', clientId: `placement-timeout-${lateResult}`,
            requestId: message.requestId, leaseTerm: message.leaseTerm,
            result: { ok: false, commitUnknown: true, nativeCallSettled: false } }));
        }
      });
      if (lateResult)
        await assert.rejects(placementTimeoutServer.request(rawCreate ? '/bridge/jlceda/api/invoke' : '/bridge/jlceda/component/place/check',
          rawCreate ? { apiFullName: 'eda.sch_PrimitiveComponent.create', args: [] } : { sessionId: 'timeout' }, 100), /Request execution timeout/);
      else
        assert.equal((await placementTimeoutServer.request(rawCreate ? '/bridge/jlceda/api/invoke' : '/bridge/jlceda/component/place/check',
          rawCreate ? { apiFullName: 'eda.sch_PrimitiveComponent.create', args: [] } : { sessionId: 'timeout' }, 2000)).commitUnknown, true);
      assert.ok(heldTask);
      const before = (await placementTimeoutServer.request('/bridge/admin/clients', {}, 2000)).clients[0].quarantine.diagnostics[0];
      assert.equal(before.requiredReadback, 'schematic_component_ids');
      assert.equal(before.hostRestartRequired, true);
      if (lateResult) {
        const processed = waitForMessage(placementTimeoutOld.socket, message => message.type === 'bridge/heartbeat-ack');
        placementTimeoutOld.socket.send(JSON.stringify({ type: 'bridge/result', clientId: 'placement-timeout-true',
          requestId: heldTask.requestId, leaseTerm: heldTask.leaseTerm,
          result: { ok: false, commitUnknown: true, nativeCallSettled: true } }));
        placementTimeoutOld.socket.send(JSON.stringify({ type: 'bridge/heartbeat', clientId: 'placement-timeout-true', sentAt: Date.now() }));
        await processed;
        const after = (await placementTimeoutServer.request('/bridge/admin/clients', {}, 2000)).clients[0].quarantine.diagnostics[0];
        assert.equal(after.hostRestartRequired, false);
        assert.equal(after.requiredReadback, 'schematic_component_ids');
      } else {
        const recovery = await placementTimeoutServer.request('/bridge/admin/recover-client', {
          action: 'recover', confirm: true, requestId: before.requestId,
        }, 2000);
        await assert.rejects(placementTimeoutServer.request('/bridge/admin/recover-client', {
          action: 'readback', confirm: true, recoveryId: recovery.recoveryId,
          clientId: 'future-fresh-client', readbackPath: '/bridge/jlceda/api/invoke',
          readbackPayload: { apiFullName: 'eda.sch_PrimitiveComponent.getAllPrimitiveId', args: [null, false] },
        }, 2000), /original EDA host was restarted/);
      }
    } finally {
      placementTimeoutOld?.socket.close();
      placementTimeoutServer.close();
    }
  }

  const placementStartPort = await reservePort();
  const placementStartServer = new EdaBridgeServer(placementStartPort);
  let placementStartClient;
  try {
    await placementStartServer.start();
    placementStartClient = await registerEda(`ws://127.0.0.1:${placementStartPort}/bridge/ws${tokenQuery}`,
      'placement-start-unknown', { documentUuid: 'placement-document', projectUuid: 'placement-project',
        pageKind: 'schematic', pageUuid: 'placement-page' });
    attachTaskResponder(placementStartClient.socket, 'placement-start-unknown', () => ({
      ok: false, commitUnknown: true, nativeCallSettled: false,
    }));
    const startResult = await placementStartServer.request('/bridge/jlceda/component/place/start', { component: {} }, 2000);
    assert.equal(startResult.commitUnknown, true);
    const startDiagnostic = (await placementStartServer.request('/bridge/admin/clients', {}, 2000)).clients[0].quarantine.diagnostics[0];
    assert.equal(startDiagnostic.requiredReadback, 'schematic_component_ids');
    assert.equal(startDiagnostic.hostRestartRequired, true);
  } finally {
    placementStartClient?.socket.close();
    placementStartServer.close();
  }

  for (const editAction of ['modify', 'delete']) {
    const editPort = await reservePort();
    const editServer = new EdaBridgeServer(editPort);
    let oldClient;
    let freshClient;
    try {
      await editServer.start();
      const editUrl = `ws://127.0.0.1:${editPort}/bridge/ws${tokenQuery}`;
      const pageContext = { documentUuid: 'component-document', projectUuid: 'component-project',
        pageKind: 'schematic', pageUuid: 'component-page' };
      oldClient = await registerEda(editUrl, `component-edit-${editAction}-old`, pageContext);
      oldClient.socket.on('message', data => {
        const message = JSON.parse(data.toString());
        if (message.type !== 'bridge/task') return;
        oldClient.socket.send(JSON.stringify({ type: 'bridge/task-started', clientId: `component-edit-${editAction}-old`,
          requestId: message.requestId, leaseTerm: message.leaseTerm, startedAt: Date.now(), context: pageContext }));
        oldClient.socket.send(JSON.stringify({ type: 'bridge/result', clientId: `component-edit-${editAction}-old`,
          requestId: message.requestId, leaseTerm: message.leaseTerm,
          result: { ok: false, action: editAction, commitUnknown: true, nativeCallSettled: false } }));
      });
      const writePayload = editAction === 'modify'
        ? { action: editAction, primitiveId: 'r1', property: { designator: 'R2' } }
        : { action: editAction, primitiveId: 'r1' };
      assert.equal((await editServer.request('/bridge/jlceda/schematic/component-edit', writePayload, 2000)).commitUnknown, true);
      const diagnostic = (await editServer.request('/bridge/admin/clients', {}, 2000)).clients[0].quarantine.diagnostics[0];
      assert.equal(diagnostic.requiredReadback, 'schematic_component_state');
      assert.equal(diagnostic.hostRestartRequired, true);
      assert.equal(diagnostic.pageBound, true);
      await assert.rejects(editServer.request('/bridge/jlceda/schematic/component-edit', writePayload, 2000),
        /writes are blocked pending recovery readback/);
      const recovery = await editServer.request('/bridge/admin/recover-client', {
        action: 'recover', confirm: true, requestId: diagnostic.requestId,
      }, 2000);
      oldClient.socket.close();
      await waitUntil(async () => (await editServer.request('/bridge/admin/clients', {}, 2000)).clients
        .find(client => client.clientId === `component-edit-${editAction}-old`)?.ready === false);
      freshClient = await registerEda(editUrl, `component-edit-${editAction}-fresh`, pageContext);
      const component = { primitiveId: 'r1', type: 'part', x: 10, y: 20, rotation: 0, mirror: false,
        designator: 'R1', name: 'Resistor', uniqueId: null, addIntoBom: true, addIntoPcb: true,
        manufacturer: null, manufacturerId: null, supplier: null, supplierId: null, otherProperty: { Value: '10k' } };
      const snapshot = { ok: true, action: 'read', scope: 'current_schematic_page', complete: true,
        pageUuid: 'component-page', componentCount: 1, components: [component] };
      let readback = snapshot;
      let expectedLongReadback = false;
      attachTaskResponder(freshClient.socket, `component-edit-${editAction}-fresh`, message => {
        if (message.path === '/bridge/jlceda/context')
          return { currentDocumentInfo: { uuid: 'component-document', parentProjectUuid: 'component-project' },
            currentProjectInfo: { uuid: 'component-project' }, currentSchematicPageInfo: { uuid: 'component-page' } };
        assert.equal(message.path, '/bridge/jlceda/schematic/component-edit');
        assert.deepEqual(message.payload, expectedLongReadback ? { action: 'read', timeoutMs: 39000 } : { action: 'read' });
        return readback;
      });
      const recoveryReadback = { action: 'readback', confirm: true, recoveryId: recovery.recoveryId,
        clientId: `component-edit-${editAction}-fresh`, hostRestartConfirmed: true,
        readbackPath: '/bridge/jlceda/schematic/component-edit', readbackPayload: { action: 'read' } };
      await assert.rejects(editServer.request('/bridge/admin/recover-client', {
        ...recoveryReadback, readbackPath: '/bridge/jlceda/context', readbackPayload: {},
      }, 2000), /requires schematic_component_edit action=read/);
      await assert.rejects(editServer.request('/bridge/admin/recover-client', {
        ...recoveryReadback, hostRestartConfirmed: false,
      }, 2000), /original EDA host was restarted/);
      readback = { ...snapshot, componentCount: 2 };
      await assert.rejects(editServer.request('/bridge/admin/recover-client', recoveryReadback, 2000), /component state readback was incomplete/);
      readback = { ...snapshot, pageUuid: 'other-page' };
      await assert.rejects(editServer.request('/bridge/admin/recover-client', recoveryReadback, 2000), /from another page/);
      readback = { ...snapshot, components: [{ ...component, x: null }] };
      await assert.rejects(editServer.request('/bridge/admin/recover-client', recoveryReadback, 2000), /component state readback was incomplete/);
      readback = snapshot;
      expectedLongReadback = true;
      const verified = await editServer.request('/bridge/admin/recover-client', recoveryReadback, 40000);
      assert.equal(verified.readbackVerified, true);
      assert.deepEqual(verified.readback.components, [component]);
      assert.equal(verified.writesRemainBlocked, false);
    } finally {
      oldClient?.socket.close();
      freshClient?.socket.close();
      editServer.close();
    }
  }

  const pinNetworkPort = await reservePort();
  const pinNetworkServer = new EdaBridgeServer(pinNetworkPort);
  let pinNetworkClient;
  try {
    await pinNetworkServer.start();
    pinNetworkClient = await registerEda(`ws://127.0.0.1:${pinNetworkPort}/bridge/ws${tokenQuery}`,
      'pin-network-changed', { documentUuid: 'pin-document', projectUuid: 'pin-project',
        pageKind: 'schematic', pageUuid: 'pin-page' });
    attachTaskResponder(pinNetworkClient.socket, 'pin-network-changed', () => ({
      ok: false, action: 'modify', reason: 'pin_network_changed',
      committed: true, commitUnknown: true, nativeCallSettled: true,
      pinNetworkChanges: [{ pinNumber: '2', before: 'EN_UVLO', after: '12V_OUT' }],
    }));
    const pinNetworkResult = await pinNetworkServer.request('/bridge/jlceda/schematic/component-edit',
      { action: 'modify', primitiveId: 'r1', property: { x: 10 } }, 2000);
    assert.equal(pinNetworkResult.reason, 'pin_network_changed');
    const diagnostic = (await pinNetworkServer.request('/bridge/admin/clients', {}, 2000)).clients[0].quarantine.diagnostics[0];
    assert.equal(diagnostic.requiredReadback, 'schematic_connectivity_primitives');
    assert.equal(diagnostic.hostRestartRequired, false);
  } finally {
    pinNetworkClient?.socket.close();
    pinNetworkServer.close();
  }

  for (const editAction of ['create', 'modify', 'delete']) {
    const editPort = await reservePort();
    const editServer = new EdaBridgeServer(editPort);
    let oldClient;
    let freshClient;
    try {
      await editServer.start();
      const editUrl = `ws://127.0.0.1:${editPort}/bridge/ws${tokenQuery}`;
      const pageContext = { documentUuid: 'pcb-component-document', projectUuid: 'pcb-component-project',
        pageKind: 'pcb', pageUuid: 'pcb-component-page' };
      oldClient = await registerEda(editUrl, `pcb-component-${editAction}-old`, pageContext);
      oldClient.socket.on('message', data => {
        const message = JSON.parse(data.toString());
        if (message.type !== 'bridge/task') return;
        oldClient.socket.send(JSON.stringify({ type: 'bridge/task-started', clientId: `pcb-component-${editAction}-old`,
          requestId: message.requestId, leaseTerm: message.leaseTerm, startedAt: Date.now(), context: pageContext }));
        oldClient.socket.send(JSON.stringify({ type: 'bridge/result', clientId: `pcb-component-${editAction}-old`,
          requestId: message.requestId, leaseTerm: message.leaseTerm,
          result: { ok: false, action: editAction, commitUnknown: true, nativeCallSettled: false } }));
      });
      const writePayload = editAction === 'create'
        ? { action: 'create', source: { kind: 'device', libraryUuid: 'lib', uuid: 'dev' }, layer: 1, x: 10, y: 20 }
        : editAction === 'modify'
          ? { action: 'modify', primitiveId: 'p1', property: { x: 11 } }
          : { action: 'delete', primitiveId: 'p1' };
      assert.equal((await editServer.request('/bridge/jlceda/pcb/component-edit', writePayload, 2000)).commitUnknown, true);
      const diagnostic = (await editServer.request('/bridge/admin/clients', {}, 2000)).clients[0].quarantine.diagnostics[0];
      assert.equal(diagnostic.requiredReadback, 'pcb_component_state');
      assert.equal(diagnostic.hostRestartRequired, true);
      assert.equal(diagnostic.pageBound, true);
      await assert.rejects(editServer.request('/bridge/jlceda/pcb/component-edit', writePayload, 2000),
        /writes are blocked pending recovery readback/);
      const recovery = await editServer.request('/bridge/admin/recover-client', {
        action: 'recover', confirm: true, requestId: diagnostic.requestId,
      }, 2000);
      oldClient.socket.close();
      await waitUntil(async () => (await editServer.request('/bridge/admin/clients', {}, 2000)).clients
        .find(client => client.clientId === `pcb-component-${editAction}-old`)?.ready === false);
      freshClient = await registerEda(editUrl, `pcb-component-${editAction}-fresh`, pageContext);
      const component = { primitiveId: 'p1', layer: 1, x: 10, y: 20, rotation: 0, primitiveLock: false,
        designator: 'R1', component: { libraryUuid: 'lib', uuid: 'dev', name: 'Resistor' },
        footprint: { libraryUuid: 'lib', uuid: 'fp' }, addIntoBom: true, name: 'Resistor', uniqueId: null,
        manufacturer: null, manufacturerId: null, supplier: null, supplierId: null, otherProperty: { Value: '10k' } };
      const snapshot = { ok: true, action: 'read', scope: 'current_pcb_page', complete: true,
        pageUuid: 'pcb-component-page', componentCount: 1, components: [component] };
      let readback = snapshot;
      attachTaskResponder(freshClient.socket, `pcb-component-${editAction}-fresh`, message => {
        if (message.path === '/bridge/jlceda/context')
          return { currentDocumentInfo: { uuid: 'pcb-component-document', parentProjectUuid: 'pcb-component-project' },
            currentProjectInfo: { uuid: 'pcb-component-project' }, currentPcbInfo: { uuid: 'pcb-component-page' } };
        assert.equal(message.path, '/bridge/jlceda/pcb/component-edit');
        assert.deepEqual(message.payload, { action: 'read' });
        return readback;
      });
      const recoveryReadback = { action: 'readback', confirm: true, recoveryId: recovery.recoveryId,
        clientId: `pcb-component-${editAction}-fresh`, hostRestartConfirmed: true,
        readbackPath: '/bridge/jlceda/pcb/component-edit', readbackPayload: { action: 'read' } };
      await assert.rejects(editServer.request('/bridge/admin/recover-client', {
        ...recoveryReadback, readbackPath: '/bridge/jlceda/context', readbackPayload: {},
      }, 2000), /requires pcb_component_edit action=read/);
      await assert.rejects(editServer.request('/bridge/admin/recover-client', {
        ...recoveryReadback, hostRestartConfirmed: false,
      }, 2000), /original EDA host was restarted/);
      readback = { ...snapshot, componentCount: 2 };
      await assert.rejects(editServer.request('/bridge/admin/recover-client', recoveryReadback, 2000), /component state readback was incomplete/);
      readback = { ...snapshot, pageUuid: 'another-page' };
      await assert.rejects(editServer.request('/bridge/admin/recover-client', recoveryReadback, 2000), /from another page/);
      readback = { ...snapshot, components: [{ ...component, rotation: null }] };
      await assert.rejects(editServer.request('/bridge/admin/recover-client', recoveryReadback, 2000), /component state readback was incomplete/);
      readback = { ...snapshot, components: [{ ...component, otherProperty: undefined }] };
      await assert.rejects(editServer.request('/bridge/admin/recover-client', recoveryReadback, 2000), /component state readback was incomplete/);
      readback = snapshot;
      const verified = await editServer.request('/bridge/admin/recover-client', recoveryReadback, 2000);
      assert.equal(verified.readbackVerified, true);
      assert.deepEqual(verified.readback.components, [component]);
      assert.equal(verified.writesRemainBlocked, false);
    } finally {
      oldClient?.socket.close();
      freshClient?.socket.close();
      editServer.close();
    }
  }

  for (const pourAction of ['create', 'modify', 'delete', 'rebuild']) {
    const pourPort = await reservePort();
    const pourServer = new EdaBridgeServer(pourPort);
    let oldClient;
    let freshClient;
    try {
      await pourServer.start();
      const pourUrl = `ws://127.0.0.1:${pourPort}/bridge/ws${tokenQuery}`;
      const pageContext = { documentUuid: 'pour-document', projectUuid: 'pour-project',
        pageKind: 'pcb', pageUuid: 'pour-page' };
      oldClient = await registerEda(pourUrl, `pour-${pourAction}-old`, pageContext);
      oldClient.socket.on('message', data => {
        const message = JSON.parse(data.toString());
        if (message.type !== 'bridge/task') return;
        oldClient.socket.send(JSON.stringify({ type: 'bridge/task-started', clientId: `pour-${pourAction}-old`,
          requestId: message.requestId, leaseTerm: message.leaseTerm, startedAt: Date.now(), context: pageContext }));
        oldClient.socket.send(JSON.stringify({ type: 'bridge/result', clientId: `pour-${pourAction}-old`,
          requestId: message.requestId, leaseTerm: message.leaseTerm,
          result: { ok: false, action: pourAction, commitUnknown: true,
            nativeCallSettled: pourAction === 'rebuild' } }));
      });
      const writePayload = pourAction === 'create'
        ? { action: 'create', net: 'GND', layer: 1, polygonSource: ['L', 0, 0, 10, 0, 10, 10, 'C'] }
        : pourAction === 'modify'
          ? { action: 'modify', primitiveId: 'pour-1', property: { pourPriority: 2 } }
          : { action: pourAction, primitiveId: 'pour-1' };
      assert.equal((await pourServer.request('/bridge/jlceda/pcb/pour-manage', writePayload, 2000)).commitUnknown, true);
      const diagnostic = (await pourServer.request('/bridge/admin/clients', {}, 2000)).clients[0].quarantine.diagnostics[0];
      assert.equal(diagnostic.requiredReadback, 'pcb_pour_state');
      assert.equal(diagnostic.hostRestartRequired, pourAction !== 'rebuild');
      assert.equal(diagnostic.pageBound, true);
      await assert.rejects(pourServer.request('/bridge/jlceda/pcb/pour-manage', writePayload, 2000),
        /writes are blocked pending recovery readback/);
      const recovery = await pourServer.request('/bridge/admin/recover-client', {
        action: 'recover', confirm: true, requestId: diagnostic.requestId,
      }, 2000);
      oldClient.socket.close();
      await waitUntil(async () => (await pourServer.request('/bridge/admin/clients', {}, 2000)).clients
        .find(client => client.clientId === `pour-${pourAction}-old`)?.ready === false);
      freshClient = await registerEda(pourUrl, `pour-${pourAction}-fresh`, pageContext);
      const pour = { primitiveId: 'pour-1', net: 'GND', layer: 1,
        polygonSource: ['L', 0, 0, 10, 0, 10, 10, 'C'], pourFillMethod: 'solid',
        preserveSilos: false, pourName: '', pourPriority: 1, lineWidth: 0.1, primitiveLock: false };
      const filled = { primitiveId: 'poured-1', pourPrimitiveId: 'pour-1', fillCount: 1,
        fillGeometryDigest: 'fnv1a64:9a4c0a1f44d91e2b' };
      const snapshot = { ok: true, action: 'read', scope: 'current_pcb_page', complete: true,
        pageUuid: 'pour-page', pourCount: 1, pours: [pour], pouredCount: 1, poured: [filled] };
      let readback = snapshot;
      attachTaskResponder(freshClient.socket, `pour-${pourAction}-fresh`, message => {
        if (message.path === '/bridge/jlceda/context')
          return { currentDocumentInfo: { uuid: 'pour-document', parentProjectUuid: 'pour-project' },
            currentProjectInfo: { uuid: 'pour-project' }, currentPcbInfo: { uuid: 'pour-page' } };
        assert.equal(message.path, '/bridge/jlceda/pcb/pour-manage');
        assert.deepEqual(message.payload, { action: 'read' });
        return readback;
      });
      const recoveryReadback = { action: 'readback', confirm: true, recoveryId: recovery.recoveryId,
        clientId: `pour-${pourAction}-fresh`, hostRestartConfirmed: true,
        readbackPath: '/bridge/jlceda/pcb/pour-manage', readbackPayload: { action: 'read' } };
      await assert.rejects(pourServer.request('/bridge/admin/recover-client', {
        ...recoveryReadback, readbackPath: '/bridge/jlceda/context', readbackPayload: {},
      }, 2000), /requires pcb_pour_manage action=read/);
      if (pourAction !== 'rebuild')
        await assert.rejects(pourServer.request('/bridge/admin/recover-client', {
          ...recoveryReadback, hostRestartConfirmed: false,
        }, 2000), /original EDA host was restarted/);
      readback = { ...snapshot, pourCount: 2 };
      await assert.rejects(pourServer.request('/bridge/admin/recover-client', recoveryReadback, 2000), /pour state readback was incomplete/);
      readback = { ...snapshot, pouredCount: 2 };
      await assert.rejects(pourServer.request('/bridge/admin/recover-client', recoveryReadback, 2000), /pour state readback was incomplete/);
      readback = { ...snapshot, pageUuid: 'another-page' };
      await assert.rejects(pourServer.request('/bridge/admin/recover-client', recoveryReadback, 2000), /from another page/);
      readback = { ...snapshot, pours: [{ ...pour, polygonSource: ['BAD', 0, 0] }] };
      await assert.rejects(pourServer.request('/bridge/admin/recover-client', recoveryReadback, 2000), /pour border readback was incomplete/);
      readback = { ...snapshot, poured: [{ ...filled, fillCount: null }] };
      await assert.rejects(pourServer.request('/bridge/admin/recover-client', recoveryReadback, 2000), /poured fill readback was incomplete/);
      readback = { ...snapshot, poured: [{ ...filled, fillGeometryDigest: '' }] };
      await assert.rejects(pourServer.request('/bridge/admin/recover-client', recoveryReadback, 2000), /poured fill readback was incomplete/);
      readback = snapshot;
      const verified = await pourServer.request('/bridge/admin/recover-client', recoveryReadback, 2000);
      assert.equal(verified.readbackVerified, true);
      assert.deepEqual(verified.readback.pours, [pour]);
      assert.deepEqual(verified.readback.poured, [filled]);
      assert.equal(verified.writesRemainBlocked, false);
    } finally {
      oldClient?.socket.close();
      freshClient?.socket.close();
      pourServer.close();
    }
  }

  const regionPort = await reservePort();
  const regionServer = new EdaBridgeServer(regionPort);
  let oldRegionClient;
  let freshRegionClient;
  try {
    await regionServer.start();
    const regionUrl = `ws://127.0.0.1:${regionPort}/bridge/ws${tokenQuery}`;
    const pageContext = { documentUuid: 'region-document', projectUuid: 'region-project',
      pageKind: 'pcb', pageUuid: 'region-page' };
    oldRegionClient = await registerEda(regionUrl, 'region-old', pageContext);
    oldRegionClient.socket.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type !== 'bridge/task') return;
      oldRegionClient.socket.send(JSON.stringify({ type: 'bridge/task-started', clientId: 'region-old',
        requestId: message.requestId, leaseTerm: message.leaseTerm, startedAt: Date.now(), context: pageContext }));
      oldRegionClient.socket.send(JSON.stringify({ type: 'bridge/result', clientId: 'region-old',
        requestId: message.requestId, leaseTerm: message.leaseTerm,
        result: { ok: false, action: 'create', commitUnknown: true, nativeCallSettled: false } }));
    });
    const writePayload = { action: 'create', layer: 1, polygonSource: ['R', 0, 0, 100, 100, 0, 0], ruleType: [2] };
    assert.equal((await regionServer.request('/bridge/jlceda/pcb/region-manage', writePayload, 2000)).commitUnknown, true);
    const diagnostic = (await regionServer.request('/bridge/admin/clients', {}, 2000)).clients[0].quarantine.diagnostics[0];
    assert.equal(diagnostic.requiredReadback, 'pcb_region_state');
    assert.equal(diagnostic.hostRestartRequired, true);
    const recovery = await regionServer.request('/bridge/admin/recover-client', {
      action: 'recover', confirm: true, requestId: diagnostic.requestId,
    }, 2000);
    oldRegionClient.socket.close();
    await waitUntil(async () => (await regionServer.request('/bridge/admin/clients', {}, 2000)).clients
      .find(client => client.clientId === 'region-old')?.ready === false);
    freshRegionClient = await registerEda(regionUrl, 'region-fresh', pageContext);
    const region = { primitiveId: 'r1', layer: 1, polygonSource: ['R', 0, 0, 100, 100, 0, 0],
      ruleType: [2], regionName: null, lineWidth: 0.2, primitiveLock: false };
    const snapshot = { ok: true, action: 'read', scope: 'current_pcb_page', complete: true,
      pageUuid: 'region-page', regionCount: 1, regions: [region] };
    let readback = snapshot;
    attachTaskResponder(freshRegionClient.socket, 'region-fresh', message => {
      if (message.path === '/bridge/jlceda/context')
        return { currentDocumentInfo: { uuid: 'region-document', parentProjectUuid: 'region-project' },
          currentProjectInfo: { uuid: 'region-project' }, currentPcbInfo: { uuid: 'region-page' } };
      assert.equal(message.path, '/bridge/jlceda/pcb/region-manage');
      assert.deepEqual(message.payload, { action: 'read' });
      return readback;
    });
    const recoveryReadback = { action: 'readback', confirm: true, recoveryId: recovery.recoveryId,
      clientId: 'region-fresh', hostRestartConfirmed: true,
      readbackPath: '/bridge/jlceda/pcb/region-manage', readbackPayload: { action: 'read' } };
    await assert.rejects(regionServer.request('/bridge/admin/recover-client', {
      ...recoveryReadback, readbackPayload: { action: 'read', primitiveId: 'r1' },
    }, 2000), /without primitiveId/);
    await assert.rejects(regionServer.request('/bridge/admin/recover-client', {
      ...recoveryReadback, hostRestartConfirmed: false,
    }, 2000), /original EDA host was restarted/);
    readback = { ...snapshot, regionCount: 2 };
    await assert.rejects(regionServer.request('/bridge/admin/recover-client', recoveryReadback, 2000), /region state readback was incomplete/);
    readback = { ...snapshot, regions: [{ ...region, ruleType: [3] }] };
    await assert.rejects(regionServer.request('/bridge/admin/recover-client', recoveryReadback, 2000), /region readback was incomplete/);
    const complexRegion = { ...region, polygonSource: [region.polygonSource, ['R', 20, 20, 40, 40, 0, 0]] };
    readback = { ...snapshot, regions: [complexRegion] };
    const verified = await regionServer.request('/bridge/admin/recover-client', recoveryReadback, 2000);
    assert.equal(verified.readbackVerified, true);
    assert.deepEqual(verified.readback.regions, [complexRegion]);
    assert.equal(verified.writesRemainBlocked, false);
  } finally {
    oldRegionClient?.socket.close();
    freshRegionClient?.socket.close();
    regionServer.close();
  }

  const textPort = await reservePort();
  const textServer = new EdaBridgeServer(textPort);
  let oldTextClient;
  let freshTextClient;
  try {
    await textServer.start();
    const textUrl = `ws://127.0.0.1:${textPort}/bridge/ws${tokenQuery}`;
    const pageContext = { documentUuid: 'text-document', projectUuid: 'text-project',
      pageKind: 'pcb', pageUuid: 'text-page' };
    oldTextClient = await registerEda(textUrl, 'text-old', pageContext);
    oldTextClient.socket.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type !== 'bridge/task') return;
      oldTextClient.socket.send(JSON.stringify({ type: 'bridge/task-started', clientId: 'text-old',
        requestId: message.requestId, leaseTerm: message.leaseTerm, startedAt: Date.now(), context: pageContext }));
      oldTextClient.socket.send(JSON.stringify({ type: 'bridge/result', clientId: 'text-old',
        requestId: message.requestId, leaseTerm: message.leaseTerm,
        result: { ok: false, action: 'create', commitUnknown: true, nativeCallSettled: false } }));
    });
    assert.equal((await textServer.request('/bridge/jlceda/pcb/text-manage',
      { action: 'create', kind: 'string', layer: 3, x: 1, y: 2, text: 'Rev A' }, 2000)).commitUnknown, true);
    const diagnostic = (await textServer.request('/bridge/admin/clients', {}, 2000)).clients[0].quarantine.diagnostics[0];
    assert.equal(diagnostic.requiredReadback, 'pcb_text_state');
    assert.equal(diagnostic.hostRestartRequired, true);
    const recovery = await textServer.request('/bridge/admin/recover-client', {
      action: 'recover', confirm: true, requestId: diagnostic.requestId,
    }, 2000);
    oldTextClient.socket.close();
    await waitUntil(async () => (await textServer.request('/bridge/admin/clients', {}, 2000)).clients
      .find(client => client.clientId === 'text-old')?.ready === false);
    freshTextClient = await registerEda(textUrl, 'text-fresh', pageContext);
    const common = { layer: 3, x: 1, y: 2, fontFamily: 'default', fontSize: 45, lineWidth: 6,
      alignMode: 3, rotation: 0, reverse: false, expansion: 0, mirror: false, primitiveLock: false };
    const string = { primitiveId: 's1', ...common, text: 'Rev A' };
    const attribute = { primitiveId: 'a1', ...common, parentPrimitiveId: 'c1', key: 'Designator',
      value: 'U1', keyVisible: false, valueVisible: true };
    const snapshot = { ok: true, action: 'read', scope: 'current_pcb_page', complete: true,
      pageUuid: 'text-page', stringCount: 1, strings: [string], attributeCount: 1, attributes: [attribute] };
    let readback = snapshot;
    attachTaskResponder(freshTextClient.socket, 'text-fresh', message => {
      if (message.path === '/bridge/jlceda/context')
        return { currentDocumentInfo: { uuid: 'text-document', parentProjectUuid: 'text-project' },
          currentProjectInfo: { uuid: 'text-project' }, currentPcbInfo: { uuid: 'text-page' } };
      assert.equal(message.path, '/bridge/jlceda/pcb/text-manage');
      assert.deepEqual(message.payload, { action: 'read' });
      return readback;
    });
    const recoveryReadback = { action: 'readback', confirm: true, recoveryId: recovery.recoveryId,
      clientId: 'text-fresh', hostRestartConfirmed: true,
      readbackPath: '/bridge/jlceda/pcb/text-manage', readbackPayload: { action: 'read' } };
    await assert.rejects(textServer.request('/bridge/admin/recover-client', {
      ...recoveryReadback, readbackPayload: { action: 'read', kind: 'string' },
    }, 2000), /without filters/);
    readback = { ...snapshot, stringCount: 2 };
    await assert.rejects(textServer.request('/bridge/admin/recover-client', recoveryReadback, 2000), /text state readback was incomplete/);
    readback = { ...snapshot, attributes: [{ ...attribute, parentPrimitiveId: '' }] };
    await assert.rejects(textServer.request('/bridge/admin/recover-client', recoveryReadback, 2000), /attribute readback was incomplete/);
    readback = snapshot;
    const verified = await textServer.request('/bridge/admin/recover-client', recoveryReadback, 2000);
    assert.equal(verified.readbackVerified, true);
    assert.deepEqual(verified.readback.strings, [string]);
    assert.deepEqual(verified.readback.attributes, [attribute]);
    assert.equal(verified.writesRemainBlocked, false);
  } finally {
    oldTextClient?.socket.close();
    freshTextClient?.socket.close();
    textServer.close();
  }

  const schematicTextPort = await reservePort();
  const schematicTextServer = new EdaBridgeServer(schematicTextPort);
  let oldSchematicTextClient;
  let freshSchematicTextClient;
  try {
    await schematicTextServer.start();
    const url = `ws://127.0.0.1:${schematicTextPort}/bridge/ws${tokenQuery}`;
    const pageContext = { documentUuid: 'schematic-text-page', projectUuid: 'schematic-text-project',
      pageKind: 'schematic', pageUuid: 'schematic-text-page' };
    oldSchematicTextClient = await registerEda(url, 'schematic-text-old', pageContext);
    oldSchematicTextClient.socket.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type !== 'bridge/task') return;
      oldSchematicTextClient.socket.send(JSON.stringify({ type: 'bridge/task-started', clientId: 'schematic-text-old',
        requestId: message.requestId, leaseTerm: message.leaseTerm, startedAt: Date.now(), context: pageContext }));
      oldSchematicTextClient.socket.send(JSON.stringify({ type: 'bridge/result', clientId: 'schematic-text-old',
        requestId: message.requestId, leaseTerm: message.leaseTerm,
        result: { ok: false, action: 'create', commitUnknown: true, nativeCallSettled: false } }));
    });
    assert.equal((await schematicTextServer.request('/bridge/jlceda/schematic/text-manage',
      { action: 'create', x: 1, y: 2, content: 'Note' }, 2000)).commitUnknown, true);
    const diagnostic = (await schematicTextServer.request('/bridge/admin/clients', {}, 2000)).clients[0].quarantine.diagnostics[0];
    assert.equal(diagnostic.requiredReadback, 'schematic_text_state');
    assert.equal(diagnostic.hostRestartRequired, true);
    const recovery = await schematicTextServer.request('/bridge/admin/recover-client', {
      action: 'recover', confirm: true, requestId: diagnostic.requestId,
    }, 2000);
    oldSchematicTextClient.socket.close();
    await waitUntil(async () => (await schematicTextServer.request('/bridge/admin/clients', {}, 2000)).clients
      .find(client => client.clientId === 'schematic-text-old')?.ready === false);
    freshSchematicTextClient = await registerEda(url, 'schematic-text-fresh', pageContext);
    const item = { primitiveId: 'note-1', x: 1, y: 2, content: 'Note', rotation: 0,
      textColor: null, fontName: null, fontSize: null, bold: false, italic: false, underLine: false, alignMode: 1 };
    const snapshot = { ok: true, action: 'read', scope: 'current_schematic_page', complete: true,
      pageUuid: 'schematic-text-page', textCount: 1, texts: [item] };
    let readback = snapshot;
    attachTaskResponder(freshSchematicTextClient.socket, 'schematic-text-fresh', message => {
      if (message.path === '/bridge/jlceda/context')
        return { currentDocumentInfo: { uuid: 'schematic-text-page', parentProjectUuid: 'schematic-text-project' },
          currentProjectInfo: { uuid: 'schematic-text-project' },
          currentSchematicPageInfo: { uuid: 'schematic-text-page' } };
      assert.equal(message.path, '/bridge/jlceda/schematic/text-manage');
      assert.deepEqual(message.payload, { action: 'read' });
      return readback;
    });
    const recoveryReadback = { action: 'readback', confirm: true, recoveryId: recovery.recoveryId,
      clientId: 'schematic-text-fresh', hostRestartConfirmed: true,
      readbackPath: '/bridge/jlceda/schematic/text-manage', readbackPayload: { action: 'read' } };
    await assert.rejects(schematicTextServer.request('/bridge/admin/recover-client', {
      ...recoveryReadback, readbackPayload: { action: 'read', primitiveId: 'note-1' },
    }, 2000), /without primitiveId/);
    readback = { ...snapshot, textCount: 2 };
    await assert.rejects(schematicTextServer.request('/bridge/admin/recover-client', recoveryReadback, 2000), /text state readback was incomplete/);
    readback = snapshot;
    const verified = await schematicTextServer.request('/bridge/admin/recover-client', recoveryReadback, 2000);
    assert.equal(verified.readbackVerified, true);
    assert.deepEqual(verified.readback.texts, [item]);
    assert.equal(verified.writesRemainBlocked, false);
  } finally {
    oldSchematicTextClient?.socket.close();
    freshSchematicTextClient?.socket.close();
    schematicTextServer.close();
  }

  const layerPort = await reservePort();
  const layerServer = new EdaBridgeServer(layerPort);
  let oldLayerClient;
  let freshLayerClient;
  try {
    await layerServer.start();
    const layerUrl = `ws://127.0.0.1:${layerPort}/bridge/ws${tokenQuery}`;
    const pageContext = { documentUuid: 'layer-document', projectUuid: 'layer-project',
      pageKind: 'pcb', pageUuid: 'layer-page' };
    oldLayerClient = await registerEda(layerUrl, 'layer-old', pageContext);
    oldLayerClient.socket.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type !== 'bridge/task') return;
      oldLayerClient.socket.send(JSON.stringify({ type: 'bridge/task-started', clientId: 'layer-old',
        requestId: message.requestId, leaseTerm: message.leaseTerm, startedAt: Date.now(), context: pageContext }));
      oldLayerClient.socket.send(JSON.stringify({ type: 'bridge/result', clientId: 'layer-old',
        requestId: message.requestId, leaseTerm: message.leaseTerm,
        result: { ok: false, action: 'set', commitUnknown: true, nativeCallSettled: false } }));
    });
    assert.equal((await layerServer.request('/bridge/jlceda/pcb/layer-manage',
      { action: 'set', confirm: true, copperLayerCount: 4 }, 2000)).commitUnknown, true);
    const diagnostic = (await layerServer.request('/bridge/admin/clients', {}, 2000)).clients[0].quarantine.diagnostics[0];
    assert.equal(diagnostic.requiredReadback, 'pcb_layer_state');
    assert.equal(diagnostic.hostRestartRequired, true);
    const recovery = await layerServer.request('/bridge/admin/recover-client', {
      action: 'recover', confirm: true, requestId: diagnostic.requestId,
    }, 2000);
    oldLayerClient.socket.close();
    await waitUntil(async () => (await layerServer.request('/bridge/admin/clients', {}, 2000)).clients
      .find(client => client.clientId === 'layer-old')?.ready === false);
    freshLayerClient = await registerEda(layerUrl, 'layer-fresh', pageContext);
    const layers = [{ id: 1, type: 'SIGNAL', layerStatus: 1 }, { id: 2, type: 'SIGNAL', layerStatus: 1 },
      { id: 15, type: 'PLANE', layerStatus: 2 }, { id: 16, type: 'SIGNAL', layerStatus: 1 },
      { id: 17, type: 'SIGNAL', layerStatus: 0 }];
    const snapshot = { ok: true, action: 'read', scope: 'current_pcb_page', complete: true,
      pageUuid: 'layer-page', copperLayerCount: 4, layerCount: 5, layers };
    let readback = snapshot;
    attachTaskResponder(freshLayerClient.socket, 'layer-fresh', message => {
      if (message.path === '/bridge/jlceda/context')
        return { currentDocumentInfo: { uuid: 'layer-document', parentProjectUuid: 'layer-project' },
          currentProjectInfo: { uuid: 'layer-project' }, currentPcbInfo: { uuid: 'layer-page' } };
      assert.equal(message.path, '/bridge/jlceda/pcb/layer-manage');
      assert.deepEqual(message.payload, { action: 'read' });
      return readback;
    });
    const recoveryReadback = { action: 'readback', confirm: true, recoveryId: recovery.recoveryId,
      clientId: 'layer-fresh', hostRestartConfirmed: true,
      readbackPath: '/bridge/jlceda/pcb/layer-manage', readbackPayload: { action: 'read' } };
    await assert.rejects(layerServer.request('/bridge/admin/recover-client', {
      ...recoveryReadback, readbackPayload: { action: 'set', copperLayerCount: 4 },
    }, 2000), /read-only operation/);
    readback = { ...snapshot, layerCount: 2 };
    await assert.rejects(layerServer.request('/bridge/admin/recover-client', recoveryReadback, 2000), /copper-layer state readback was incomplete/);
    readback = { ...snapshot, layers: [{ ...layers[0], layerStatus: 0 }, ...layers.slice(1)] };
    await assert.rejects(layerServer.request('/bridge/admin/recover-client', recoveryReadback, 2000), /copper-layer state readback was incomplete/);
    readback = { ...snapshot, layers: [{ id: 1, type: 'SIGNAL' }, ...layers.slice(1)] };
    await assert.rejects(layerServer.request('/bridge/admin/recover-client', recoveryReadback, 2000), /copper-layer state readback was incomplete/);
    readback = snapshot;
    const verified = await layerServer.request('/bridge/admin/recover-client', recoveryReadback, 2000);
    assert.equal(verified.readbackVerified, true);
    assert.equal(verified.readback.copperLayerCount, 4);
    assert.equal(verified.writesRemainBlocked, false);
  } finally {
    oldLayerClient?.socket.close();
    freshLayerClient?.socket.close();
    layerServer.close();
  }

  const pageMutationPort = await reservePort();
  const pageMutationServer = new EdaBridgeServer(pageMutationPort);
  const pcbInventory = { ok: true, operation: 'list', complete: true, projectUuid: 'target-project', pcbCount: 2,
    pcbs: [
      { uuid: 'source-pcb', name: 'Source', parentProjectUuid: 'target-project', parentBoardName: null },
      { uuid: 'copy-pcb', name: 'Copy', parentProjectUuid: 'target-project', parentBoardName: null },
    ] };
  assert.equal(pageMutationServer.validateCompletePcbDocuments(pcbInventory, {
    targetProjectUuid: 'target-project', targetPcbUuid: 'source-pcb',
  }), 2);
  assert.throws(() => pageMutationServer.validateCompletePcbDocuments({ ...pcbInventory, pcbCount: 3 }, {
    targetProjectUuid: 'target-project',
  }), /inventory readback was incomplete/);
  assert.throws(() => pageMutationServer.validateCompletePcbDocuments(pcbInventory, {
    targetProjectUuid: 'another-project',
  }), /another project/);
  assert.throws(() => pageMutationServer.validateCompletePcbDocuments(pcbInventory, {
    targetProjectUuid: 'target-project', targetPcbUuid: 'missing-pcb',
  }), /Target PCB is absent/);
  const boardInventory = {
    ok: true, project: { uuid: 'target-project' },
    boards: { total: 1, returned: 1, truncated: false, items: [{ name: 'Board-1', parentProjectUuid: 'target-project' }] },
    schematics: { total: 1, returned: 1, truncated: false, items: [{ uuid: 'sch-1', name: 'Sch-1', parentProjectUuid: 'target-project' }] },
    pcbs: { total: 1, returned: 1, truncated: false, items: [{ uuid: 'pcb-1', name: 'PCB-1', parentProjectUuid: 'target-project' }] },
  };
  assert.equal(pageMutationServer.validateCompleteBoardDocuments(boardInventory, { targetProjectUuid: 'target-project' }), 1);
  assert.throws(() => pageMutationServer.validateCompleteBoardDocuments({ ...boardInventory,
    pcbs: { ...boardInventory.pcbs, truncated: true },
  }, { targetProjectUuid: 'target-project' }), /PCB inventory readback is incomplete/);
  assert.throws(() => pageMutationServer.validateCompleteBoardDocuments(boardInventory,
    { targetProjectUuid: 'other-project' }), /target project/);
  pageMutationServer.recordTimedOutRequest('board-setup-test', {
    clientId: 'board-page', path: '/bridge/jlceda/board/setup',
    payload: { projectUuid: 'target-project', confirm: true }, startedAt: Date.now(),
  }, 30000);
  const boardDiagnostic = pageMutationServer.recoveryDiagnostics.get('board-setup-test');
  assert.equal(boardDiagnostic.pageBound, false);
  assert.equal(boardDiagnostic.targetProjectUuid, 'target-project');
  assert.equal(boardDiagnostic.requiredReadback, 'board_document_inventory');
  assert.equal(boardDiagnostic.hostRestartRequired, true);
  pageMutationServer.recoveryDiagnostics.delete('board-setup-test');
  assert.equal(pageMutationServer.validateCompleteSchematicPages({
    apiFullName: 'eda.dmt_Schematic.getAllSchematicPagesInfo', schematicPages: [], pageCount: 0,
  }, { targetSchematicUuid: 'empty-schematic', targetSchematicMayBeEmpty: true }), 0);
  assert.equal(pageMutationServer.validateCompleteSchematicPages({
    apiFullName: 'eda.dmt_Schematic.getAllSchematicPagesInfo',
    schematicPages: [{ uuid: 'source-page', parentSchematicUuid: 'source-schematic', name: 'Source' }], pageCount: 1,
  }, {
    targetSchematicUuid: 'empty-target-schematic', targetSchematicMayBeEmpty: true,
    sourceSchematicPageUuid: 'source-page',
  }), 1);
  assert.throws(() => pageMutationServer.validateCompleteSchematicPages({
    apiFullName: 'eda.dmt_Schematic.getAllSchematicPagesInfo', schematicPages: [], pageCount: 0,
  }, {
    targetSchematicUuid: 'empty-target-schematic', targetSchematicMayBeEmpty: true,
    sourceSchematicPageUuid: 'source-page',
  }), /Source schematic page is absent/);
  let pageMutationOld;
  let pageMutationFresh;
  let includeTargetPage = false;
  try {
    await pageMutationServer.start();
    pageMutationOld = await registerEda(`ws://127.0.0.1:${pageMutationPort}/bridge/ws${tokenQuery}`, 'page-mutation-old', {
      documentUuid: 'active-page-document', projectUuid: 'target-project', pageKind: 'schematic', pageUuid: 'active-page',
    });
    pageMutationOld.socket.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type !== 'bridge/task') return;
      pageMutationOld.socket.send(JSON.stringify({
        type: 'bridge/task-started', clientId: 'page-mutation-old', requestId: message.requestId,
        leaseTerm: message.leaseTerm, startedAt: Date.now(),
        context: { documentUuid: 'active-page-document', projectUuid: 'target-project', pageKind: 'schematic', pageUuid: 'active-page' },
      }));
      pageMutationOld.socket.send(JSON.stringify({
        type: 'bridge/result', clientId: 'page-mutation-old', requestId: message.requestId,
        leaseTerm: message.leaseTerm, result: { commitUnknown: true },
      }));
    });
    await pageMutationServer.request('/bridge/jlceda/schematic/pages-manage', {
      operation: 'rename', schematicPageUuid: 'target-page', newName: 'renamed', confirm: true,
    }, 2000);
    const pageDiagnostic = (await pageMutationServer.request('/bridge/admin/clients', {}, 2000)).clients[0].quarantine.diagnostics[0];
    assert.equal(pageDiagnostic.pageBound, false);
    assert.equal(pageDiagnostic.requiredReadback, 'schematic_page_inventory');
    assert.equal(pageDiagnostic.targetSchematicPageUuid, 'target-page');
    const pageRecovery = await pageMutationServer.request('/bridge/admin/recover-client', {
      action: 'recover', confirm: true, requestId: pageDiagnostic.requestId,
    }, 2000);
    pageMutationOld.socket.close();
    await waitUntil(async () => (await pageMutationServer.request('/bridge/admin/clients', {}, 2000)).clients
      .find(client => client.clientId === 'page-mutation-old')?.ready === false);
    pageMutationFresh = await registerEda(`ws://127.0.0.1:${pageMutationPort}/bridge/ws${tokenQuery}`, 'page-mutation-fresh', {
      documentUuid: 'another-page-document', projectUuid: 'target-project', pageKind: 'schematic', pageUuid: 'another-page',
    });
    attachTaskResponder(pageMutationFresh.socket, 'page-mutation-fresh', message => message.path === '/bridge/jlceda/pcb/documents-manage'
      ? { ok: false, commitUnknown: true, nativeCallSettled: true, resultingPcbUuid: 'copy-pcb' }
      : message.path === '/bridge/jlceda/api/invoke'
      ? {
          apiFullName: 'eda.dmt_Schematic.getAllSchematicPagesInfo',
          schematicPages: includeTargetPage
            ? [
                { uuid: 'active-page', parentSchematicUuid: 'target-schematic', name: 'Active' },
                { uuid: 'target-page', parentSchematicUuid: 'target-schematic', name: 'Renamed' },
              ]
            : [{ uuid: 'active-page', parentSchematicUuid: 'target-schematic', name: 'Active' }],
          pageCount: includeTargetPage ? 2 : 1,
        }
      : {
          currentDocumentInfo: { uuid: 'another-page-document', parentProjectUuid: 'target-project' },
          currentProjectInfo: { uuid: 'target-project' },
          currentSchematicPageInfo: { uuid: 'another-page' },
        });
    const pageReadback = {
      action: 'readback', confirm: true, recoveryId: pageRecovery.recoveryId,
      clientId: 'page-mutation-fresh', readbackPath: '/bridge/jlceda/api/invoke',
      readbackPayload: { apiFullName: 'eda.dmt_Schematic.getAllSchematicPagesInfo', args: [] },
    };
    await assert.rejects(pageMutationServer.request('/bridge/admin/recover-client', {
      ...pageReadback, readbackPath: '/bridge/jlceda/context',
    }, 2000), /requires eda.dmt_Schematic.getAllSchematicPagesInfo/);
    await assert.rejects(pageMutationServer.request('/bridge/admin/recover-client', pageReadback, 2000), /Target schematic page is absent/);
    await assert.rejects(pageMutationServer.request('/bridge/jlceda/schematic/pages-manage', {
      operation: 'rename', schematicPageUuid: 'target-page', newName: 'again', confirm: true,
    }, 2000), /writes are blocked pending recovery readback/);
    includeTargetPage = true;
    const verifiedInventory = await pageMutationServer.request('/bridge/admin/recover-client', pageReadback, 2000);
    assert.equal(verifiedInventory.readbackVerified, true);
    assert.equal(verifiedInventory.readback.pageCount, 2);
    const uncertainPcbCopy = await pageMutationServer.request('/bridge/jlceda/pcb/documents-manage', {
      operation: 'copy', projectUuid: 'target-project', pcbUuid: 'source-pcb', confirm: true,
    }, 2000);
    assert.equal(uncertainPcbCopy.commitUnknown, true);
    const pcbCopyDiagnostic = (await pageMutationServer.request('/bridge/admin/clients', {}, 2000)).clients
      .find(client => client.clientId === 'page-mutation-fresh').quarantine.diagnostics[0];
    assert.equal(pcbCopyDiagnostic.targetPcbUuid, 'copy-pcb');
    assert.throws(() => pageMutationServer.validateCompletePcbDocuments({ ...pcbInventory, pcbCount: 1, pcbs: pcbInventory.pcbs.slice(0, 1) },
      pcbCopyDiagnostic), /Target PCB is absent/);
  } finally {
    pageMutationOld?.socket.close();
    pageMutationFresh?.socket.close();
    pageMutationServer.close();
  }

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
  const disconnectedTaskStarted = waitForMessage(mcpSocket, message => message.type === 'bridge/task-started' && message.requestId === 'disconnected-mcp-request');
  mcpSocket.send(JSON.stringify({
    type: 'bridge/task',
    requestId: 'disconnected-mcp-request',
    path: '/bridge/jlceda/api/invoke',
    payload: {},
    timeoutMs: 300,
  }));
  await waitUntil(() => receivedDisconnectedTask);
  await disconnectedTaskStarted;
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
    await disconnectServer.request('/bridge/jlceda/context', {}, 2000),
    { source: 'disconnect-replacement', path: '/bridge/jlceda/context' },
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
    disconnectServer.request('/bridge/jlceda/context', {}, 2000),
    /quarantined after reconnect/,
  );
  await new Promise((resolve) => setTimeout(resolve, 350));
  await assert.rejects(disconnectServer.request('/bridge/jlceda/api/invoke', {}, 2000), /writes are blocked pending recovery readback/);
  assert.deepEqual(
    await disconnectServer.request('/bridge/jlceda/context', {}, 2000),
    { source: 'disconnect-reconnected', path: '/bridge/jlceda/context' },
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
    return snapshot.clients.every(client => !client.ready);
  });
  const lostEdaDiagnostic = (await edaFirstServer.request('/bridge/admin/clients', {}, 2000)).clients[0].quarantine.diagnostics[0];
  assert.equal(lostEdaDiagnostic.mutating, true);
  assert.equal(lostEdaDiagnostic.uncertaintyReason, 'Active EDA client disconnected');
  edaFirstNew = await registerEda(
    `ws://127.0.0.1:${edaFirstPort}/bridge/ws${tokenQuery}`,
    'eda-first-page',
  );
  attachTaskResponder(edaFirstNew.socket, 'eda-first-page', (message) => ({
    source: 'eda-first-reconnected',
    path: message.path,
  }));
  await assert.rejects(
    edaFirstServer.request('/bridge/jlceda/context', {}, 2000),
    /quarantined after reconnect/,
  );
  await new Promise((resolve) => setTimeout(resolve, 350));
  await assert.rejects(edaFirstServer.request('/bridge/jlceda/api/invoke', {}, 2000), /writes are blocked pending recovery readback/);
  assert.deepEqual(
    await edaFirstServer.request('/bridge/jlceda/context', {}, 2000),
    { source: 'eda-first-reconnected', path: '/bridge/jlceda/context' },
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
    return snapshot.clients.every(client => !client.ready);
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
    queuedDisconnectServer.request('/bridge/jlceda/context', {}, 2000),
    /quarantined after reconnect/,
  );
  await new Promise((resolve) => setTimeout(resolve, 800));
  await assert.rejects(queuedDisconnectServer.request('/bridge/jlceda/api/invoke', {}, 2000), /writes are blocked pending recovery readback/);
  assert.deepEqual(
    await queuedDisconnectServer.request('/bridge/jlceda/context', {}, 2000),
    { source: 'queued-disconnect-reconnected', path: '/bridge/jlceda/context' },
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
    await reconnectServer.request('/bridge/jlceda/context', {}, 2000),
    { source: 'reconnect-target', path: '/bridge/jlceda/context' },
  );
  await reconnectServer.request('/bridge/admin/select-client', { clientId: 'reconnect-page' }, 2000);
  await assert.rejects(
    reconnectServer.request('/bridge/jlceda/context', {}, 2000),
    /quarantined after reconnect/,
  );
  await new Promise((resolve) => setTimeout(resolve, 1050));
  await assert.rejects(reconnectServer.request('/bridge/jlceda/api/invoke', {}, 2000), /writes are blocked pending recovery readback/);
  assert.deepEqual(
    await reconnectServer.request('/bridge/jlceda/context', {}, 2000),
    { source: 'reconnect-page-new', path: '/bridge/jlceda/context' },
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
  const nonHeartbeatTraffic = setInterval(() => {
    if (stale.socket.readyState === WebSocket.OPEN)
      stale.socket.send(JSON.stringify({ type: 'bridge/ready', clientId: 'stale-page', readyAt: Date.now() }));
  }, 50);
  const [staleCloseCode] = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('stale heartbeat peer did not close')), 2000);
    stale.socket.once('close', (...args) => {
      clearTimeout(timeout);
      resolve(args);
    });
  }).finally(() => clearInterval(nonHeartbeatTraffic));
  assert.equal(staleCloseCode, 4000);
  expiryServer.close();
  expiryServer = undefined;

  const livenessPort = await reservePort();
  livenessServer = new EdaBridgeServer(livenessPort, { peerTtlMs: 400, peerSweepIntervalMs: 1000 });
  await livenessServer.start();
  const livenessPeer = await registerEda(`ws://127.0.0.1:${livenessPort}/bridge/ws${tokenQuery}`, 'liveness-page', undefined, false);
  await waitUntil(async () => (await livenessServer.request('/bridge/admin/clients', {}, 2000)).clients[0].ready === true);
  const initialHeartbeat = waitForMessage(livenessPeer.socket, message => message.type === 'bridge/heartbeat-ack');
  livenessPeer.socket.send(JSON.stringify({ type: 'bridge/heartbeat', clientId: 'liveness-page', sentAt: Date.now() }));
  await initialHeartbeat;
  await new Promise(resolve => setTimeout(resolve, 450));
  livenessPeer.socket.send(JSON.stringify({ type: 'bridge/ready', clientId: 'liveness-page', readyAt: Date.now() }));
  await new Promise(resolve => setTimeout(resolve, 10));
  const staleHeartbeat = await livenessServer.request('/bridge/admin/clients', {}, 2000);
  assert.equal(staleHeartbeat.clients[0].ready, false, 'recent non-heartbeat traffic must not make a stale client ready');
  assert(staleHeartbeat.clients[0].lastHeartbeatMsAgo >= 400);
  await assert.rejects(
    livenessServer.request('/bridge/admin/select-client', { clientId: 'liveness-page' }, 2000),
    /not connected and ready/,
  );
  await assert.rejects(livenessServer.request('/bridge/jlceda/context', {}, 2000), /No ready EDA client connected/);
  const freshHeartbeat = waitForMessage(livenessPeer.socket, message => message.type === 'bridge/heartbeat-ack');
  livenessPeer.socket.send(JSON.stringify({ type: 'bridge/heartbeat', clientId: 'liveness-page', sentAt: Date.now() }));
  await freshHeartbeat;
  assert.equal((await livenessServer.request('/bridge/admin/clients', {}, 2000)).clients[0].ready, true);
  livenessPeer.socket.close();
  livenessServer.close();
  livenessServer = undefined;

  const readyPromotionPort = await reservePort();
  const readyPromotionServer = new EdaBridgeServer(readyPromotionPort, { peerTtlMs: 400, peerSweepIntervalMs: 2000 });
  let unreadyPeer;
  let readyPeer;
  let pendingPeer;
  let laterPeer;
  try {
    await readyPromotionServer.start();
    const readyPromotionUrl = `ws://127.0.0.1:${readyPromotionPort}/bridge/ws${tokenQuery}`;
    unreadyPeer = await connect(readyPromotionUrl);
    const firstWelcome = waitForMessage(unreadyPeer, message => message.type === 'bridge/welcome');
    const firstRole = waitForMessage(unreadyPeer, message => message.type === 'bridge/role');
    unreadyPeer.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type === 'bridge/probe')
        unreadyPeer.send(JSON.stringify({ type: 'bridge/probe-ack', clientId: 'unready-first', probeId: message.probeId }));
    });
    unreadyPeer.send(JSON.stringify({ type: 'bridge/hello', clientId: 'unready-first', bridgeVersion: '2.3.2', selectionProbeVersion: 1 }));
    await firstWelcome;
    assert.equal((await firstRole).role, 'active');
    readyPeer = await registerEda(readyPromotionUrl, 'ready-second');
    let pendingTask;
    let pendingTaskStarted;
    const pendingTaskStartedPromise = new Promise(resolve => { pendingTaskStarted = resolve; });
    readyPeer.socket.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type !== 'bridge/task') return;
      readyPeer.socket.send(JSON.stringify({ type: 'bridge/task-started', clientId: 'ready-second', requestId: message.requestId, leaseTerm: message.leaseTerm, startedAt: Date.now() }));
      if (message.path === '/bridge/test/pending-promotion') {
        pendingTask = message;
        pendingTaskStarted();
        return;
      }
      readyPeer.socket.send(JSON.stringify({ type: 'bridge/result', clientId: 'ready-second', requestId: message.requestId, leaseTerm: message.leaseTerm, result: { source: 'ready-second', path: message.path } }));
    });
    assert.equal((await readyPromotionServer.request('/bridge/admin/clients', {}, 2000)).activeClientId, 'ready-second');
    assert.deepEqual(await readyPromotionServer.request('/bridge/jlceda/context', {}, 2000), {
      source: 'ready-second', path: '/bridge/jlceda/context',
    });

    const pendingRequest = readyPromotionServer.request('/bridge/test/pending-promotion', {}, 2000);
    await pendingTaskStartedPromise;
    await new Promise(resolve => setTimeout(resolve, 450));
    pendingPeer = await registerEda(readyPromotionUrl, 'ready-while-pending');
    assert.equal((await readyPromotionServer.request('/bridge/admin/clients', {}, 2000)).activeClientId, 'ready-second',
      'an active request must not be interrupted by automatic promotion');
    readyPeer.socket.send(JSON.stringify({ type: 'bridge/result', clientId: 'ready-second', requestId: pendingTask.requestId, leaseTerm: pendingTask.leaseTerm, result: { completed: true } }));
    assert.deepEqual(await pendingRequest, { completed: true });
    const promotionHeartbeat = waitForMessage(pendingPeer.socket, message => message.type === 'bridge/heartbeat-ack');
    pendingPeer.socket.send(JSON.stringify({ type: 'bridge/heartbeat', clientId: 'ready-while-pending', sentAt: Date.now() }));
    await promotionHeartbeat;
    assert.equal((await readyPromotionServer.request('/bridge/admin/clients', {}, 2000)).activeClientId, 'ready-while-pending');

    unreadyPeer.send(JSON.stringify({ type: 'bridge/ready', clientId: 'unready-first', readyAt: Date.now() }));
    const firstHeartbeat = waitForMessage(unreadyPeer, message => message.type === 'bridge/heartbeat-ack');
    unreadyPeer.send(JSON.stringify({ type: 'bridge/heartbeat', clientId: 'unready-first', sentAt: Date.now() }));
    await firstHeartbeat;
    await readyPromotionServer.request('/bridge/admin/select-client', { clientId: 'unready-first' }, 2000);
    await new Promise(resolve => setTimeout(resolve, 450));
    laterPeer = await registerEda(readyPromotionUrl, 'ready-third');
    assert.equal((await readyPromotionServer.request('/bridge/admin/clients', {}, 2000)).activeClientId, 'unready-first',
      'a manually selected page must not be replaced when its heartbeat becomes stale');
    await readyPromotionServer.request('/bridge/admin/select-client', { clientId: 'ready-third' }, 2000);
  } finally {
    unreadyPeer?.close();
    readyPeer?.socket.close();
    pendingPeer?.socket.close();
    laterPeer?.socket.close();
    readyPromotionServer.close();
  }

  const probePort = await reservePort();
  const probeServer = new EdaBridgeServer(probePort);
  const probeUrl = `ws://127.0.0.1:${probePort}/bridge/ws${tokenQuery}`;
  let probeActive;
  let probeSilent;
  let probeLegacy;
  let probeManual;
  try {
    await probeServer.start();
    probeActive = await registerEda(probeUrl, 'probe-active');
    probeSilent = await registerEda(probeUrl, 'probe-silent', undefined, true, 'silent');
    probeLegacy = await registerEda(probeUrl, 'probe-legacy', undefined, true, 'legacy');
    probeManual = await registerEda(probeUrl, 'probe-manual', undefined, true, 'manual');
    let snapshot = await probeServer.request('/bridge/admin/clients', {}, 2000);
    assert.equal(snapshot.activeClientId, 'probe-active');
    assert.equal(snapshot.clients.find(client => client.clientId === 'probe-silent').selectionProbeSupported, true);
    assert.equal(snapshot.clients.find(client => client.clientId === 'probe-legacy').selectionProbeSupported, false);
    await assert.rejects(probeServer.request('/bridge/admin/select-client', { clientId: 'probe-legacy' }, 2000), /does not support selection probe/);
    await assert.rejects(probeServer.request('/bridge/admin/select-client', { clientId: 'probe-silent', force: true }, 3000), /selection probe timed out/);
    snapshot = await probeServer.request('/bridge/admin/clients', {}, 2000);
    assert.equal(snapshot.activeClientId, 'probe-active', 'failed probe must leave the previous active client selected');
    const leaseBefore = snapshot.leaseTerm;
    const manualProbe = waitForMessage(probeManual.socket, message => message.type === 'bridge/probe');
    const selecting = probeServer.request('/bridge/admin/select-client', { clientId: 'probe-manual' }, 3000);
    const challenge = await manualProbe;
    assert.equal((await probeServer.request('/bridge/admin/clients', {}, 2000)).leaseTerm, leaseBefore,
      'the lease must not change until the target acknowledges the challenge');
    probeActive.socket.send(JSON.stringify({ type: 'bridge/probe-ack', clientId: 'probe-active', probeId: challenge.probeId }));
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal((await probeServer.request('/bridge/admin/clients', {}, 2000)).activeClientId, 'probe-active',
      'an acknowledgement from another socket cannot select the target');
    probeManual.socket.send(JSON.stringify({ type: 'bridge/probe-ack', clientId: 'probe-manual', probeId: challenge.probeId }));
    assert.equal((await selecting).activeClientId, 'probe-manual');
  } finally {
    probeActive?.socket.close();
    probeSilent?.socket.close();
    probeLegacy?.socket.close();
    probeManual?.socket.close();
    probeServer.close();
  }

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
  connectivityClient?.socket.close();
  stuck?.socket.close();
  replacement?.socket.close();
  wrongRecoveryPage?.socket.close();
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
  disconnectedRecoveryOld?.socket.close();
  disconnectedRecoveryTarget?.socket.close();
  disconnectedRecoveryFresh?.socket.close();
  nativeLayoutOld?.socket.close();
  nativeLayoutNew?.socket.close();
  lateUnknownClient?.socket.close();
  lateConnectivityActive?.socket.close();
  lateConnectivityStandby?.socket.close();
  unverifiedWriteActive?.socket.close();
  unverifiedWriteStandby?.socket.close();
  expiryServer?.close();
  livenessServer?.close();
  queueServer?.close();
  connectivityServer?.close();
  recoveryServer?.close();
  disconnectServer?.close();
  edaFirstServer?.close();
  queuedDisconnectServer?.close();
  reconnectServer?.close();
  disconnectedRecoveryServer?.close();
  nativeLayoutServer?.close();
  lateUnknownServer?.close();
  lateConnectivityServer?.close();
  unverifiedWriteServer?.close();
  secondaryServer.close();
  mainServer.close();
  if (originalToken === undefined) {
    delete process.env.JLCEDA_BRIDGE_TOKEN;
  } else {
    process.env.JLCEDA_BRIDGE_TOKEN = originalToken;
  }
}
