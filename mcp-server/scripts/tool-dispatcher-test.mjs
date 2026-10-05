import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { formatInternalClientEndpoint } from '../dist/mcp/bridge-client.js';
import { ToolDispatcher } from '../dist/mcp/tool-dispatcher.js';
import { bridgePathForTool, bridgeTimeoutForTool, isReadOnlyBridgeRequest } from '../dist/mcp/bridge-contract.js';

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
      assert.equal(timeoutMs, undefined, 'placement check must use the Bridge server default budget for the 25s contract route');
      return { ok: true, placed: true, primitiveIds: ['placed-1'], designatorChanges: [{ primitiveId: 'old', before: 'U4', after: 'U15' }], annotationWarning: 'Designators changed', userCancelled: false };
    }
    if (path === '/bridge/jlceda/component/place/close') {
      return { ok: true };
    }
	if (path === '/bridge/jlceda/api/invoke' || path === '/bridge/jlceda/library/sources' || path === '/bridge/jlceda/workspace/query' || path === '/bridge/jlceda/design/source-export' || path === '/bridge/jlceda/net/query-pcb' || path === '/bridge/jlceda/pcb/constraints-manage' || path === '/bridge/jlceda/schematic/pages-manage') {
	  return { ok: true };
	}
	if (path === '/bridge/jlceda/library/preview') {
	  return { ok: true, kind: 'symbol', uuid: 'symbol-1', libraryUuid: 'library-1', image: { kind: 'file', type: 'image/png', size: 4, dataBase64: 'AAAA', encoding: 'base64' } };
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
    if (path.startsWith('/bridge/jlceda/')) {
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

assert.equal(result.structuredContent.ok, false);
assert.equal(result.structuredContent.placedCount, 1);
assert.deepEqual(result.structuredContent.results[0].primitiveIds, ['placed-1']);
assert.equal(result.structuredContent.results[0].annotationWarning, 'Designators changed');
assert.deepEqual(calls.map((call) => call.path), [
  '/bridge/jlceda/component/place',
  '/bridge/jlceda/component/place/start',
  '/bridge/jlceda/component/place/check',
  '/bridge/jlceda/component/place/close',
]);

const duplicateCalls = [];
const duplicateBridge = {
  async request(path) {
    duplicateCalls.push(path);
    if (path === '/bridge/jlceda/component/place') {
      return { placement: { components: [{ uuid: 'one' }, { uuid: 'two' }], timeoutSeconds: 30, retryCount: 3 } };
    }
    if (path.endsWith('/start')) return { ok: true, sessionId: 'duplicate-session' };
    if (path.endsWith('/check')) return { ok: true, placed: false, duplicate: true, primitiveIds: ['a', 'b'] };
    if (path.endsWith('/close')) return { ok: true };
    throw new Error(`Unexpected path: ${path}`);
  },
};
const duplicateResult = await new ToolDispatcher(duplicateBridge).dispatch({ name: 'component_place', arguments: { components: [] } });
assert.equal(duplicateResult.structuredContent.ok, false);
assert.equal(duplicateResult.structuredContent.notAttemptedCount, 1);
assert.deepEqual(duplicateResult.structuredContent.results[0].primitiveIds, ['a', 'b']);
assert.deepEqual(duplicateCalls, [
  '/bridge/jlceda/component/place',
  '/bridge/jlceda/component/place/start',
  '/bridge/jlceda/component/place/check',
  '/bridge/jlceda/component/place/close',
]);
assert.equal(calls.find(call => call.path === '/bridge/jlceda/component/place/start').payload.timeoutSeconds, 30,
  'the overall placement window must still be passed to the Bridge session');
await dispatcher.dispatch({ name: 'component_place_auto', arguments: { components: [{ uuid: 'one' }] } });
assert.equal(calls.at(-1).timeoutMs, 302000, 'coordinate batches need a longer Bridge execution budget');
await dispatcher.dispatch({ name: 'netlabel_place', arguments: { placements: [{ componentId: 'one' }], timeoutMs: 420000 } });
assert.equal(calls.at(-1).timeoutMs, 422000, 'label batches must pass the override with transport grace');
await dispatcher.dispatch({ name: 'schematic_component_edit', arguments: { action: 'read' } });
assert.equal(calls.at(-1).path, '/bridge/jlceda/schematic/component-edit');
assert.deepEqual(calls.at(-1).payload, { action: 'read' });
assert.equal(calls.at(-1).timeoutMs, bridgeTimeoutForTool('schematic_component_edit', { action: 'read' }) + 2000);
assert.equal(calls.at(-1).timeoutMs, 32000);
await dispatcher.dispatch({ name: 'schematic_component_edit', arguments: { action: 'modify', primitiveId: 'r1', property: { x: 10 }, timeoutMs: 90000 } });
assert.equal(calls.at(-1).timeoutMs, 92000, 'large schematic moves may extend the semantic readback budget');
assert.equal(bridgePathForTool('schematic_component_edit'), '/bridge/jlceda/schematic/component-edit');
assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/schematic/component-edit', { action: 'read' }), true);
assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/schematic/component-edit', { action: 'modify' }), false);
assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/schematic/component-edit', { action: 'delete' }), false);
await dispatcher.dispatch({ name: 'schematic_wire_manage', arguments: { action: 'read' } });
assert.equal(calls.at(-1).path, '/bridge/jlceda/schematic/wire-manage');
assert.deepEqual(calls.at(-1).payload, { action: 'read' });
assert.equal(bridgePathForTool('schematic_wire_manage'), '/bridge/jlceda/schematic/wire-manage');
assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/schematic/wire-manage', { action: 'read' }), true);
for (const action of ['modify', 'delete'])
  assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/schematic/wire-manage', { action }), false);
await dispatcher.dispatch({ name: 'schematic_text_manage', arguments: { action: 'read' } });
assert.equal(calls.at(-1).path, '/bridge/jlceda/schematic/text-manage');
assert.deepEqual(calls.at(-1).payload, { action: 'read' });
assert.equal(calls.at(-1).timeoutMs, bridgeTimeoutForTool('schematic_text_manage', { action: 'read' }) + 2000);
assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/schematic/text-manage', { action: 'read' }), true);
for (const action of ['create', 'modify', 'delete'])
  assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/schematic/text-manage', { action }), false);
await dispatcher.dispatch({ name: 'pcb_component_edit', arguments: { action: 'read' } });
assert.equal(calls.at(-1).path, '/bridge/jlceda/pcb/component-edit');
assert.deepEqual(calls.at(-1).payload, { action: 'read' });
assert.equal(calls.at(-1).timeoutMs, bridgeTimeoutForTool('pcb_component_edit', { action: 'read' }) + 2000);
assert.equal(bridgePathForTool('pcb_component_edit'), '/bridge/jlceda/pcb/component-edit');
assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/pcb/component-edit', { action: 'read' }), true);
for (const action of ['create', 'modify', 'delete'])
  assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/pcb/component-edit', { action }), false);
await dispatcher.dispatch({ name: 'pcb_pour_manage', arguments: { action: 'read' } });
assert.equal(calls.at(-1).path, '/bridge/jlceda/pcb/pour-manage');
assert.deepEqual(calls.at(-1).payload, { action: 'read' });
assert.equal(calls.at(-1).timeoutMs, bridgeTimeoutForTool('pcb_pour_manage', { action: 'read' }) + 2000);
assert.equal(bridgePathForTool('pcb_pour_manage'), '/bridge/jlceda/pcb/pour-manage');
assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/pcb/pour-manage', { action: 'read' }), true);
for (const action of ['create', 'modify', 'delete', 'rebuild'])
  assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/pcb/pour-manage', { action }), false);
await dispatcher.dispatch({ name: 'pcb_routing_edit', arguments: { action: 'read' } });
assert.equal(calls.at(-1).path, '/bridge/jlceda/pcb/routing-edit');
assert.deepEqual(calls.at(-1).payload, { action: 'read' });
assert.equal(calls.at(-1).timeoutMs, bridgeTimeoutForTool('pcb_routing_edit', { action: 'read' }) + 2000);
assert.equal(bridgePathForTool('pcb_routing_edit'), '/bridge/jlceda/pcb/routing-edit');
assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/pcb/routing-edit', { action: 'read' }), true);
for (const action of ['create', 'modify', 'delete'])
  assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/pcb/routing-edit', { action }), false);
await dispatcher.dispatch({ name: 'pcb_board_outline_manage', arguments: { action: 'read' } });
assert.equal(calls.at(-1).path, '/bridge/jlceda/pcb/board-outline-manage');
assert.deepEqual(calls.at(-1).payload, { action: 'read' });
assert.equal(calls.at(-1).timeoutMs, bridgeTimeoutForTool('pcb_board_outline_manage', { action: 'read' }) + 2000);
assert.equal(bridgePathForTool('pcb_board_outline_manage'), '/bridge/jlceda/pcb/board-outline-manage');
assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/pcb/board-outline-manage', { action: 'read' }), true);
for (const action of ['create', 'modify', 'delete'])
  assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/pcb/board-outline-manage', { action }), false);
await dispatcher.dispatch({ name: 'pcb_region_manage', arguments: { action: 'read' } });
assert.equal(calls.at(-1).path, '/bridge/jlceda/pcb/region-manage');
assert.deepEqual(calls.at(-1).payload, { action: 'read' });
assert.equal(calls.at(-1).timeoutMs, bridgeTimeoutForTool('pcb_region_manage', { action: 'read' }) + 2000);
assert.equal(bridgePathForTool('pcb_region_manage'), '/bridge/jlceda/pcb/region-manage');
assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/pcb/region-manage', { action: 'read' }), true);
for (const action of ['create', 'modify', 'delete'])
  assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/pcb/region-manage', { action }), false);
await dispatcher.dispatch({ name: 'pcb_text_manage', arguments: { action: 'read' } });
assert.equal(calls.at(-1).path, '/bridge/jlceda/pcb/text-manage');
assert.deepEqual(calls.at(-1).payload, { action: 'read' });
assert.equal(calls.at(-1).timeoutMs, bridgeTimeoutForTool('pcb_text_manage', { action: 'read' }) + 2000);
assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/pcb/text-manage', { action: 'read' }), true);
for (const action of ['create', 'modify', 'delete'])
  assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/pcb/text-manage', { action }), false);
await dispatcher.dispatch({ name: 'pcb_layer_manage', arguments: { action: 'read' } });
assert.equal(calls.at(-1).path, '/bridge/jlceda/pcb/layer-manage');
assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/pcb/layer-manage', { action: 'read' }), true);
assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/pcb/layer-manage', { action: 'set', confirm: true, copperLayerCount: 4 }), false);
assert.equal(bridgeTimeoutForTool('pcb_layer_manage', { action: 'set', confirm: true, copperLayerCount: 4, timeoutMs: 120000 }), 120000);

const uncertainCleanupBridge = {
  async request(path) {
    if (path === '/bridge/jlceda/component/place')
      return { placement: { components: [{ uuid: 'one' }], timeoutSeconds: 30 } };
    if (path.endsWith('/start')) return { ok: true, sessionId: 'cleanup-session' };
    if (path.endsWith('/check')) return { ok: false, commitUnknown: true, readbackRequired: true, nativeCallSettled: false, primitiveIds: ['a', 'b'], designatorChanges: [{ primitiveId: 'old-u', before: 'U4', after: 'U15' }], restoredDesignators: [{ primitiveId: 'old-r', before: 'R8', after: 'R1' }], annotationWarning: 'Designators need review', error: 'duplicate cleanup readback failed' };
    if (path.endsWith('/close')) return { ok: true };
    throw new Error(`Unexpected path: ${path}`);
  },
};
const uncertainCleanupResult = await new ToolDispatcher(uncertainCleanupBridge).dispatch({ name: 'component_place', arguments: { components: [] } });
assert.equal(uncertainCleanupResult.structuredContent.ok, false);
assert.equal(uncertainCleanupResult.structuredContent.results[0].commitUnknown, true);
assert.equal(uncertainCleanupResult.structuredContent.results[0].readbackRequired, true);
assert.equal(uncertainCleanupResult.structuredContent.results[0].nativeCallSettled, false);
assert.deepEqual(uncertainCleanupResult.structuredContent.results[0].primitiveIds, ['a', 'b']);
assert.deepEqual(uncertainCleanupResult.structuredContent.results[0].designatorChanges, [{ primitiveId: 'old-u', before: 'U4', after: 'U15' }]);
assert.deepEqual(uncertainCleanupResult.structuredContent.results[0].restoredDesignators, [{ primitiveId: 'old-r', before: 'R8', after: 'R1' }]);
assert.equal(uncertainCleanupResult.structuredContent.results[0].annotationWarning, 'Designators need review');
assert.match(uncertainCleanupResult.structuredContent.results[0].error, /cleanup readback failed/);

const uncertainStartBridge = {
  async request(path) {
    if (path === '/bridge/jlceda/component/place')
      return { placement: { components: [{ uuid: 'one' }], timeoutSeconds: 30 } };
    if (path.endsWith('/start'))
      return { ok: false, commitUnknown: true, readbackRequired: true, nativeCallSettled: false, error: 'RPC Call Timed Out' };
    throw new Error(`Unexpected path: ${path}`);
  },
};
const uncertainStartResult = await new ToolDispatcher(uncertainStartBridge).dispatch({ name: 'component_place', arguments: { components: [] } });
assert.equal(uncertainStartResult.structuredContent.ok, false);
assert.equal(uncertainStartResult.structuredContent.results[0].commitUnknown, true);
assert.equal(uncertainStartResult.structuredContent.results[0].readbackRequired, true);
assert.equal(uncertainStartResult.structuredContent.results[0].nativeCallSettled, false);

const batchCalls = [];
let startedCount = 0;
let firstCheckCount = 0;
const batchBridge = {
  async request(path, payload) {
    batchCalls.push(path);
    if (path === '/bridge/jlceda/component/place') {
      return { placement: { components: [{ uuid: 'first' }, { uuid: 'second' }], timeoutSeconds: 30 } };
    }
    if (path.endsWith('/start')) return { ok: true, sessionId: `session-${++startedCount}` };
    if (path.endsWith('/check') && payload.sessionId === 'session-1') {
      firstCheckCount += 1;
      return firstCheckCount === 1
        ? { ok: true, placed: false, awaitingExit: true, candidatePrimitiveIds: ['floating-id'], userCancelled: false }
        : { ok: true, placed: true, primitiveIds: ['first-id'], removedDuplicateIds: ['first-extra'], restoredDesignators: [{ primitiveId: 'old-u', before: 'U15', after: 'U4' }], userCancelled: false };
    }
    if (path.endsWith('/check')) return { ok: true, placed: true, primitiveIds: ['second-id'], userCancelled: false };
    if (path.endsWith('/close')) return { ok: true };
    throw new Error(`Unexpected path: ${path}`);
  },
};
const batchResult = await new ToolDispatcher(batchBridge).dispatch({ name: 'component_place', arguments: { components: [] } });
assert.equal(batchResult.structuredContent.ok, true);
assert.deepEqual(batchResult.structuredContent.results.map((item) => item.primitiveIds), [['first-id'], ['second-id']]);
assert.deepEqual(batchResult.structuredContent.results[0].removedDuplicateIds, ['first-extra']);
assert.deepEqual(batchResult.structuredContent.results[0].restoredDesignators, [{ primitiveId: 'old-u', before: 'U15', after: 'U4' }]);
assert.equal(batchResult.structuredContent.results[0].candidatePrimitiveIds, undefined);
assert.deepEqual(batchCalls, [
  '/bridge/jlceda/component/place',
  '/bridge/jlceda/component/place/start',
  '/bridge/jlceda/component/place/check',
  '/bridge/jlceda/component/place/check',
  '/bridge/jlceda/component/place/close',
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

const snapshotTimeoutResult = await dispatcher.dispatch({
  name: 'eda_canvas_snapshot',
  arguments: { timeoutMs: 42000 },
});
assert.equal(snapshotTimeoutResult.structuredContent.ok, true);
const snapshotCall = calls.find(call => call.path === '/bridge/jlceda/canvas/snapshot');
assert.equal(snapshotCall.timeoutMs, 44000);

const sourcesResult = await dispatcher.dispatch({
  name: 'library_sources',
  arguments: { timeoutMs: 42000 },
});
assert.equal(sourcesResult.structuredContent.ok, true);
const sourcesCall = calls.find(call => call.path === '/bridge/jlceda/library/sources');
assert.equal(sourcesCall.timeoutMs, 44000);

const workspaceResult = await dispatcher.dispatch({
  name: 'workspace_query',
  arguments: { timeoutMs: 42000 },
});
assert.equal(workspaceResult.structuredContent.ok, true);
const workspaceCall = calls.find(call => call.path === '/bridge/jlceda/workspace/query');
assert.equal(workspaceCall.timeoutMs, 44000);

const sourceExportResult = await dispatcher.dispatch({
  name: 'design_source_export',
  arguments: { timeoutMs: 42000 },
});
assert.equal(sourceExportResult.structuredContent.ok, true);
const sourceExportCall = calls.find(call => call.path === '/bridge/jlceda/design/source-export');
assert.equal(sourceExportCall.timeoutMs, 44000);

const pcbNetQueryResult = await dispatcher.dispatch({
  name: 'pcb_net_query',
  arguments: { query: 'USB_D+', mode: 'exact', timeoutMs: 42000 },
});
assert.equal(pcbNetQueryResult.structuredContent.ok, true);
const pcbNetQueryCall = calls.find(call => call.path === '/bridge/jlceda/net/query-pcb');
assert.equal(pcbNetQueryCall.timeoutMs, 44000);

const pcbConnectivityPayload = { action: 'line_create', net: 'VCC', layer: 1,
  startX: 0, startY: 0, endX: 10, endY: 0, lineWidth: 0.2, timeoutMs: 42000 };
const pcbConnectivityResult = await dispatcher.dispatch({ name: 'pcb_connectivity_action', arguments: pcbConnectivityPayload });
assert.equal(pcbConnectivityResult.structuredContent.ok, true);
const pcbConnectivityCall = calls.find(call => call.path === '/bridge/jlceda/pcb/connectivity');
assert.deepEqual(pcbConnectivityCall.payload, pcbConnectivityPayload);
assert.equal(pcbConnectivityCall.timeoutMs, 44000);

for (const [name, timeoutMs] of [
  ['pcb_drc_check', 62_000],
  ['schematic_drc_check', 62_000],
  ['netlist_compare', 62_000],
  ['design_compare', 62_000],
  ['design_archive_export', 62_000],
  ['manufacture_export', 62_000],
  ['pcb_document_action', 62_000],
  ['pcb_connectivity_action', 32_000],
  ['schematic_document_action', 62_000],
  ['pcb_net_query', 62_000],
  ['design_source_export', 32_000],
  ['eda_canvas_snapshot', 32_000],
  ['library_sources', 32_000],
  ['library_classification_query', 32_000],
  ['library_preview', 32_000],
  ['workspace_query', 32_000],
  ['api_invoke', 17_000],
  ['eda_context', 17_000],
  ['component_select', 27_000],
]) {
  const callCount = calls.length;
  await dispatcher.dispatch({ name, arguments: {} });
  assert.equal(calls.length, callCount + 1, `${name} should dispatch exactly once`);
  assert.equal(calls.at(-1).timeoutMs, timeoutMs, `${name} should use its bridge default timeout plus transport grace`);
}

const constraintsManageResult = await dispatcher.dispatch({
	name: 'pcb_constraints_manage',
	arguments: { kind: 'net_class', operation: 'delete', name: 'obsolete', confirm: true },
});
assert.equal(constraintsManageResult.structuredContent.ok, true);
const constraintsManageCall = calls.find(call => call.path === '/bridge/jlceda/pcb/constraints-manage');
assert.equal(constraintsManageCall.payload.confirm, true);

const schematicPagesManageResult = await dispatcher.dispatch({
	name: 'schematic_pages_manage',
	arguments: { operation: 'reorder', schematicUuid: 'sch-1', orderedPageUuids: ['page-2', 'page-1'], confirm: true },
});
assert.equal(schematicPagesManageResult.structuredContent.ok, true);
const schematicPagesManageCall = calls.find(call => call.path === '/bridge/jlceda/schematic/pages-manage');
assert.deepEqual(schematicPagesManageCall.payload.orderedPageUuids, ['page-2', 'page-1']);

const boardSetupResult = await dispatcher.dispatch({
	name: 'board_setup',
	arguments: { projectUuid: 'project-1', schematicUuid: 'schematic-1', confirm: true },
});
assert.equal(boardSetupResult.structuredContent.ok, true);
const boardSetupCall = calls.find(call => call.path === '/bridge/jlceda/board/setup');
assert.deepEqual(boardSetupCall.payload, { projectUuid: 'project-1', schematicUuid: 'schematic-1', confirm: true });

const libraryPreviewResult = await dispatcher.dispatch({
  name: 'library_preview',
  arguments: { kind: 'symbol', uuid: 'symbol-1', libraryUuid: 'library-1', timeoutMs: 42000 },
});
assert.deepEqual(libraryPreviewResult.content[0], { type: 'image', data: 'AAAA', mimeType: 'image/png' });
assert.equal(libraryPreviewResult.structuredContent.image.dataBase64, undefined);
const libraryPreviewCall = calls.findLast(call => call.path === '/bridge/jlceda/library/preview');
assert.equal(libraryPreviewCall.timeoutMs, 44000);

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
		 width: 640,
    height: 480,
    byteLength: 16,
  },
});

const definitions = JSON.parse(readFileSync(new URL('../dist/resources/mcp-tool-definitions.json', import.meta.url), 'utf8'));

function assertStrictParentDeclaresBranchProperties(schema, path) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return;
  }

  if (schema.additionalProperties === false) {
    const parentProperties = new Set(Object.keys(schema.properties ?? {}));
    for (const keyword of ['oneOf', 'anyOf']) {
      for (const [index, branch] of (schema[keyword] ?? []).entries()) {
        if (!branch || typeof branch !== 'object' || Array.isArray(branch)) {
          continue;
        }
        for (const property of Object.keys(branch.properties ?? {})) {
          assert.ok(
            parentProperties.has(property),
            `${path}.${keyword}[${index}].properties.${property} must also be declared by its strict parent`,
          );
        }
      }
    }
  }

  for (const [key, value] of Object.entries(schema)) {
    if (key === '$ref' || typeof value !== 'object' || value === null) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const [index, child] of value.entries()) {
        assertStrictParentDeclaresBranchProperties(child, `${path}.${key}[${index}]`);
      }
      continue;
    }
    assertStrictParentDeclaresBranchProperties(value, `${path}.${key}`);
  }
}

