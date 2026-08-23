import assert from 'node:assert/strict';
import { formatInternalClientEndpoint } from '../dist/mcp/bridge-client.js';
import { ToolDispatcher } from '../dist/mcp/tool-dispatcher.js';

const calls = [];
const fakeBridge = {
  async request(path, payload, timeoutMs) {
    calls.push({ path, payload, timeoutMs });
    if (path === '/bridge/jlceda/component/place') {
      return {
        ok: true,
        placement: {
          components: [{ uuid: 'device-1', libraryUuid: 'library-1', name: 'R1' }],
          timeoutSeconds: 30,
          retryCount: 1,
        },
      };
    }
    if (path === '/bridge/jlceda/component/place/start') {
      return { ok: true, sessionId: 'session-1' };
    }
    if (path === '/bridge/jlceda/component/place/check') {
      return { ok: true, placed: true, userCancelled: false };
    }
    if (path === '/bridge/jlceda/component/place/close') {
      return { ok: true };
    }
    if (path === '/bridge/jlceda/api/invoke') {
      return { ok: true };
    }
    if (path === '/bridge/jlceda/canvas/snapshot') {
      return {
        ok: true,
        image: {
          type: 'image/png',
          encoding: 'base64',
          dataBase64: 'iVBORw0KGgoAAAANSUhEUg==',
          width: 640,
          height: 480,
          byteLength: 16,
        },
      };
    }
    throw new Error(`Unexpected path: ${path}`);
  },
};

const dispatcher = new ToolDispatcher(fakeBridge);
const result = await dispatcher.dispatch({
  name: 'component_place',
  arguments: {
    components: [{ uuid: 'device-1', libraryUuid: 'library-1', name: 'R1' }],
  },
});

assert.equal(result.structuredContent.ok, true);
assert.equal(result.structuredContent.placedCount, 1);
assert.deepEqual(calls.map((call) => call.path), [
  '/bridge/jlceda/component/place',
  '/bridge/jlceda/component/place/start',
  '/bridge/jlceda/component/place/check',
  '/bridge/jlceda/component/place/close',
]);

const endpoint = formatInternalClientEndpoint(8765);
assert.equal(endpoint, 'ws://127.0.0.1:8765/mcp-internal');
assert.equal(endpoint.includes('token='), false);

const invokeResult = await dispatcher.dispatch({
  name: 'api_invoke',
  arguments: {
    apiFullName: 'eda.sch_Drc.check',
    timeoutMs: 42000,
  },
});
assert.equal(invokeResult.structuredContent.ok, true);
const invokeCall = calls.find(call => call.path === '/bridge/jlceda/api/invoke');
assert.equal(invokeCall.timeoutMs, 44000);

const snapshotResult = await dispatcher.dispatch({
  name: 'eda_canvas_snapshot',
  arguments: {},
});
assert.equal(snapshotResult.content.length, 2);
assert.deepEqual(snapshotResult.content[0], {
  type: 'image',
  data: 'iVBORw0KGgoAAAANSUhEUg==',
  mimeType: 'image/png',
});
assert.equal(snapshotResult.content[1].type, 'text');
assert.deepEqual(JSON.parse(snapshotResult.content[1].text), {
  ok: true,
  image: {
    type: 'image/png',
    encoding: 'base64',
    width: 640,
    height: 480,
    byteLength: 16,
  },
});
assert.deepEqual(snapshotResult.structuredContent, {
  ok: true,
  image: {
    type: 'image/png',
    encoding: 'base64',
    dataBase64: 'iVBORw0KGgoAAAANSUhEUg==',
    width: 640,
    height: 480,
    byteLength: 16,
  },
});

await assert.rejects(
  dispatcher.dispatch({
    name: 'api_invoke',
    arguments: {
      apiFullName: 'eda.sch_Drc.check',
      timeoutMs: 999,
    },
  }),
  /timeoutMs must be an integer between 1000 and 120000/,
);

process.stdout.write('Tool dispatcher orchestration and log redaction tests passed\n');
