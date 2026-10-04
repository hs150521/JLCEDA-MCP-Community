import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { WebSocket } from 'ws';
import { EdaBridgeServer, normalizeBridgeTaskError } from '../dist/mcp/bridge-client.js';
import { ToolDispatcher } from '../dist/mcp/tool-dispatcher.js';

const nativeError = { code: 'UPDATE_REJECTED', reason: 'invalid source', field: 'format', source: 'private source' };
assert.deepEqual(normalizeBridgeTaskError(nativeError), { message: 'invalid source', code: 'UPDATE_REJECTED', reason: 'invalid source', field: 'format' });
assert.match(normalizeBridgeTaskError({ source: 'private source' }).message, /object error without a message/);

const reservation = createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const originalToken = process.env.JLCEDA_BRIDGE_TOKEN;
process.env.JLCEDA_BRIDGE_TOKEN = 'diagnostic-test-token';
const main = new EdaBridgeServer(port);
const secondary = new EdaBridgeServer(port);
let eda;
let nativeMessage = '[object Object]';
try {
  await main.start();
  await secondary.start();
  eda = new WebSocket(`ws://127.0.0.1:${port}/bridge/ws?token=diagnostic-test-token`);
  await new Promise((resolve, reject) => { eda.once('open', resolve); eda.once('error', reject); });
  const welcome = new Promise(resolve => eda.on('message', data => {
    const message = JSON.parse(data.toString());
    if (message.type === 'bridge/welcome') resolve();
    if (message.type === 'bridge/task') eda.send(JSON.stringify({
      type: 'bridge/result', clientId: 'diagnostic-client', requestId: message.requestId, leaseTerm: message.leaseTerm,
      error: { ...nativeError, message: nativeMessage, status: 422 },
    }));
  }));
  eda.send(JSON.stringify({ type: 'bridge/hello', clientId: 'diagnostic-client', bridgeVersion: '2.3.4' }));
  await welcome;
  eda.send(JSON.stringify({ type: 'bridge/ready', clientId: 'diagnostic-client', readyAt: Date.now() }));
  const deadline = Date.now() + 3000;
  while (!(await main.request('/bridge/admin/clients', {}, 1000)).clients.some(client => client.ready)) {
    assert.ok(Date.now() < deadline);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const payload = { apiFullName: 'eda.lib_Footprint.updateDocumentSource', args: ['footprint', 'project', 'source'] };
  for (const server of [main, secondary]) {
    await assert.rejects(server.request('/bridge/jlceda/api/invoke', payload, 2000), error => {
      assert.equal(error.code, 'UPDATE_REJECTED');
      assert.equal(error.message, 'invalid source');
      assert.equal(error.reason, 'invalid source');
      assert.equal(error.field, 'format');
      assert.equal(error.source, undefined);
      return true;
    });
  }
  await assert.rejects(new ToolDispatcher(secondary).dispatch({ name: 'api_invoke', arguments: payload }), /\[UPDATE_REJECTED\] invalid source/);
  nativeMessage = 'Native API call failed';
  for (const server of [main, secondary]) {
    await assert.rejects(server.request('/bridge/jlceda/api/invoke', payload, 2000), error => {
      assert.equal(error.message, nativeMessage);
      assert.equal(error.reason, 'invalid source');
      assert.equal(error.field, 'format');
      assert.equal(error.status, 422);
      return true;
    });
  }
  await assert.rejects(new ToolDispatcher(secondary).dispatch({ name: 'api_invoke', arguments: payload }), error => {
    assert.equal(error.code, 'UPDATE_REJECTED');
    assert.equal(error.reason, 'invalid source');
    assert.equal(error.field, 'format');
    assert.equal(error.status, 422);
    assert.match(error.message, /Native API call failed.*reason: invalid source.*field: format.*status: 422/);
    assert.equal(error.source, undefined);
    assert.equal(error.message.includes('private source'), false);
    return true;
  });
  console.log('Bridge error diagnostics survive direct, internal relay and tool dispatch paths');
} finally {
  eda?.close();
  secondary.close();
  main.close();
  if (originalToken === undefined) delete process.env.JLCEDA_BRIDGE_TOKEN;
  else process.env.JLCEDA_BRIDGE_TOKEN = originalToken;
}