for (const definition of definitions) {
  assertStrictParentDeclaresBranchProperties(definition.inputSchema, `tool:${definition.name}.inputSchema`);
}

const footprintDefinition = definitions.find((definition) => definition.name === 'footprint_read');
assert.ok(footprintDefinition);
const footprintSchema = z.fromJSONSchema(footprintDefinition.inputSchema);
assert.equal(footprintSchema.safeParse({}).success, true);
assert.equal(footprintSchema.safeParse({ timeoutMs: 120000 }).success, true);
assert.equal(footprintSchema.safeParse({ sections: ['pads'] }).success, false);
await dispatcher.dispatch({ name: 'footprint_read', arguments: {} });
assert.deepEqual(calls.at(-1), { path: '/bridge/jlceda/footprint/read', payload: {}, timeoutMs: 62000 });

const workspaceDefinition = definitions.find((definition) => definition.name === 'workspace_query');
assert.ok(workspaceDefinition);
const workspaceSchema = z.fromJSONSchema(workspaceDefinition.inputSchema);
for (const input of [
  {},
  { action: 'teams' },
  { action: 'projects', teamUuid: 'team-1', folderUuid: 'folder-1', workspaceUuid: 'workspace-1' },
  { action: 'folders', teamUuid: 'team-1' },
]) {
  assert.equal(workspaceSchema.safeParse(input).success, true, `workspace_query should accept ${JSON.stringify(input)}`);
}
for (const input of [
  { action: 'teams', folderUuid: 'folder-1' },
  { action: 'current', teamUuid: 'team-1' },
  { action: 'folders' },
  { action: 'folders', teamUuid: 'team-1', workspaceUuid: 'workspace-1' },
]) {
  assert.equal(workspaceSchema.safeParse(input).success, false, `workspace_query should reject ${JSON.stringify(input)}`);
}

