const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');

const { handlePcbComponentEditTask } = require('../src/mcp/pcb-component-edit-handler.ts');
const { requiresHostRestartForResult } = require('../src/runtime/task-timeout.ts');
const { toSerializableAsync } = require('../src/utils.ts');

const path = '/bridge/jlceda/pcb/component-edit';
const keys = {
	PrimitiveId: 'primitiveId',
	Layer: 'layer',
	X: 'x',
	Y: 'y',
	Rotation: 'rotation',
	PrimitiveLock: 'primitiveLock',
	Designator: 'designator',
	Component: 'component',
	Footprint: 'footprint',
	AddIntoBom: 'addIntoBom',
	Name: 'name',
	UniqueId: 'uniqueId',
	Manufacturer: 'manufacturer',
	ManufacturerId: 'manufacturerId',
	Supplier: 'supplier',
	SupplierId: 'supplierId',
	OtherProperty: 'otherProperty',
};

function primitive(state) {
	return Object.fromEntries(Object.entries(keys).map(([suffix, key]) => [`getState_${suffix}`, () => state[key]]));
}

function makeState(id, patch = {}) {
	return {
		primitiveId: id,
		layer: 1,
		x: 100,
		y: 200,
		rotation: 0,
		primitiveLock: false,
		designator: 'R1',
		component: { libraryUuid: 'devices', uuid: 'device-1', name: 'Resistor' },
		footprint: { libraryUuid: 'footprints', uuid: 'footprint-1', name: 'R0402' },
		addIntoBom: true,
		name: 'Resistor',
		uniqueId: 'uid-1',
		manufacturer: 'Maker',
		manufacturerId: 'M-1',
		supplier: 'Supplier',
		supplierId: 'S-1',
		otherProperty: { Value: '10k', Datasheet: 'https://example.test/r' },
		...patch,
	};
}

