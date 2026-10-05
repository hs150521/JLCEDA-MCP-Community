const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');

const { handleSchematicComponentEditTask } = require('../src/mcp/schematic-component-edit-handler.ts');
const { requiresHostRestartForResult } = require('../src/runtime/task-timeout.ts');
const { toSerializableAsync } = require('../src/utils.ts');

const path = '/bridge/jlceda/schematic/component-edit';

function primitive(state) {
	const getters = {
		PrimitiveId: 'primitiveId',
		ComponentType: 'type',
		X: 'x',
		Y: 'y',
		Rotation: 'rotation',
		Mirror: 'mirror',
		Designator: 'designator',
		Name: 'name',
		UniqueId: 'uniqueId',
		AddIntoBom: 'addIntoBom',
		AddIntoPcb: 'addIntoPcb',
		Manufacturer: 'manufacturer',
		ManufacturerId: 'manufacturerId',
		Supplier: 'supplier',
		SupplierId: 'supplierId',
		OtherProperty: 'otherProperty',
	};
	return Object.fromEntries(Object.entries(getters).map(([suffix, key]) => [`getState_${suffix}`, () => state[key]]));
}

async function main() {
	let pageUuid = 'page-1';
	const wires = [
		{ getState_PrimitiveId: () => 'foreign', getState_Line: () => [400, 500, 410, 500], getState_Net: () => 'FOREIGN' },
		{ getState_PrimitiveId: () => 'unnamed-a', getState_Line: () => [300, 400, 310, 400], getState_Net: () => null },
		{ getState_PrimitiveId: () => 'unnamed-b', getState_Line: () => [500, 400, 510, 400], getState_Net: () => '' },
		{ getState_PrimitiveId: () => 'unnamed-b-extension', getState_Line: () => [510, 400, 520, 400], getState_Net: () => '' },
	];
	const parts = new Map([
		['r1', {
			primitiveId: 'r1',
			type: 'part',
			x: 100,
			y: 200,
			rotation: 0,
			mirror: false,
			designator: 'R1',
			name: 'Resistor',
			uniqueId: 'uid-r1',
			addIntoBom: true,
			addIntoPcb: true,
			manufacturer: 'Maker',
			manufacturerId: 'M-1',
			supplier: 'Supplier',
			supplierId: 'S-1',
			otherProperty: { Value: '10k', Datasheet: 'https://example.test/r' },
		}],
		['c1', {
			primitiveId: 'c1',
			type: 'part',
			x: 300,
			y: 400,
			rotation: 90,
			mirror: true,
			designator: undefined,
			name: undefined,
			uniqueId: undefined,
			addIntoBom: undefined,
			addIntoPcb: undefined,
			manufacturer: undefined,
			manufacturerId: undefined,
			supplier: undefined,
			supplierId: undefined,
			otherProperty: undefined,
		}],
	]);
	let callCount = 0;
	globalThis.eda = {
		dmt_Schematic: { async getCurrentSchematicPageInfo() { return { uuid: pageUuid }; } },
		dmt_SelectControl: { async getCurrentDocumentInfo() { return { uuid: pageUuid }; } },
		sch_PrimitiveComponent: {
			async getAll(type, allPages) {
				assert.ok(type === 'part' || type === undefined);
				assert.equal(allPages, false);
				return [...parts.values()].map(primitive);
			},
			async getAllPrimitiveId(type, allPages) {
				assert.ok(type === 'part' || type === undefined);
				assert.equal(allPages, false);
				return [...parts.keys()];
			},
			async get(id) {
				const state = parts.get(id);
				return state ? primitive(state) : undefined;
			},
			async getAllPinsByPrimitiveId(id) {
				const state = parts.get(id);
				if (!state)
					return [];
				return [{
					getState_PinNumber: () => '1',
					getState_PinName: () => 'P',
					getState_PinType: () => 'passive',
					getState_X: () => state.x,
					getState_Y: () => state.y,
					getState_NoConnected: () => false,
				}];
			},
			async modify(id, property) {
				callCount += 1;
				assert.ok(parts.has(id));
				const current = parts.get(id);
				Object.assign(current, property);
				return primitive(current);
			},
			async delete(target) {
				callCount += 1;
				assert.equal(typeof target.getState_PrimitiveId, 'function', 'delete uses the current-page primitive object');
				parts.delete(target.getState_PrimitiveId());
				return true;
			},
		},
		sch_PrimitiveWire: { async getAll() { return wires; } },
		sch_Drc: { async check() { return true; } },
	};
	const full = await handleSchematicComponentEditTask({ action: 'read' });
	assert.deepEqual([full.ok, full.action, full.scope, full.complete, full.pageUuid, full.componentCount], [true, 'read', 'current_schematic_page', true, 'page-1', 2]);
	assert.deepEqual(full.components[0].otherProperty, { Value: '10k', Datasheet: 'https://example.test/r' });
	assert.deepEqual(full.components[1].otherProperty, {});
	assert.equal(full.components[1].designator, null);
	assert.equal(full.components[1].addIntoBom, null);
	assert.equal(full.components[1].supplierId, null);
	for (let index = 0; index < 125; index += 1) {
		parts.set(`extra-${index}`, {
			...parts.get('c1'),
			primitiveId: `extra-${index}`,
		});
	}
	const largeRead = await toSerializableAsync(await handleSchematicComponentEditTask({ action: 'read' }));
	assert.equal(largeRead.componentCount, 127);
	assert.equal(largeRead.components.length, 127, 'complete snapshots must survive bridge serialization without truncation');
	assert.equal(largeRead.components[0].otherProperty.Value, '10k');
	assert.equal(largeRead.components[0].otherProperty.Datasheet, 'https://example.test/r');
	for (let index = 0; index < 125; index += 1)
		parts.delete(`extra-${index}`);
	await assert.rejects(handleSchematicComponentEditTask({ action: 'read', primitiveId: 'r1' }), /primitiveId is unsupported/);
	const beforeModifyCalls = callCount;
	await assert.rejects(handleSchematicComponentEditTask({ action: 'modify', primitiveId: 'r1', property: { x: Infinity } }), /finite number/);
	assert.equal(callCount, beforeModifyCalls);
	const modified = await handleSchematicComponentEditTask({
		action: 'modify',
		primitiveId: 'r1',
		property: { x: 150, y: 250, rotation: 180, mirror: true, designator: 'R2', manufacturerId: 'M-2', addIntoBom: false, otherProperty: { Value: '22k' } },
	});
	assert.equal(modified.ok, true);
	assert.equal(modified.verified, true);
	assert.equal(modified.before.designator, 'R1');
	assert.equal(modified.after.designator, 'R2');
	assert.equal(modified.after.x, 150);
	assert.equal(modified.after.y, 250);
	assert.equal(modified.after.rotation, 180);
	assert.equal(modified.after.mirror, true);
	assert.equal(modified.after.addIntoBom, false);
	assert.deepEqual(modified.after.otherProperty, { Value: '22k', Datasheet: 'https://example.test/r' });
	const missing = await handleSchematicComponentEditTask({ action: 'modify', primitiveId: 'on-another-page', property: { x: 20 } });
	assert.equal(missing.reason, 'component_not_found');
	assert.equal(callCount, beforeModifyCalls + 1);
	const unintendedNet = await handleSchematicComponentEditTask({ action: 'modify', primitiveId: 'r1', property: { x: 400, y: 500 } });
	assert.equal(unintendedNet.ok, false);
	assert.equal(unintendedNet.reason, 'pin_network_changed');
	assert.equal(unintendedNet.committed, true);
	assert.equal(unintendedNet.commitUnknown, true);
	assert.deepEqual(unintendedNet.pinNetworkChanges, [{ pinNumber: '1', before: '', after: 'FOREIGN' }]);
	const differentUnnamedWire = await handleSchematicComponentEditTask({ action: 'modify', primitiveId: 'c1', property: { x: 505 } });
	assert.equal(differentUnnamedWire.reason, 'pin_network_changed');
	assert.deepEqual(differentUnnamedWire.pinNetworkChanges, [{ pinNumber: '1', before: '', after: '', beforeWireGroups: ['unnamed-a'], afterWireGroups: ['unnamed-b'] }]);
	const sameUnnamedGroup = await handleSchematicComponentEditTask({ action: 'modify', primitiveId: 'c1', property: { x: 515 } });
	assert.equal(sameUnnamedGroup.ok, true, 'moving between touching unnamed wires keeps the same network');
	const detachedUnnamedWire = await handleSchematicComponentEditTask({ action: 'modify', primitiveId: 'c1', property: { x: 550 } });
	assert.equal(detachedUnnamedWire.reason, 'pin_network_changed');
	assert.deepEqual(detachedUnnamedWire.pinNetworkChanges, [{ pinNumber: '1', before: '', after: '', beforeWireGroups: ['unnamed-b'], afterWireGroups: [] }]);
	// 实机 Wire A 的 LINE 端点对，匿名网络同样不能虚构相邻记录间的对角线。
	wires.push({
		getState_PrimitiveId: () => 'native-a',
		getState_Line: () => [100, 200, 180, 200, 100, 200, 100, 350, 100, 500, 100, 350, 180, 500, 100, 500, 100, 540, 100, 500, 200, 540, 100, 540, 50, 350, 100, 350, 50, 450, 50, 350],
		getState_Net: () => '',
	});
	Object.assign(parts.get('c1'), { x: 140, y: 425 });
	const besideNativeWire = await handleSchematicComponentEditTask({ action: 'modify', primitiveId: 'c1', property: { y: 445 } });
	assert.equal(besideNativeWire.ok, true, 'moving off a phantom diagonal does not change an actual unnamed wire group');
	assert.equal(besideNativeWire.pinNetworkChanges, undefined);
	const ontoNativeWire = await handleSchematicComponentEditTask({ action: 'modify', primitiveId: 'c1', property: { x: 100, y: 425 } });
	assert.equal(ontoNativeWire.reason, 'pin_network_changed');
	assert.deepEqual(ontoNativeWire.pinNetworkChanges, [{ pinNumber: '1', before: '', after: '', beforeWireGroups: [], afterWireGroups: ['native-a'] }], 'a real contact with the native segment is still reported');
	const alongNativeWire = await handleSchematicComponentEditTask({ action: 'modify', primitiveId: 'c1', property: { y: 435 } });
	assert.equal(alongNativeWire.ok, true, 'moving on the same native unnamed wire group remains available');
	wires.pop();
	Object.assign(parts.get('c1'), { x: 550, y: 400 });
	const deleted = await handleSchematicComponentEditTask({ action: 'delete', primitiveId: 'r1' });
	assert.equal(deleted.ok, true);
	assert.equal(deleted.deleted, true);
	assert.equal(deleted.verified, true);
	assert.equal((await handleSchematicComponentEditTask({ action: 'read' })).componentCount, 1);
	const absent = await handleSchematicComponentEditTask({ action: 'delete', primitiveId: 'r1' });
	assert.equal(absent.reason, 'component_not_found');
	const originalDocumentInfo = globalThis.eda.dmt_SelectControl.getCurrentDocumentInfo;
	globalThis.eda.dmt_SelectControl.getCurrentDocumentInfo = async () => ({ uuid: 'another-page' });
	const beforeUnsyncedDelete = callCount;
	await assert.rejects(
		handleSchematicComponentEditTask({ action: 'delete', primitiveId: 'c1' }),
		/not synchronized/,
	);
	assert.equal(callCount, beforeUnsyncedDelete);
	globalThis.eda.dmt_SelectControl.getCurrentDocumentInfo = originalDocumentInfo;
	const sourceParts = new Map([['shared', { ...parts.get('c1'), primitiveId: 'shared', x: 501 }]]);
	const copiedParts = new Map([['shared', { ...parts.get('c1'), primitiveId: 'shared', x: 601 }]]);
	const componentApi = globalThis.eda.sch_PrimitiveComponent;
	const originalGetAll = componentApi.getAll;
	const originalGetAllIds = componentApi.getAllPrimitiveId;
	const originalGet = componentApi.get;
	const originalDelete = componentApi.delete;
	componentApi.getAll = async () => [...(pageUuid === 'copied-page' ? copiedParts : sourceParts).values()].map(primitive);
	componentApi.getAllPrimitiveId = async () => [...(pageUuid === 'copied-page' ? copiedParts : sourceParts).keys()];
	componentApi.get = async () => primitive(sourceParts.get('shared'));
	componentApi.delete = async (target) => {
		const id = target.getState_PrimitiveId();
		(target.getState_X() === 601 ? copiedParts : sourceParts).delete(id);
		return true;
	};
	pageUuid = 'copied-page';
	const copiedDelete = await handleSchematicComponentEditTask({ action: 'delete', primitiveId: 'shared' });
	assert.equal(copiedDelete.verified, true);
	assert.equal(copiedDelete.before.x, 601, 'the target object comes from the active copy');
	assert.equal(copiedParts.has('shared'), false);
	assert.equal(sourceParts.has('shared'), true, 'the source page keeps its shared ID');
	pageUuid = 'page-1';
	componentApi.getAll = originalGetAll;
	componentApi.getAllPrimitiveId = originalGetAllIds;
	componentApi.get = originalGet;
	componentApi.delete = originalDelete;

	globalThis.eda.sch_PrimitiveComponent.modify = async () => {
		throw new Error('RPC Call modify Timed Out');
	};
	const nativeTimeout = await handleSchematicComponentEditTask({ action: 'modify', primitiveId: 'c1', property: { x: 10 } });
	assert.deepEqual([nativeTimeout.commitUnknown, nativeTimeout.readbackRequired, nativeTimeout.nativeCallSettled], [true, true, false]);
	assert.equal(requiresHostRestartForResult(path, { action: 'modify' }, nativeTimeout), true);
	assert.equal(requiresHostRestartForResult(path, { action: 'modify' }, { ...nativeTimeout, nativeCallSettled: true }), false);
	globalThis.eda.sch_PrimitiveComponent.modify = async (id, patch) => {
		Object.assign(parts.get(id), patch);
	};
	const liveGetAll = globalThis.eda.sch_PrimitiveComponent.getAll;
	let postWriteReadFails = false;
	globalThis.eda.sch_PrimitiveComponent.getAll = async (...args) => {
		if (postWriteReadFails)
			throw new Error('post-write read unavailable');
		return liveGetAll(...args);
	};
	globalThis.eda.sch_PrimitiveComponent.modify = async (id, patch) => {
		Object.assign(parts.get(id), patch);
		postWriteReadFails = true;
	};
	const readbackFailure = await handleSchematicComponentEditTask({ action: 'modify', primitiveId: 'c1', property: { x: 25 } });
	assert.deepEqual([readbackFailure.commitUnknown, readbackFailure.readbackRequired, readbackFailure.nativeCallSettled], [true, true, true]);
	assert.equal(requiresHostRestartForResult(path, { action: 'modify' }, readbackFailure), false);
	globalThis.eda.sch_PrimitiveComponent.getAll = liveGetAll;
	globalThis.eda.sch_PrimitiveComponent.modify = async (id, patch) => {
		Object.assign(parts.get(id), patch);
		pageUuid = 'page-2';
	};
	const pageChanged = await handleSchematicComponentEditTask({ action: 'modify', primitiveId: 'c1', property: { y: 35 } });
	assert.equal(pageChanged.commitUnknown, true);
	assert.equal(pageChanged.nativeCallSettled, true);
	pageUuid = 'page-1';
	globalThis.eda.sch_PrimitiveComponent.delete = async () => {
		throw new Error('WebSocket connection closed');
	};
	const deleteTimeout = await handleSchematicComponentEditTask({ action: 'delete', primitiveId: 'c1' });
	assert.deepEqual([deleteTimeout.commitUnknown, deleteTimeout.readbackRequired, deleteTimeout.nativeCallSettled], [true, true, false]);
	console.log('Schematic component edit tests passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