const sourceExportDefinition = definitions.find((definition) => definition.name === 'design_source_export');
assert.ok(sourceExportDefinition);
const sourceExportSchema = z.fromJSONSchema(sourceExportDefinition.inputSchema);
assert.equal(sourceExportSchema.safeParse({}).success, true);
assert.equal(sourceExportSchema.safeParse({ action: 'footprints', limit: 1 }).success, true);
assert.equal(sourceExportSchema.safeParse({ action: 'document', limit: 1 }).success, false);

const pcbNetQueryDefinition = definitions.find((definition) => definition.name === 'pcb_net_query');
assert.ok(pcbNetQueryDefinition);
const pcbNetQuerySchema = z.fromJSONSchema(pcbNetQueryDefinition.inputSchema);
assert.equal(pcbNetQuerySchema.safeParse({ mode: 'all', timeoutMs: 6000 }).success, true);
assert.equal(pcbNetQuerySchema.safeParse({ mode: 'exact', query: 'USB_D+', timeoutMs: 6000 }).success, true);

const pcbConnectivityDefinition = definitions.find((definition) => definition.name === 'pcb_connectivity_action');
assert.ok(pcbConnectivityDefinition);
const pcbConnectivitySchema = z.fromJSONSchema(pcbConnectivityDefinition.inputSchema);
assert.equal(pcbConnectivitySchema.safeParse({ action: 'line_create', net: 'VCC', layer: 1,
  startX: 0, startY: 0, endX: 10, endY: 0, lineWidth: 0.2 }).success, true);