async function main() {
	let pageUuid = 'pcb-1';
	let serial = 1;
	let writes = 0;
	const parts = new Map([['r1', makeState('r1')]]);
	globalThis.eda = {
		dmt_Pcb: { async getCurrentPcbInfo() { return { uuid: pageUuid }; } },
		pcb_PrimitiveComponent: {
			async getAll(...args) {
				assert.equal(args.length, 0, 'complete snapshot must not filter layer or locked components');
				return [...parts.values()].map(primitive);
			},
			async getAllPrimitiveId(...args) {
				assert.equal(args.length, 0);
				return [...parts.keys()];
			},
			async get(id) {
				const state = parts.get(id);
				return state ? primitive(state) : undefined;
			},
			async create(source, layer, x, y, rotation, primitiveLock) {
				writes += 1;
				const id = `new-${serial++}`;
				const isFootprint = source.libraryType === '4';
				const state = makeState(id, {
					layer,
					x,
					y,
					rotation: rotation ?? 0,
					primitiveLock: primitiveLock ?? false,
					component: isFootprint ? undefined : { libraryUuid: source.libraryUuid, uuid: source.uuid },
					footprint: isFootprint ? { libraryUuid: source.libraryUuid, uuid: source.uuid } : { libraryUuid: 'footprints', uuid: 'footprint-1' },
				});
				parts.set(id, state);
				return primitive(state);
			},
			async modify(id, patch) {
				writes += 1;
				Object.assign(parts.get(id), patch);
				return primitive(parts.get(id));
			},
			async delete(ids) {
				writes += 1;
				assert.deepEqual(ids.length, 1);
				parts.delete(ids[0]);
				return true;
			},
		},
	};
	const api = globalThis.eda.pcb_PrimitiveComponent;
	const first = await handlePcbComponentEditTask({ action: 'read' });
	assert.deepEqual([first.ok, first.scope, first.complete, first.pageUuid, first.componentCount], [true, 'current_pcb_page', true, 'pcb-1', 1]);
	assert.equal(first.components[0].designator, 'R1');
	assert.equal(first.components[0].component.uuid, 'device-1');
	assert.equal(first.components[0].otherProperty.Value, '10k');
	const originalGetAllPrimitiveId = api.getAllPrimitiveId;
	const originalGet = api.get;
	delete api.getAllPrimitiveId;
	delete api.get;
	assert.equal((await handlePcbComponentEditTask({ action: 'read' })).componentCount, 1);
	api.getAllPrimitiveId = originalGetAllPrimitiveId;
	api.get = originalGet;
	for (let index = 0; index < 125; index++)
		parts.set(`extra-${index}`, makeState(`extra-${index}`, { designator: undefined, component: index === 0 ? { libraryUuid: '', uuid: '' } : undefined, otherProperty: undefined }));
	const complete = await toSerializableAsync(await handlePcbComponentEditTask({ action: 'read' }));
	assert.equal(complete.componentCount, 126);
	assert.equal(complete.components.length, 126, 'read must survive bridge serialization without truncation');
	assert.equal(complete.components[1].designator, null);
	assert.equal(complete.components[1].component, null);
	assert.deepEqual(complete.components[1].otherProperty, {});
	for (let index = 0; index < 125; index++)
		parts.delete(`extra-${index}`);
	await assert.rejects(handlePcbComponentEditTask({ action: 'create', source: { kind: 'device', libraryUuid: 'devices', uuid: 'device-2' }, layer: 3, x: 5, y: 6 }), /layer/);
	await assert.rejects(handlePcbComponentEditTask({ action: 'modify', primitiveId: 'r1', property: { x: Infinity } }), /finite number/);
	assert.equal(writes, 0);
	const createdDevice = await handlePcbComponentEditTask({ action: 'create', source: { kind: 'device', libraryUuid: 'devices', uuid: 'device-2' }, layer: 2, x: 300, y: 400, rotation: 90, primitiveLock: true });
	assert.deepEqual([createdDevice.ok, createdDevice.verified, createdDevice.primitiveId], [true, true, 'new-1']);
	assert.deepEqual([createdDevice.after.layer, createdDevice.after.x, createdDevice.after.rotation, createdDevice.after.primitiveLock], [2, 300, 90, true]);
	const createdFootprint = await handlePcbComponentEditTask({ action: 'create', source: { kind: 'footprint', libraryUuid: 'footprints', uuid: 'footprint-2' }, layer: 1, x: 500, y: 600 });
	assert.equal(createdFootprint.ok, true);
	assert.equal(createdFootprint.after.component, null);
	assert.equal(createdFootprint.after.footprint.uuid, 'footprint-2');
	const modified = await handlePcbComponentEditTask({ action: 'modify', primitiveId: 'r1', property: {
		layer: 2,
		x: 150,
		y: 250,
		rotation: 180,
		primitiveLock: true,
		addIntoBom: false,
		designator: 'R2',
		manufacturerId: 'M-2',
		otherProperty: { Value: '22k' },
	} });
	assert.equal(modified.ok, true);
	assert.equal(modified.verified, true);
	assert.equal(modified.before.designator, 'R1');
	assert.equal(modified.after.designator, 'R2');
	assert.equal(modified.after.addIntoBom, false);
	assert.deepEqual(modified.after.otherProperty, { Value: '22k', Datasheet: 'https://example.test/r' });
	assert.deepEqual(parts.get('r1').otherProperty, { Value: '22k', Datasheet: 'https://example.test/r' });
	const missing = await handlePcbComponentEditTask({ action: 'modify', primitiveId: 'wrong-page', property: { x: 20 } });
	assert.equal(missing.reason, 'component_not_found');
	const deleted = await handlePcbComponentEditTask({ action: 'delete', primitiveId: 'new-1' });
	assert.deepEqual([deleted.ok, deleted.deleted, deleted.verified], [true, true, true]);
	assert.equal((await handlePcbComponentEditTask({ action: 'delete', primitiveId: 'new-1' })).reason, 'component_not_found');

	const originalModify = api.modify;
	api.modify = async (id, patch) => {
		await originalModify(id, patch);
		const state = parts.get(id);
		state.rotation = ((state.rotation % 360) + 360) % 360;
	};
	for (const [requested, actual] of [[-90, 270], [360, 0], [720, 0], [-450, 270]]) {
		const rotated = await toSerializableAsync(await handlePcbComponentEditTask({ action: 'modify', primitiveId: 'r1', property: { x: 155, rotation: requested } }));
		assert.equal(rotated.ok, true, `equivalent rotation ${requested}`);
		assert.equal(rotated.verified, true);
		assert.equal(rotated.after.rotation, actual);
		assert.equal(rotated.after.x, 155);
		assert.equal(rotated.normalization.rotation.mode, 'modulo_360');
	}
	api.modify = async (id, patch) => {
		await originalModify(id, patch);
		parts.get(id).rotation = 90;
	};
	const wrongOrientation = await handlePcbComponentEditTask({ action: 'modify', primitiveId: 'r1', property: { rotation: -90 } });
	assert.equal(wrongOrientation.ok, false);
	assert.equal(wrongOrientation.commitUnknown, true);
	assert.equal(wrongOrientation.after.rotation, 90);
	assert.equal(wrongOrientation.mismatches[0].field, 'rotation');
	api.modify = originalModify;
	parts.get('r1').otherProperty['LCSC Part Name'] = 'old part';
	api.modify = async (id, patch) => {
		const oldName = parts.get(id).otherProperty['LCSC Part Name'];
		await originalModify(id, patch);
		parts.get(id).otherProperty['LCSC Part Name'] = oldName;
	};
	const partial = await toSerializableAsync(await handlePcbComponentEditTask({ action: 'modify', primitiveId: 'r1', property: {
		manufacturerId: 'AOD2610E',
		supplierId: 'C282428',
		otherProperty: { 'Device': 'AOD2610E', 'LCSC Part Name': 'new part' },
	} }));
	assert.equal(partial.ok, false);
	assert.equal(partial.reason, 'post_write_readback_failed');
	assert.equal(partial.failureKind, 'state_mismatch');
	assert.equal(partial.nativeCallSettled, true);
	assert.equal(partial.after.manufacturerId, 'AOD2610E');
	assert.equal(partial.after.otherProperty.Device, 'AOD2610E');
	assert.deepEqual(partial.mismatches, [{ field: 'otherProperty.LCSC Part Name', requested: 'new part', actual: 'old part', unchanged: true, requestedField: true }]);
	assert.equal(partial.mismatchCount, 1);
	assert.equal(partial.mismatchesComplete, true);
	assert.equal(requiresHostRestartForResult(path, { action: 'modify' }, partial), false, 'settled partial metadata write needs readback, not a host restart');
	api.modify = originalModify;

	api.modify = async () => {
		throw new Error('RPC call timed out');
	};
	const timedOut = await handlePcbComponentEditTask({ action: 'modify', primitiveId: 'r1', property: { x: 10 } });
	assert.deepEqual([timedOut.commitUnknown, timedOut.readbackRequired, timedOut.nativeCallSettled], [true, true, false]);
	assert.equal(requiresHostRestartForResult(path, { action: 'modify' }, timedOut), true);
	api.modify = originalModify;
	const getBeforeReadbackFailure = api.get;
	let getCalls = 0;
	api.get = async (id) => {
		getCalls += 1;
		if (getCalls === 1)
			return getBeforeReadbackFailure(id);
		throw new Error('post-write read unavailable');
	};
	const unreadable = await handlePcbComponentEditTask({ action: 'modify', primitiveId: 'r1', property: { x: 25 } });
	assert.deepEqual([unreadable.commitUnknown, unreadable.readbackRequired, unreadable.nativeCallSettled], [true, true, true]);
	api.get = getBeforeReadbackFailure;
	api.modify = async (id, patch) => {
		Object.assign(parts.get(id), patch);
		pageUuid = 'pcb-2';
	};
	const switched = await handlePcbComponentEditTask({ action: 'modify', primitiveId: 'r1', property: { y: 35 } });
	assert.equal(switched.commitUnknown, true);
	assert.equal(switched.nativeCallSettled, true);
	pageUuid = 'pcb-1';
	api.modify = originalModify;
	const originalCreate = api.create;
	api.create = async (...args) => {
		const result = await originalCreate(...args);
		const state = parts.get(result.getState_PrimitiveId());
		state.rotation = ((state.rotation % 360) + 360) % 360;
		return primitive(state);
	};
	const normalizedCreate = await handlePcbComponentEditTask({ action: 'create', source: { kind: 'device', libraryUuid: 'devices', uuid: 'device-4' }, layer: 1, x: 10, y: 20, rotation: -90 });
	assert.equal(normalizedCreate.ok, true);
	assert.equal(normalizedCreate.after.rotation, 270);
	assert.equal(normalizedCreate.normalization.rotation.mode, 'modulo_360');
	api.create = originalCreate;
	api.create = async () => {
		throw new Error('WebSocket connection closed');
	};
	const unknownCreate = await handlePcbComponentEditTask({ action: 'create', source: { kind: 'device', libraryUuid: 'devices', uuid: 'device-3' }, layer: 1, x: 30, y: 40 });
	assert.equal(unknownCreate.commitUnknown, true);
	assert.equal(unknownCreate.nativeCallSettled, false);
	assert.equal(unknownCreate.beforeComponentIds.length, parts.size);
	assert.equal(requiresHostRestartForResult(path, { action: 'create' }, unknownCreate), true);
	api.create = originalCreate;
	console.log('PCB component edit tests passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
