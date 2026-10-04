const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');

const {
	footprintApiAccess,
	isReadOnlyBridgeRequest,
	resolveContractTimeoutMs,
	validateBridgeServerMessage,
} = require('../src/bridge/bridge-contract.ts');
const contract = require('../src/resources/bridge-contract.json');
const {
	registeredBridgeTaskPaths,
} = require('../src/runtime/bridge-handler-registry.ts');
const { requiresHostRestartForResult } = require('../src/runtime/task-timeout.ts');

const expectedPaths = new Set([
	...contract.operations.filter(operation => operation.owner === 'bridge').map(operation => operation.path),
	...contract.internalOperations.map(operation => operation.path),
]);
assert.deepEqual(new Set(registeredBridgeTaskPaths()), expectedPaths, 'Bridge handler registry must exactly implement Bridge-owned contract paths');

assert.equal(resolveContractTimeoutMs('/bridge/jlceda/api/invoke', { timeoutMs: 42000 }), 42000);
assert.equal(resolveContractTimeoutMs('/bridge/jlceda/canvas/snapshot', {}), 30000);
assert.throws(() => resolveContractTimeoutMs('/bridge/jlceda/canvas/snapshot', { timeoutMs: 4999 }), /5000/);
assert.equal(resolveContractTimeoutMs('/bridge/jlceda/component/select', { timeoutMs: 1 }), 25000);
assert.equal(resolveContractTimeoutMs('/bridge/jlceda/component/place-auto', {}), 300000);
assert.equal(resolveContractTimeoutMs('/bridge/jlceda/netlabel/place', { timeoutMs: 420000 }), 420000);
assert.throws(() => resolveContractTimeoutMs('/bridge/jlceda/component/place-auto', { timeoutMs: 600001 }), /600000/);
assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/schematic/read', {}), true);
assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/footprint/read', {}), true);
assert.equal(contract.footprintApi.readOnlyApiFullNames.length, 21);
assert.equal(contract.footprintApi.mutatingApiFullNames.length, 20);
for (const name of contract.footprintApi.readOnlyApiFullNames) {
	assert.equal(footprintApiAccess(name), 'read');
	assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/api/invoke', { apiFullName: name, args: ['primitive-1'] }), true);
}
for (const name of contract.footprintApi.mutatingApiFullNames) {
	assert.equal(footprintApiAccess(name), 'write');
	assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/api/invoke', { apiFullName: name, args: [] }), false);
}
assert.equal(footprintApiAccess('eda.pcb_PrimitiveAttribute.create'), undefined);
assert.equal(footprintApiAccess('eda.pcb_PrimitiveComponent.create'), undefined);
assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/pcb/documents-manage', { operation: 'list', projectUuid: 'project-1' }), true);
assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/editor/navigate', { operation: 'open', projectUuid: 'project-1', documentUuid: 'page-1' }), false);
for (const operation of ['create', 'copy', 'rename'])
	assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/pcb/documents-manage', { operation, projectUuid: 'project-1' }), false);
for (const action of [undefined, 'status', 'selection', 'primitive_by_id', 'primitives_in_region', 'convert_canvas_to_data', 'navigate_to_coordinates', 'navigate_to_region', 'zoom_to_board_outline'])
	assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/pcb/document', action === undefined ? {} : { action }), true);
for (const action of ['select_primitives', 'clear_selection', 'save', 'start_ratline', 'stop_ratline', 'clear_routing', 'import_changes', 'import_auto_route_json', 'import_auto_route_ses', 'import_auto_layout_json'])
	assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/pcb/document', { action }), false);
for (const action of [undefined, 'status', 'filter_configuration', 'selection', 'mouse_position', 'primitive_at_point', 'primitives_in_region', 'primitive_type_by_id', 'primitive_by_id', 'primitives_by_id', 'primitives_bbox', 'navigate_to_coordinates', 'navigate_to_region'])
	assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/schematic/document', action === undefined ? {} : { action }), true);
for (const action of ['select_primitives', 'clear_selection', 'save', 'import_changes'])
	assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/schematic/document', { action }), false);
assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/schematic/layout-check', { mode: 'check' }), true);
assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/schematic/layout-check', { mode: 'fix' }), false);
const connectivityPath = '/bridge/jlceda/schematic/connectivity';
const wireManagePath = '/bridge/jlceda/schematic/wire-manage';
assert.equal(isReadOnlyBridgeRequest(wireManagePath, { action: 'read' }), true);
for (const action of ['modify', 'delete'])
	assert.equal(isReadOnlyBridgeRequest(wireManagePath, { action }), false);
assert.equal(isReadOnlyBridgeRequest(connectivityPath, { action: 'wire_preview' }), true);
for (const action of ['wire_create', 'netport_create', 'netport_move'])
	assert.equal(isReadOnlyBridgeRequest(connectivityPath, { action }), false);
assert.equal(isReadOnlyBridgeRequest(connectivityPath, {}), false);
assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/api/invoke', { apiFullName: 'eda.sch_PrimitiveComponent.create' }), false);
assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/api/invoke', { apiFullName: 'eda.sch_PrimitiveComponent.getAllPrimitiveId', args: [] }), true);
assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/api/invoke', { apiFullName: 'eda.sch_PrimitiveComponent.getAll', args: [] }), true);
assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/api/invoke', { apiFullName: 'eda.sch_PrimitiveComponent.getAllPrimitiveId', args: [null, false] }), true);
assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/api/invoke', { apiFullName: 'eda.sch_PrimitiveComponent.getAll', args: [null, false] }), true);
assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/api/invoke', { apiFullName: 'eda.pcb_PrimitiveComponent.getAll', args: [] }), true);
assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/api/invoke', { apiFullName: 'eda.pcb_PrimitiveComponent.getAll', args: [1, false] }), false);
assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/api/invoke', { apiFullName: 'eda.pcb_PrimitiveComponent.getAll', args: [null, false] }), false);
assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/api/invoke', { apiFullName: 'eda.sch_PrimitiveComponent.getAll', args: [null, true] }), false);
assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/api/invoke', { apiFullName: 'eda.sch_PrimitiveComponent.getAll', args: [1, false] }), false);
assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/api/invoke', { apiFullName: 'eda.sch_PrimitiveComponent.getAll', args: [null, false, 1] }), false);
assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/api/invoke', { apiFullName: 'eda.pcb_primitivecomponent.getall', args: [] }), true);
assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/api/invoke', { apiFullName: ' EDA.SCH_PRIMITIVECOMPONENT.GETALL ', args: [null, false] }), true);
assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/api/invoke', { apiFullName: 'EDA.SCH_PRIMITIVECOMPONENT.GETALL', args: [null, true] }), false);
assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/api/invoke', { apiFullName: 'EDA.SCH_PRIMITIVECOMPONENT.CREATE', args: [] }), false);
for (const path of ['/bridge/jlceda/schematic/connectivity', '/bridge/jlceda/schematic/wire-manage', '/bridge/jlceda/netlabel/place', '/bridge/jlceda/component/place/start', '/bridge/jlceda/api/invoke'])
	assert.equal(requiresHostRestartForResult(path, { apiFullName: 'eda.sch_PrimitiveComponent.create' }, { ok: false, commitUnknown: true, nativeCallSettled: false }), true);
assert.equal(requiresHostRestartForResult('/bridge/jlceda/api/invoke', { apiFullName: 'eda.sch_PrimitiveComponent.create' }, { ok: false, commitUnknown: true, nativeCallSettled: true }), false);

assert.equal(validateBridgeServerMessage({
	type: 'bridge/task',
	requestId: 'request-1',
	path: '/bridge/jlceda/context',
	payload: {},
	createdAt: Date.now(),
	leaseTerm: 1,
}), undefined);
assert.match(validateBridgeServerMessage({ type: 'bridge/task', requestId: '', path: '/bridge/jlceda/context', payload: {}, createdAt: Date.now(), leaseTerm: 1 }) ?? '', /requestId/);
assert.match(validateBridgeServerMessage({ type: 'bridge/task', requestId: 'request-1', path: '/bridge/jlceda/context', createdAt: Date.now(), leaseTerm: 1 }) ?? '', /payload/);
assert.match(validateBridgeServerMessage({ type: 'bridge/task', requestId: 'request-1', path: '/not-a-bridge-route', payload: {}, createdAt: Date.now(), leaseTerm: 1 }) ?? '', /path/);

process.stdout.write(`Bridge contract registry tests passed for ${expectedPaths.size} routes\n`);