assert.equal(pcbConnectivitySchema.safeParse({ action: 'via_create', net: 'NEW_NET', allowNewNet: true,
  x: 10, y: 0, holeDiameter: 0.3, diameter: 0.6 }).success, true);
assert.equal(pcbConnectivitySchema.safeParse({ action: 'line_create', net: 'VCC', layer: 1,
  startX: 0, startY: 0, endX: 10, endY: 0 }).success, false);
assert.equal(pcbConnectivitySchema.safeParse({ action: 'via_create', net: 'VCC',
  x: 10, y: 0, holeDiameter: 0.3, diameter: 0.6, layer: 1 }).success, false);

const componentSelectDefinition = definitions.find((definition) => definition.name === 'component_select');
assert.ok(componentSelectDefinition);

const schematicComponentEditDefinition = definitions.find((definition) => definition.name === 'schematic_component_edit');
assert.ok(schematicComponentEditDefinition);
const schematicComponentEditSchema = z.fromJSONSchema(schematicComponentEditDefinition.inputSchema);
assert.equal(schematicComponentEditDefinition.inputSchema.$defs.componentProperty.minProperties, 1);
for (const input of [
  { action: 'read' },
  { action: 'modify', primitiveId: 'r1', property: { x: 100, designator: 'R2', otherProperty: { Value: '10k', Price: 2.5, Fitted: true } } },
  { action: 'modify', primitiveId: 'r1', property: { manufacturer: null, addIntoBom: false } },
  { action: 'delete', primitiveId: 'r1' },
]) {
  assert.equal(schematicComponentEditSchema.safeParse(input).success, true, `schematic_component_edit should accept ${JSON.stringify(input)}`);
}
for (const input of [
  { action: 'read', primitiveId: 'r1' },
  { action: 'modify', primitiveId: 'r1', property: { net: 'VCC' } },
  { action: 'delete', primitiveId: 'r1', property: { x: 100 } },
  { action: 'delete', primitiveId: '' },
  { action: 'delete' },
]) {
  assert.equal(schematicComponentEditSchema.safeParse(input).success, false, `schematic_component_edit should reject ${JSON.stringify(input)}`);
}
const pcbComponentEditDefinition = definitions.find((definition) => definition.name === 'pcb_component_edit');
assert.ok(pcbComponentEditDefinition);
const pcbComponentEditSchema = z.fromJSONSchema(pcbComponentEditDefinition.inputSchema);
assert.equal(pcbComponentEditDefinition.inputSchema.$defs.componentProperty.minProperties, 1);
for (const input of [
  { action: 'read' },
  { action: 'create', source: { kind: 'device', libraryUuid: 'lib', uuid: 'dev' }, layer: 1, x: 10, y: 20 },
  { action: 'create', source: { kind: 'footprint', libraryUuid: 'lib', uuid: 'fp' }, layer: 2, x: 0, y: 0, rotation: 90, primitiveLock: true, timeoutMs: 60000 },
  { action: 'modify', primitiveId: 'p1', property: { x: 11, rotation: 180, designator: 'R2', addIntoBom: true, otherProperty: { Value: '10k', Price: 2.5, Fitted: true } } },
  { action: 'modify', primitiveId: 'p1', property: { manufacturer: null, supplierId: 'C123' } },
  { action: 'delete', primitiveId: 'p1' },
]) {
  assert.equal(pcbComponentEditSchema.safeParse(input).success, true, `pcb_component_edit should accept ${JSON.stringify(input)}`);
}
for (const input of [
  { action: 'read', primitiveId: 'p1' },
  { action: 'create', source: { kind: 'device', libraryUuid: 'lib', uuid: 'dev' }, layer: 3, x: 0, y: 0 },
  { action: 'create', source: { kind: 'footprint', libraryUuid: 'lib', uuid: 'fp' }, layer: 1, x: 0 },
  { action: 'modify', primitiveId: 'p1', property: { net: 'VCC' } },
  { action: 'delete', primitiveId: 'p1', property: { x: 1 } },
  { action: 'delete' },
]) {
  assert.equal(pcbComponentEditSchema.safeParse(input).success, false, `pcb_component_edit should reject ${JSON.stringify(input)}`);
}
const pcbPourDefinition = definitions.find((definition) => definition.name === 'pcb_pour_manage');
assert.ok(pcbPourDefinition);
const pcbPourSchema = z.fromJSONSchema(pcbPourDefinition.inputSchema);
assert.equal(pcbPourDefinition.inputSchema.$defs.pourProperty.minProperties, 1);
for (const input of [
  { action: 'read' },
  { action: 'create', net: 'GND', layer: 1, polygonSource: ['L', 0, 0, 10, 0, 10, 10, 0, 10, 'C'], pourFillMethod: 'solid' },
  { action: 'create', net: 'VCC', layer: 44, polygonSource: ['CIRCLE', 10, 10, 5] },
  { action: 'modify', primitiveId: 'pour-1', property: { polygonSource: ['R', 0, 0, 10, 10], pourPriority: 2 } },
  { action: 'modify', primitiveId: 'pour-1', property: { net: 'GND', pourFillMethod: '45grid' } },
  { action: 'delete', primitiveId: 'pour-1' },
  { action: 'rebuild', primitiveId: 'pour-1' },
  { action: 'rebuild', all: true },
]) {
  assert.equal(pcbPourSchema.safeParse(input).success, true, `pcb_pour_manage should accept ${JSON.stringify(input)}`);
}
for (const input of [
  { action: 'read', primitiveId: 'pour-1' },
  { action: 'create', net: 'GND', layer: 3, polygonSource: ['L', 0, 0] },
  { action: 'create', net: 'GND', layer: 1, polygonSource: ['BAD', 0, 0] },
  { action: 'create', net: 'GND', layer: 1 },
  { action: 'modify', primitiveId: 'pour-1', property: { x: 10 } },
  { action: 'delete', primitiveId: 'pour-1', property: { net: 'VCC' } },
  { action: 'rebuild' },
  { action: 'rebuild', primitiveId: 'pour-1', all: true },
]) {
  assert.equal(pcbPourSchema.safeParse(input).success, false, `pcb_pour_manage should reject ${JSON.stringify(input)}`);
}
const pcbRoutingDefinition = definitions.find((definition) => definition.name === 'pcb_routing_edit');
assert.ok(pcbRoutingDefinition);
const pcbRoutingSchema = z.fromJSONSchema(pcbRoutingDefinition.inputSchema);
assert.equal(pcbRoutingDefinition.inputSchema.$defs.lineProperty.minProperties, 1);
for (const input of [
  { action: 'read' },
  { action: 'read', kind: 'via', primitiveId: 'v1' },
  { action: 'create', kind: 'arc', net: 'GND', layer: 1, startX: 0, startY: 0, endX: 10, endY: 5, arcAngle: 90, interactiveMode: 1 },
  { action: 'create', kind: 'polyline', net: 'GND', layer: 2, polygonSource: [0, 0, 'L', 10, 0, 10, 10], lineWidth: 0.3 },
  { action: 'modify', kind: 'line', primitiveId: 'l1', property: { startX: 1, lineWidth: 0.2 } },
  { action: 'modify', kind: 'arc', primitiveId: 'a1', property: { arcAngle: -90, interactiveMode: 2 } },
  { action: 'modify', kind: 'polyline', primitiveId: 'p1', property: { polygonSource: [0, 0, 'L', 5, 5] } },
  { action: 'modify', kind: 'via', primitiveId: 'v1', property: { diameter: 0.6, holeDiameter: 0.3 } },
  { action: 'delete', kind: 'via', primitiveId: 'v1' },
]) {
  assert.equal(pcbRoutingSchema.safeParse(input).success, true, `pcb_routing_edit should accept ${JSON.stringify(input)}`);
}
for (const input of [
  { action: 'read', kind: 'line' },
  { action: 'create', kind: 'line', net: 'GND', layer: 1, startX: 0, startY: 0, endX: 10, endY: 0 },
  { action: 'create', kind: 'arc', net: 'GND', layer: 1, startX: 0, startY: 0, endX: 10, endY: 5 },
  { action: 'create', kind: 'polyline', net: 'GND', layer: 3, polygonSource: [0, 0, 'L', 10, 0] },
  { action: 'modify', kind: 'via', primitiveId: 'v1', property: { viaType: 1 } },
  { action: 'modify', kind: 'arc', primitiveId: 'a1', property: { polygonSource: [0, 0, 'L', 10, 0] } },
  { action: 'delete', kind: 'via' },
]) {
  assert.equal(pcbRoutingSchema.safeParse(input).success, false, `pcb_routing_edit should reject ${JSON.stringify(input)}`);
}
const boardOutlineDefinition = definitions.find((definition) => definition.name === 'pcb_board_outline_manage');
assert.ok(boardOutlineDefinition);
const boardOutlineSchema = z.fromJSONSchema(boardOutlineDefinition.inputSchema);
for (const input of [
  { action: 'read' },
  { action: 'read', kind: 'line', primitiveId: 'l1' },
  { action: 'create', kind: 'line', startX: 0, startY: 0, endX: 10, endY: 0 },
  { action: 'create', kind: 'arc', startX: 0, startY: 0, endX: 10, endY: 10, arcAngle: 90 },
  { action: 'create', kind: 'polyline', polygonSource: [0, 0, 'L', 10, 0] },
  { action: 'modify', kind: 'line', primitiveId: 'l1', property: { endX: 20 } },
  { action: 'modify', kind: 'polyline', primitiveId: 'p1', property: { polygonSource: [0, 0, 'L', 20, 0] } },
  { action: 'delete', kind: 'arc', primitiveId: 'a1' },
]) {
  assert.equal(boardOutlineSchema.safeParse(input).success, true, `pcb_board_outline_manage should accept ${JSON.stringify(input)}`);
}
for (const input of [
  { action: 'read', kind: 'line' },
  { action: 'create', kind: 'line', startX: 0, startY: 0 },
  { action: 'create', kind: 'line', net: 'GND', layer: 1, startX: 0, startY: 0, endX: 10, endY: 0 },
  { action: 'modify', kind: 'line', primitiveId: 'l1', property: { layer: 1 } },
  { action: 'delete', kind: 'via', primitiveId: 'v1' },
]) {
  assert.equal(boardOutlineSchema.safeParse(input).success, false, `pcb_board_outline_manage should reject ${JSON.stringify(input)}`);
}
const regionDefinition = definitions.find((definition) => definition.name === 'pcb_region_manage');
assert.ok(regionDefinition);
const regionSchema = z.fromJSONSchema(regionDefinition.inputSchema);
for (const input of [
  { action: 'read' },
  { action: 'read', primitiveId: 'r1' },
  { action: 'create', layer: 1, polygonSource: ['R', 0, 0, 100, 100, 0, 0], ruleType: [2, 5] },
  { action: 'create', layer: 12, polygonSource: ['R', 0, 0, 100, 100, 0, 0], ruleType: [9], regionName: '电源规则' },
  { action: 'modify', primitiveId: 'r1', property: { ruleType: [5], lineWidth: 0.2 } },
  { action: 'delete', primitiveId: 'r1' },
]) {
  assert.equal(regionSchema.safeParse(input).success, true, `pcb_region_manage should accept ${JSON.stringify(input)}`);
}
for (const input of [
  { action: 'create', layer: 3, polygonSource: ['R', 0, 0, 100, 100, 0, 0], ruleType: [2] },
  { action: 'create', layer: 1, polygonSource: ['R', 0, 0, 100, 100, 0, 0], ruleType: [] },
  { action: 'modify', primitiveId: 'r1', property: { net: 'GND' } },
  { action: 'delete' },
]) {
  assert.equal(regionSchema.safeParse(input).success, false, `pcb_region_manage should reject ${JSON.stringify(input)}`);
}
const textDefinition = definitions.find(definition => definition.name === 'pcb_text_manage');
const schematicTextDefinition = definitions.find(definition => definition.name === 'schematic_text_manage');
assert.ok(schematicTextDefinition);
const schematicTextSchema = z.fromJSONSchema(schematicTextDefinition.inputSchema);
for (const input of [
  { action: 'read' },
  { action: 'read', primitiveId: 'text-1' },
  { action: 'create', x: 100, y: 200, content: 'Note' },
  { action: 'delete', primitiveId: 'text-1' },
])
  assert.equal(schematicTextSchema.safeParse(input).success, true, `schematic_text_manage should accept ${JSON.stringify(input)}`);
