const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');

function deferred() {
	let resolve;
	const promise = new Promise((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

let transport;
const ready = deferred();
class MockBridgeTransport {
	constructor(_url, _socket, clientId, _version, _context, callbacks) {
		this.clientId = clientId;
		this.callbacks = callbacks;
		this.waiters = new Map();
		transport = this;
	}

	async connect() {
		this.callbacks.onRoleChanged({ type: 'bridge/role', clientId: this.clientId, activeClientId: this.clientId, role: 'active', leaseTerm: 1 });
		ready.resolve();
	}

	completeTask(id, _lease, result, error) {
		// 模拟最终 WebSocket JSON 帧，保留真实运行时的序列化及写屏障。
		this.waiters.get(id).resolve(JSON.parse(JSON.stringify({ result, error })));
	}

	resultFor(id) {
		const waiter = deferred();
		this.waiters.set(id, waiter);
		return waiter.promise;
	}

	reportTaskStarted() {}
	refreshServerActivity() {}
	reportReady() {}
	updateContext() {}
	close() {}
}

require('../src/runtime/bridge-transport.ts').BridgeTransport = MockBridgeTransport;
const { startBridgeRuntime, stopBridgeRuntime, enqueueTask } = require('../src/runtime/bridge-runtime.ts');

function primitive(state) {
	return Object.fromEntries(Object.entries(state).map(([key, value]) => [`getState_${key[0].toUpperCase()}${key.slice(1)}`, () => value]));
}

async function main() {
	const component = {
		primitiveId: 'component-1',
		layer: 1,
		x: 100,
		y: 200,
		rotation: 0,
		primitiveLock: false,
		designator: 'Q1',
		component: { libraryUuid: 'devices', uuid: 'device-1' },
		footprint: { libraryUuid: 'footprints', uuid: 'footprint-1' },
		addIntoBom: true,
		name: 'MOSFET',
		uniqueId: 'unique-1',
		manufacturer: 'Maker',
		manufacturerId: 'old-part',
		supplier: 'LCSC',
		supplierId: 'old-supplier',
		otherProperty: { 'Device': 'old-part', 'LCSC Part Name': 'old-name' },
	};
	let componentWrites = 0;
	let viaDeletes = 0;
	let viaModifies = 0;
	let lineCreated = false;
	const vias = new Map([
		['via-1', { primitiveId: 'via-1', net: 'GND', x: 20, y: 0, holeDiameter: 19.6, diameter: 47.2, viaType: 0, primitiveLock: false }],
		['sample-via', { primitiveId: 'sample-via', net: 'GND', x: 20, y: 0, holeDiameter: 15.8, diameter: 31.4, viaType: 0, primitiveLock: false }],
		['child-via', { primitiveId: 'child-via', net: 'GND', x: 30, y: 0, holeDiameter: 10, diameter: 20, viaType: 0, primitiveLock: false }],
	]);
	globalThis.eda = {
		EDMT_EditorDocumentType: { SCHEMATIC_PAGE: 1, PCB: 3 },
		sys_Storage: { getExtensionUserConfig() {}, async setExtensionUserConfig() {} },
		sys_MessageBus: { subscribe() { return { running: () => true, cancel() {} }; }, publish() {} },
		sys_Message: { showToastMessage() {} },
		dmt_SelectControl: { async getCurrentDocumentInfo() { return { uuid: 'pcb-1', documentType: 3 }; } },
		dmt_Project: { async getCurrentProjectInfo() { return { uuid: 'project-1' }; } },
		dmt_Schematic: { async getCurrentSchematicPageInfo() {} },
		dmt_Pcb: { async getCurrentPcbInfo() { return { uuid: 'pcb-1' }; } },
		pcb_Net: {
			async getAllNets() { return [{ net: 'GND' }]; },
			async getAllPrimitivesByNet() {
				return [...vias.keys()].map(id => ({ globalIndex: id, pcbItemPrimitiveType: 'Via', ...(id === 'child-via' ? { parentId: 'component-1' } : {}) }));
			},
		},
		pcb_Layer: { async getAllLayers() { return [{ id: 1, type: 'SIGNAL', layerStatus: 1, locked: false }]; } },
		pcb_PrimitiveLine: {
			async create() {
				lineCreated = true;
				return primitive({ primitiveId: 'replaced-line' });
			},
			async get() {},
			async getAll(net, layer) {
				assert.deepEqual([net, layer], ['GND', 1]);
				if (!lineCreated)
					return [];
				return [
					primitive({ primitiveId: 'split-1', net, layer, startX: 0, startY: 0, endX: 10, endY: 0, lineWidth: 8 }),
					primitive({ primitiveId: 'split-2', net, layer, startX: 20, startY: 0, endX: 10, endY: 0, lineWidth: 8 }),
				];
			},
		},
		pcb_PrimitiveVia: {
			async create(_net, _x, _y, hole) { return primitive({ primitiveId: hole === 15.748 ? 'sample-via' : 'via-1' }); },
			async modify(id, property) {
				viaModifies += 1;
				Object.assign(vias.get(id), property, { holeDiameter: 15.8, diameter: 31.6 });
				return primitive(vias.get(id));
			},
			async get(id) { return vias.has(id) ? primitive(vias.get(id)) : undefined; },
			async getAll() { return [...vias.values()].map(primitive); },
			async delete(id) {
				viaDeletes += 1;
				return vias.delete(id);
			},
		},
		pcb_PrimitiveComponent: {
			async getAll() { return [primitive(component)]; },
			async getAllPrimitiveId() { return ['component-1']; },
			async get() { return primitive(component); },
			async modify(_id, property) {
				componentWrites += 1;
				const oldName = component.otherProperty['LCSC Part Name'];
				Object.assign(component, property);
				component.rotation = ((component.rotation % 360) + 360) % 360;
				component.otherProperty['LCSC Part Name'] = oldName;
			},
		},
	};
	globalThis.ESYS_ToastMessageType = { SUCCESS: 'success' };
	startBridgeRuntime();
	try {
		await Promise.race([ready.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('Bridge did not become ready')), 5000).unref())]);
		const submit = (id, path, payload) => {
			const result = transport.resultFor(id);
			enqueueTask({ requestId: id, path, payload, leaseTerm: 1 }, transport);
			return result;
		};
		const connectivityPath = '/bridge/jlceda/pcb/connectivity';
		const split = await submit('split', connectivityPath, { action: 'line_create', net: 'GND', layer: 1, startX: 0, startY: 0, endX: 20, endY: 0, lineWidth: 8 });
		assert.equal(split.error, undefined);
		assert.equal(split.result.ok, true);
		assert.deepEqual(split.result.primitiveIds, ['split-1', 'split-2']);
		assert.deepEqual(split.result.normalization.changedPrimitiveIds, ['split-1', 'split-2']);
		assert.equal(split.result.after.lines.length, 2);
		const via = await submit('via', connectivityPath, { action: 'via_create', net: 'GND', x: 20, y: 0, holeDiameter: 19.685, diameter: 47.244 });
		assert.equal(via.error, undefined, 'normalized lines must not block the next write');
		assert.equal(via.result.ok, true);
		assert.equal(via.result.normalization.holeDiameter.actual, 19.6);
		const sampleVia = await submit('sample-via-create', connectivityPath, { action: 'via_create', net: 'GND', x: 20, y: 0, holeDiameter: 15.748, diameter: 31.496 });
		assert.equal(sampleVia.error, undefined);
		assert.equal(sampleVia.result.ok, true);
		assert.deepEqual([sampleVia.result.after.holeDiameter, sampleVia.result.after.diameter], [15.8, 31.4]);
		assert.equal(sampleVia.result.normalization.holeDiameter.mode, 'round_0_2_mil');
		const routingPath = '/bridge/jlceda/pcb/routing-edit';
		const modifiedVia = await submit('sample-via-modify', routingPath, { action: 'modify', kind: 'via', primitiveId: 'sample-via', property: { holeDiameter: 15.7, diameter: 31.5 } });
		assert.equal(modifiedVia.error, undefined, '原生格点归一化创建不得隔离后续修改');
		assert.equal(modifiedVia.result.ok, true);
		assert.equal(modifiedVia.result.verified, true);
		assert.deepEqual([modifiedVia.result.primitive.holeDiameter, modifiedVia.result.primitive.diameter], [15.8, 31.6]);
		assert.deepEqual(modifiedVia.result.normalization, {
			kind: 'via_dimension_quantization',
			holeDiameter: { requested: 15.7, actual: 15.8, mode: 'round_0_2_mil' },
			diameter: { requested: 31.5, actual: 31.6, mode: 'round_0_2_mil' },
		});
		assert.equal(viaModifies, 1);

		const child = await submit('child-via', routingPath, { action: 'delete', kind: 'via', primitiveId: 'child-via' });
		assert.equal(child.error, undefined);
		assert.equal(child.result.reason, 'footprint_owned_via');
		assert.equal(child.result.applied, false);
		assert.equal(viaDeletes, 0);
		const standalone = await submit('delete-via', routingPath, { action: 'delete', kind: 'via', primitiveId: 'via-1' });
		assert.equal(standalone.error, undefined, 'rejected child deletion does not quarantine an unchanged board');
		assert.equal(standalone.result.ok, true);
		assert.equal(standalone.result.verificationScope, 'current_page_memory');
		assert.equal(standalone.result.durableDeletionVerified, false);
		assert.equal(viaDeletes, 1);
		const componentPath = '/bridge/jlceda/pcb/component-edit';
		const rotation = await submit('rotation', componentPath, { action: 'modify', primitiveId: 'component-1', property: { rotation: -90, x: 155 } });
		assert.equal(rotation.error, undefined, 'normalized via dimensions must not block the next write');
		assert.equal(rotation.result.ok, true);
		assert.equal(rotation.result.after.rotation, 270);
		const partial = await submit('metadata', componentPath, { action: 'modify', primitiveId: 'component-1', property: { manufacturerId: 'new-part', otherProperty: { 'Device': 'new-part', 'LCSC Part Name': 'new-name' } } });
		assert.equal(partial.error, undefined);
		assert.equal(partial.result.ok, false);
		assert.equal(partial.result.after.manufacturerId, 'new-part');
		assert.equal(partial.result.mismatches[0].field, 'otherProperty.LCSC Part Name');
		assert.equal(partial.result.mismatches[0].actual, 'old-name');
		assert.equal(partial.result.nativeCallSettled, true);
		const blocked = await submit('blocked', componentPath, { action: 'modify', primitiveId: 'component-1', property: { y: 300 } });
		assert.match(blocked.error.message, /readback|unknown|recover/i);
		assert.equal(componentWrites, 2, 'genuine metadata mismatch keeps the write gate');
		const readable = await submit('readable', componentPath, { action: 'read' });
		assert.equal(readable.error, undefined);
		assert.equal(readable.result.components[0].manufacturerId, 'new-part');
		console.log('PCB mutation normalization transport tests passed');
	}
	finally {
		stopBridgeRuntime();
		delete globalThis.eda;
		delete globalThis.ESYS_ToastMessageType;
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
