import assert from 'node:assert/strict';
import { formatInternalClientEndpoint } from '../dist/mcp/bridge-client.js';
import { ToolDispatcher } from '../dist/mcp/tool-dispatcher.js';

const calls = [];
const fakeBridge = {
  async request(path, payload) {
    calls.push({ path, payload });
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

process.stdout.write('Tool dispatcher orchestration and log redaction tests passed\n');