for (const input of [
  { action: 'create', x: 100, y: 200 },
  { action: 'create', x: 100, y: 200, content: 'Note', rotation: 45 },
  { action: 'create', x: 100, y: 200, content: 'Note', alignMode: 6 },
  { action: 'modify', primitiveId: 'text-1', property: { content: 'Updated' } },
  { action: 'delete' },
])
  assert.equal(schematicTextSchema.safeParse(input).success, false, `schematic_text_manage should reject ${JSON.stringify(input)}`);
assert.ok(textDefinition);
const textSchema = z.fromJSONSchema(textDefinition.inputSchema);
// #71：独立验证顶层 property，避免只测 Zod 忽略父约束的 oneOf 分支。
const textPropertySchema = z.fromJSONSchema({ $defs: textDefinition.inputSchema.$defs, ...textDefinition.inputSchema.properties.property });
assert.equal(textPropertySchema.safeParse({ value: 'NEW' }).success, true);
assert.equal(textPropertySchema.safeParse({ valueVisible: false }).success, true);
assert.equal(textPropertySchema.safeParse({ text: 'NEW' }).success, true);
assert.equal(textPropertySchema.safeParse({ unknown: true }).success, false);
for (const input of [
  { action: 'read' },
  { action: 'read', kind: 'string' },
  { action: 'read', kind: 'attribute', parentPrimitiveId: 'comp-1' },
  { action: 'read', kind: 'attribute', primitiveId: 'attr-1' },
  { action: 'create', kind: 'string', layer: 3, x: 10, y: 20, text: 'Rev B' },
  { action: 'modify', kind: 'string', primitiveId: 's-1', property: { text: 'Rev C' } },
  { action: 'modify', kind: 'attribute', primitiveId: 'a-1', parentPrimitiveId: 'comp-1', property: { valueVisible: false } },
  { action: 'modify', kind: 'attribute', primitiveId: 'a-1', parentPrimitiveId: 'comp-1', property: { value: 'NEW', key: 'Value', keyVisible: true } },
  { action: 'delete', kind: 'string', primitiveId: 's-1' },
]) {
  assert.equal(textSchema.safeParse(input).success, true, `pcb_text_manage should accept ${JSON.stringify(input)}`);
}
for (const input of [
  { action: 'create', kind: 'attribute', layer: 3, x: 10, y: 20, text: 'bad' },
  { action: 'delete', kind: 'attribute', primitiveId: 'a-1' },
  { action: 'modify', kind: 'attribute', primitiveId: 'a-1', property: { value: 'U2' } },
  { action: 'modify', kind: 'string', primitiveId: 's-1', property: { net: 'GND' } },
  { action: 'modify', kind: 'string', primitiveId: 's-1', property: { value: 'NEW' } },
  { action: 'modify', kind: 'attribute', primitiveId: 'a-1', parentPrimitiveId: 'comp-1', property: { text: 'NEW' } },
  { action: 'create', kind: 'string', layer: 7, x: 10, y: 20, text: 'bad' },
]) {
  assert.equal(textSchema.safeParse(input).success, false, `pcb_text_manage should reject ${JSON.stringify(input)}`);
}
const componentSelectSchema = z.fromJSONSchema(componentSelectDefinition.inputSchema);
assert.equal(componentSelectSchema.safeParse({ keyword: '1kΩ', limit: 2 }).success, true);
assert.equal(componentSelectSchema.safeParse({ properties: { supplierId: 'C25804' } }).success, true);
assert.equal(componentSelectSchema.safeParse({ keyword: '1kΩ', properties: { supplierId: 'C25804' } }).success, false);
assert.equal(componentSelectSchema.safeParse({ limit: 2 }).success, false);

