import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
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
	if (path === '/bridge/jlceda/api/invoke' || path === '/bridge/jlceda/library/sources' || path === '/bridge/jlceda/workspace/query' || path === '/bridge/jlceda/design/source-export' || path === '/bridge/jlceda/pcb/constraints-manage' || path === '/bridge/jlceda/schematic/pages-manage') {
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

const libraryPreviewResult = await dispatcher.dispatch({
  name: 'library_preview',
  arguments: { kind: 'symbol', uuid: 'symbol-1', libraryUuid: 'library-1', timeoutMs: 42000 },
});
assert.deepEqual(libraryPreviewResult.content[0], { type: 'image', data: 'AAAA', mimeType: 'image/png' });
assert.equal(libraryPreviewResult.structuredContent.image.dataBase64, undefined);
const libraryPreviewCall = calls.find(call => call.path === '/bridge/jlceda/library/preview');
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

const librarySearchDefinition = definitions.find((definition) => definition.name === 'library_search');
assert.ok(librarySearchDefinition);
const librarySearchSchema = z.fromJSONSchema(librarySearchDefinition.inputSchema);
assert.equal(librarySearchSchema.safeParse({ kind: 'simulation_model', keyword: 'resistor', simulationModelType: 'Ngspice', limit: 3, page: 2 }).success, true);
assert.equal(librarySearchSchema.safeParse({ kind: 'simulation_model', keyword: 'resistor', simulationModelType: 'invalid' }).success, false);
assert.equal(librarySearchSchema.safeParse({ kind: 'simulation_model', uuid: 'simulation-1' }).success, false);

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