const designCompareDefinition = definitions.find((definition) => definition.name === 'design_compare');
assert.ok(designCompareDefinition);
const designCompareSchema = z.fromJSONSchema(designCompareDefinition.inputSchema);
assert.equal(designCompareSchema.safeParse({ domain: 'netlist', sourceA: 'a', sourceB: 'b' }).success, true);
assert.equal(designCompareSchema.safeParse({ domain: 'schematic', sourceA: { projectUuid: 'project', schematicUuid: 'sch-a' }, sourceB: { projectUuid: 'project', schematicUuid: 'sch-b' } }).success, true);
assert.equal(designCompareSchema.safeParse({ domain: 'pcb', sourceA: { projectUuid: 'project', pcbUuid: 'pcb-a' }, sourceB: { projectUuid: 'project', pcbUuid: 'pcb-b' } }).success, true);
assert.equal(designCompareSchema.safeParse({ domain: 'netlist', sourceA: '', sourceB: 'b' }).success, false);

const schematicPagesDefinition = definitions.find((definition) => definition.name === 'schematic_pages_manage');
assert.ok(schematicPagesDefinition);
const schematicPagesSchema = z.fromJSONSchema(schematicPagesDefinition.inputSchema);
for (const input of [
	{ operation: 'create', schematicUuid: 'sch-1', confirm: true },
	{ operation: 'copy', sourcePageUuid: 'page-1', confirm: true },
	{ operation: 'copy', sourcePageUuid: 'page-1', schematicUuid: 'sch-2', confirm: true },
	{ operation: 'rename', schematicPageUuid: 'page-1', newName: 'Power', confirm: true },
	{ operation: 'reorder', schematicUuid: 'sch-1', orderedPageUuids: ['page-2', 'page-1'], confirm: true },
]) {
	assert.equal(schematicPagesSchema.safeParse(input).success, true, `schematic_pages_manage should accept ${JSON.stringify(input)}`);
}
for (const input of [
	{ operation: 'create', schematicUuid: 'sch-1', confirm: false },
	{ operation: 'copy', confirm: true },
	{ operation: 'rename', schematicPageUuid: 'page-1', confirm: true },
	{ operation: 'reorder', schematicUuid: 'sch-1', orderedPageUuids: [], confirm: true },
	{ operation: 'delete', schematicPageUuid: 'page-1', confirm: true },
]) {
	assert.equal(schematicPagesSchema.safeParse(input).success, false, `schematic_pages_manage should reject ${JSON.stringify(input)}`);
}

const boardSetupDefinition = definitions.find(definition => definition.name === 'board_setup');
assert.ok(boardSetupDefinition);
const boardSetupSchema = z.fromJSONSchema(boardSetupDefinition.inputSchema);
assert.equal(boardSetupSchema.safeParse({ projectUuid: 'project-1', confirm: true }).success, true);
assert.equal(boardSetupSchema.safeParse({ projectUuid: 'project-1', schematicUuid: 'schematic-1', confirm: true }).success, true);
assert.equal(boardSetupSchema.safeParse({ projectUuid: 'project-1', confirm: false }).success, false);
assert.equal(boardSetupSchema.safeParse({ schematicUuid: 'schematic-1', confirm: true }).success, false);

const librarySearchDefinition = definitions.find((definition) => definition.name === 'library_search');
assert.ok(librarySearchDefinition);
const librarySearchSchema = z.fromJSONSchema(librarySearchDefinition.inputSchema);
assert.equal(librarySearchSchema.safeParse({ kind: 'simulation_model', keyword: 'resistor', simulationModelType: 'Ngspice', limit: 3, page: 2 }).success, true);
assert.equal(librarySearchSchema.safeParse({ kind: 'simulation_model', keyword: 'resistor', simulationModelType: 'invalid' }).success, false);
assert.equal(librarySearchSchema.safeParse({ kind: 'simulation_model', uuid: 'simulation-1' }).success, false);

const manufactureExportDefinition = definitions.find((definition) => definition.name === 'manufacture_export');
assert.ok(manufactureExportDefinition);
const manufactureExportSchema = z.fromJSONSchema(manufactureExportDefinition.inputSchema);
for (const input of [
  { domain: 'pcb', kind: 'gerber', unit: 'inch' },
  { domain: 'schematic', kind: 'bom', fileType: 'csv', includeData: true },
  { domain: 'pcb', kind: 'bom', fileType: 'xlsx' },
  { domain: 'pcb', kind: 'pick_and_place', unit: 'mil' },
  { domain: 'pcb', kind: 'open_database', unit: 'inch' },
  { domain: 'pcb', kind: 'open_database', unit: 'mm' },
]) {
  assert.equal(manufactureExportSchema.safeParse(input).success, true, `manufacture_export should accept ${JSON.stringify(input)}`);
}
for (const input of [
  { domain: 'pcb', kind: 'gerber', unit: 'mil' },
	{ domain: 'pcb', kind: 'gerber', unit: 'in' },
  { domain: 'pcb', kind: 'pick_and_place', unit: 'inch' },
	{ domain: 'pcb', kind: 'ipc_2581c' },
	{ domain: 'pcb', kind: 'jrouter_auto_route_json' },
  { domain: 'pcb', kind: 'bom', unit: 'mm' },
  { domain: 'schematic', kind: 'bom', unit: 'mm' },
]) {
  assert.equal(manufactureExportSchema.safeParse(input).success, false, `manufacture_export should reject ${JSON.stringify(input)}`);
}
assert.equal(manufactureExportSchema.safeParse({ domain: 'pcb', kind: 'pdf', template: 'ignored' }).success, false);
assert.equal(manufactureExportSchema.safeParse({ domain: 'schematic', kind: 'document', assemblyVariantsConfig: { text: 'x', value: 'y' } }).success, false);

const constraintsDefinition = definitions.find((definition) => definition.name === 'pcb_constraints_manage');
assert.ok(constraintsDefinition);
const constraintsSchema = z.fromJSONSchema(constraintsDefinition.inputSchema);
assert.equal(constraintsSchema.safeParse({ kind: 'net_class', operation: 'create', name: 'USB', nets: ['D+'], color: { r: 0, g: 0, b: 0, alpha: 1 }, confirm: true }).success, true);
assert.equal(constraintsSchema.safeParse({ kind: 'net_class', operation: 'create', name: 'USB', confirm: true }).success, false);
assert.equal(constraintsSchema.safeParse({ kind: 'differential_pair', operation: 'set_positive_net', name: 'USB', positiveNet: 'D+', confirm: true, nets: ['D+'] }).success, false);
assert.equal(constraintsSchema.safeParse({ kind: 'pad_pair_group', operation: 'add_members', name: 'USB', padPairs: [['J1.1', 'U1.1']], confirm: true }).success, true);

const schematicDocumentDefinition = definitions.find((definition) => definition.name === 'schematic_document_action');
assert.ok(schematicDocumentDefinition);
const schematicDocumentSchema = z.fromJSONSchema(schematicDocumentDefinition.inputSchema);
assert.equal(schematicDocumentSchema.safeParse({ action: 'primitive_at_point', x: 1, y: 2, ids: ['unexpected'] }).success, false);
assert.equal(schematicDocumentSchema.safeParse({ action: 'primitives_by_id', ids: ['primitive-1'], limit: 1 }).success, false);

const footprintSaveDefinition = definitions.find((definition) => definition.name === 'footprint_save');
assert.ok(footprintSaveDefinition);
const footprintSaveSchema = z.fromJSONSchema(footprintSaveDefinition.inputSchema);
assert.deepEqual(footprintSaveSchema.parse({ timeoutMs: 60000 }), { timeoutMs: 60000 });
assert.equal(footprintSaveSchema.safeParse({ timeoutMs: 4999 }).success, false);
assert.equal(footprintSaveSchema.safeParse({ documentSource: 'external source' }).success, false);
assert.equal(footprintSaveSchema.safeParse({ libraryUuid: 'another-library' }).success, false);
await dispatcher.dispatch({ name: 'footprint_save', arguments: footprintSaveSchema.parse({ timeoutMs: 60000 }) });
assert.equal(calls.at(-1).path, '/bridge/jlceda/footprint/save');
assert.deepEqual(calls.at(-1).payload, { timeoutMs: 60000 });
assert.equal(calls.at(-1).timeoutMs, 62000);
assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/footprint/save', {}), false);

const rawWireDefinition = definitions.find((definition) => definition.name === 'api_invoke');
assert.ok(rawWireDefinition);
const rawWireSchema = z.fromJSONSchema(rawWireDefinition.inputSchema);
const rawWireInput = { apiFullName: 'eda.sch_PrimitiveWire.create', args: [[[0, 0, 10, 0], [10, 0, 10, 20]], 'sig', '#FF0000', 6, 1], allowedWireIds: ['existing-wire'] };
const parsedRawWire = rawWireSchema.parse(rawWireInput);
assert.deepEqual(parsedRawWire.allowedWireIds, rawWireInput.allowedWireIds, 'the MCP input schema must preserve explicit wire-contact approval');
await dispatcher.dispatch({ name: 'api_invoke', arguments: parsedRawWire });
assert.equal(calls.at(-1).path, '/bridge/jlceda/api/invoke');
assert.deepEqual(calls.at(-1).payload.args, rawWireInput.args);
assert.deepEqual(calls.at(-1).payload.allowedWireIds, rawWireInput.allowedWireIds);

const connectivityDefinition = definitions.find((definition) => definition.name === 'schematic_connectivity_action');
assert.ok(connectivityDefinition);
const connectivitySchema = z.fromJSONSchema(connectivityDefinition.inputSchema);
assert.equal(connectivitySchema.safeParse({ action: 'wire_preview', line: [0, 0, 100, 0] }).success, true);
assert.equal(connectivitySchema.safeParse({ action: 'wire_create', line: [0, 0, 100, 0], allowedWireIds: ['wire-1'] }).success, true);
const maximumWireLine = Array.from({ length: 256 }, (_, index) => [index, 0]).flat();
assert.equal(connectivityDefinition.inputSchema.properties.line.maxItems, 512);
for (const action of ['wire_preview', 'wire_create']) {
  const actionSchema = connectivityDefinition.inputSchema.oneOf.find((variant) => variant.properties.action.const === action);
  assert.equal(actionSchema.properties.line.maxItems, 512);
  assert.equal(connectivitySchema.safeParse({ action, line: maximumWireLine }).success, true);
  assert.equal(connectivitySchema.safeParse({ action, line: [...maximumWireLine, 256, 0] }).success, false);
}
assert.equal(connectivitySchema.safeParse({ action: 'netport_create', net: 'SIGNAL', x: 10, y: 20 }).success, true);
assert.equal(connectivitySchema.safeParse({ action: 'netport_move', id: 'port-1', x: 10, y: 20 }).success, true);
assert.equal(connectivitySchema.safeParse({ action: 'netport_move', id: 'port-1', x: 10 }).success, false);
assert.equal(connectivitySchema.safeParse({ action: 'wire_create', line: [0, 0, 100, 0], id: 'port-1' }).success, false);

const pcbDocumentDefinition = definitions.find((definition) => definition.name === 'pcb_document_action');
assert.ok(pcbDocumentDefinition);
const pcbDocumentSchema = z.fromJSONSchema(pcbDocumentDefinition.inputSchema);
assert.equal(pcbDocumentSchema.safeParse({ action: 'save' }).success, true);
assert.equal(pcbDocumentSchema.safeParse({ action: 'save', uuid: 'pcb-other' }).success, false);

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
