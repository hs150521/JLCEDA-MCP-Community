const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');

const { handleApiInvokeTask } = require('../src/mcp/invoke-handler.ts');
const { handleSchematicReadTask } = require('../src/mcp/schematic-read-handler.ts');
const { toSerializable } = require('../src/utils.ts');

const existingComponent = {
	getState_PrimitiveId: () => 'old-page-component',
	getState_Designator: () => 'R1',
	getState_Net: () => '',
	getState_Name: () => 'Resistor',
	getState_SubPartName: () => '',
};
const copiedPageUuid = '4b381791f8233c92';

let currentPage = 'P1';
globalThis.eda = {
	dmt_Schematic: {
		async getCurrentSchematicPageInfo() { return { uuid: currentPage }; },
		async createSchematicPage() {
			currentPage = 'P2';
			return 'P2';
		},
		async copySchematicPage() {
			currentPage = copiedPageUuid;
			return copiedPageUuid;
		},
	},
	dmt_SelectControl: { async getCurrentDocumentInfo() { return { uuid: currentPage }; } },
	dmt_EditorControl: {
		async openDocument(pageUuid) {
			currentPage = pageUuid;
			return true;
		},
		async activateDocument(pageUuid) {
			currentPage = pageUuid;
			return true;
		},
	},
	sch_PrimitiveComponent: {
		async getAll(_componentType, allSchematicPages) {
			return currentPage === 'P1' || currentPage === copiedPageUuid || allSchematicPages ? [existingComponent] : [];
		},
		async getAllPrimitiveId(componentType, allSchematicPages) {
			assert.equal(componentType, undefined);
			return (await this.getAll(undefined, allSchematicPages)).map(component => component.getState_PrimitiveId());
		},
		async getAllPinsByPrimitiveId() {
			return [{
				getState_PinNumber: () => '1',
				getState_PinName: () => 'A',
				getState_PinType: () => 'passive',
				getState_X: () => 0,
				getState_Y: () => 0,
				getState_NoConnected: () => false,
			}];
		},
	},
	sch_PrimitiveWire: {
		async getAll() { return []; },
		async getAllPrimitiveId() { return (await this.getAll()).map(wire => wire.getState_PrimitiveId()); },
	},
	sch_PrimitiveAttribute: { async getAll() { return []; } },
	sch_Drc: { async check() { return true; } },
};

async function readCount() {
	const result = await handleSchematicReadTask({});
	assert.equal(result.ok, true);
	return JSON.parse(result.schematicCircuitSnapshot).componentCount;
}

async function main() {
	const originalGetAll = globalThis.eda.sch_PrimitiveComponent.getAll;
	const originalGetAllIds = globalThis.eda.sch_PrimitiveComponent.getAllPrimitiveId;
	assert.equal(await readCount(), 1);
	await handleApiInvokeTask({ apiFullName: 'eda.dmt_Schematic.copySchematicPage', args: ['P1', 'schematic-1'] });
	const copiedPage = await handleSchematicReadTask({});
	assert.equal(copiedPage.ok, true, 'a copied page may legitimately retain its source component IDs');
	assert.equal(copiedPage.pageUuid, copiedPageUuid);
	assert.equal(JSON.parse(copiedPage.schematicCircuitSnapshot).componentCount, 1);
	currentPage = 'P1';
	await handleApiInvokeTask({ apiFullName: 'eda.dmt_Schematic.createSchematicPage', args: ['schematic-1'] });
	globalThis.eda.sch_PrimitiveComponent.getAll = async () => [existingComponent];
	globalThis.eda.sch_PrimitiveComponent.getAllPrimitiveId = async () => [];
	await handleApiInvokeTask({ apiFullName: 'eda.dmt_EditorControl.activateDocument', args: ['P2'] });
	const firstRead = await handleSchematicReadTask({});
	assert.equal(firstRead.errorCode, 'PAGE_NOT_READY', 'first read after creating and activating P2 must reject a component list that disagrees with its current IDs');
	globalThis.eda.sch_PrimitiveComponent.getAll = originalGetAll;
	globalThis.eda.sch_PrimitiveComponent.getAllPrimitiveId = originalGetAllIds;
	currentPage = 'P1';
	const anotherOldComponent = { ...existingComponent, getState_PrimitiveId: () => 'old-page-component-2' };
	globalThis.eda.sch_PrimitiveComponent.getAll = async () => [anotherOldComponent];
	globalThis.eda.sch_PrimitiveComponent.getAllPrimitiveId = async () => [];
	await handleApiInvokeTask({ apiFullName: 'eda.dmt_EditorControl.openDocument', args: ['P3'] });
	const firstReadAfterOpen = await handleSchematicReadTask({});
	assert.equal(firstReadAfterOpen.errorCode, 'PAGE_NOT_READY', 'first read after opening P3 must reject a component list that disagrees with its current IDs');
	globalThis.eda.sch_PrimitiveComponent.getAll = originalGetAll;
	globalThis.eda.sch_PrimitiveComponent.getAllPrimitiveId = originalGetAllIds;
	currentPage = 'P1';
	assert.equal(await readCount(), 1);
	// A copied page legitimately reuses source primitive IDs; consistent current-page APIs must remain readable.
	const originalWireGetAll = globalThis.eda.sch_PrimitiveWire.getAll;
	const sharedWire = {
		getState_PrimitiveId: () => 'shared-wire',
		getState_Line: () => [100, 100, 200, 100],
		getState_Net: () => '',
	};
	globalThis.eda.sch_PrimitiveWire.getAll = async () => [sharedWire];
	globalThis.eda.sch_PrimitiveComponent.getAll = async type => type ? [] : [existingComponent];
	globalThis.eda.sch_PrimitiveComponent.getAllPrimitiveId = async () => ['old-page-component'];
	assert.equal((await handleSchematicReadTask({ includeConnectivityPrimitives: true })).ok, true);
	await handleApiInvokeTask({ apiFullName: 'eda.dmt_EditorControl.activateDocument', args: ['P4'] });
	const copiedConnectivityPage = await handleSchematicReadTask({ includeConnectivityPrimitives: true });
	assert.equal(copiedConnectivityPage.ok, true, JSON.stringify(copiedConnectivityPage));
	assert.equal(copiedConnectivityPage.pageUuid, 'P4');
	assert.equal(JSON.parse(copiedConnectivityPage.schematicCircuitSnapshot).componentCount, 1);
	assert.equal(JSON.parse(copiedConnectivityPage.connectivityPrimitivesSnapshot).wireCount, 1);
	const originalWireGetAllIds = globalThis.eda.sch_PrimitiveWire.getAllPrimitiveId;
	globalThis.eda.sch_PrimitiveWire.getAll = async () => [sharedWire, sharedWire];
	globalThis.eda.sch_PrimitiveWire.getAllPrimitiveId = async () => ['shared-wire', 'other-wire'];
	const duplicateWireObjects = await handleSchematicReadTask({ includeConnectivityPrimitives: true });
	assert.equal(duplicateWireObjects.errorCode, 'PAGE_NOT_READY', 'duplicate wire objects must not match distinct current-page IDs');
	globalThis.eda.sch_PrimitiveWire.getAll = async () => [sharedWire];
	globalThis.eda.sch_PrimitiveWire.getAllPrimitiveId = async () => ['shared-wire', 'shared-wire'];
	const duplicateWireIds = await handleSchematicReadTask({ includeConnectivityPrimitives: true });
	assert.equal(duplicateWireIds.errorCode, 'PAGE_NOT_READY', 'duplicate ID list entries must not match current-page wire objects');
	globalThis.eda.sch_PrimitiveComponent.getAll = originalGetAll;
	globalThis.eda.sch_PrimitiveComponent.getAllPrimitiveId = originalGetAllIds;
	globalThis.eda.sch_PrimitiveWire.getAll = originalWireGetAll;
	globalThis.eda.sch_PrimitiveWire.getAllPrimitiveId = originalWireGetAllIds;
	currentPage = 'P2';
	const emptyPage = await handleSchematicReadTask({});
	assert.equal(emptyPage.ok, true);
	assert.equal(emptyPage.pageUuid, 'P2');
	assert.equal(JSON.parse(emptyPage.schematicCircuitSnapshot).componentCount, 0, 'a newly opened empty page must not include earlier-page components');
	const emptyFullPage = await handleSchematicReadTask({ includeConnectivityPrimitives: true });
	assert.equal(emptyFullPage.ok, true);
	assert.equal(JSON.parse(emptyFullPage.connectivityPrimitivesSnapshot).pageUuid, 'P2');
	const currentPageGetAll = globalThis.eda.sch_PrimitiveComponent.getAll;
	const currentPageIds = globalThis.eda.sch_PrimitiveComponent.getAllPrimitiveId;
	globalThis.eda.sch_PrimitiveComponent.getAll = async type => type === 'netport'
		? [{
				getState_PrimitiveId: () => 'stale-port',
				getState_Net: () => 'OLD',
				getState_X: () => 0,
				getState_Y: () => 0,
			}]
		: [];
	const stalePort = await handleSchematicReadTask({ includeConnectivityPrimitives: true });
	assert.equal(stalePort.errorCode, 'PAGE_NOT_READY', 'filtered NetPort read must agree with the current-page component list');
	globalThis.eda.sch_PrimitiveComponent.getAll = async () => [existingComponent];
	globalThis.eda.sch_PrimitiveComponent.getAllPrimitiveId = async () => [];
	for (const payload of [{}, { includeConnectivityPrimitives: true }]) {
		const stale = await handleSchematicReadTask(payload);
		assert.equal(stale.ok, false);
		assert.equal(stale.errorCode, 'PAGE_NOT_READY', 'stale old-page components must not be accepted as P2');
		assert.equal(stale.reason, 'page_not_ready');
	}
	globalThis.eda.sch_PrimitiveComponent.getAllPrimitiveId = currentPageIds;
	const currentPagePins = globalThis.eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId;
	globalThis.eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId = async () => [];
	const frame = { ...existingComponent, getState_PrimitiveId: () => 'frame-1', getState_Designator: () => 'FRAME1' };
	globalThis.eda.sch_PrimitiveComponent.getAll = async () => [frame];
	const zeroPinPage = await handleSchematicReadTask({});
	assert.equal(zeroPinPage.ok, true, 'a legitimate current-page zero-pin component must remain readable');
	assert.equal(zeroPinPage.pageUuid, 'P2');
	globalThis.eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId = currentPagePins;
	globalThis.eda.sch_PrimitiveComponent.getAll = currentPageGetAll;
	globalThis.eda.dmt_SelectControl.getCurrentDocumentInfo = async () => ({ uuid: 'P1' });
	assert.equal((await handleSchematicReadTask({})).errorCode, 'PAGE_NOT_READY', 'document and page UUID mismatch must fail');
	for (const payload of [{}, { includeConnectivityPrimitives: true }]) {
		globalThis.eda.dmt_SelectControl.getCurrentDocumentInfo = (() => {
			let calls = 0;
			return async () => ({ uuid: ++calls === 1 ? 'P2' : 'P3' });
		})();
		assert.equal((await handleSchematicReadTask(payload)).errorCode, 'PAGE_NOT_READY', 'document switch during read must fail');
	}
	globalThis.eda.dmt_SelectControl.getCurrentDocumentInfo = async () => ({ uuid: currentPage });

	let portX = 0;
	let pinX = 100;
	let pinY = 100;
	const netPort = {
		getState_PrimitiveId: () => 'net-port',
		getState_Designator: () => '',
		getState_Net: () => 'SIG',
		getState_X: () => portX,
		getState_Y: () => 0,
	};
	const netFlag = {
		getState_PrimitiveId: () => 'net-flag',
		getState_Designator: () => '',
		getState_Net: () => 'PWR',
		getState_X: () => 20,
		getState_Y: () => 30,
	};
	const device = {
		getState_PrimitiveId: () => 'device',
		getState_Designator: () => 'U1',
		getState_Net: () => '',
		getState_Name: () => 'Device',
		getState_SubPartName: () => '',
	};
	globalThis.eda.sch_PrimitiveComponent.getAll = async () => [netPort, device];
	globalThis.eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId = async (id) => {
		if (id !== 'device')
			return [];
		const pin = {
			getState_PrimitiveId: () => 'device-pin-1',
			getState_Rotation: () => 180,
			getState_PinNumber: () => '1',
			getState_PinName: () => 'IN',
			getState_PinType: () => 'input',
			getState_X: () => pinX,
			getState_Y: () => pinY,
			getState_NoConnected: () => false,
		};
		return [pin, { ...pin, getState_PrimitiveId: () => 'device-pin-2', getState_PinNumber: () => '2', getState_X: () => 2000, getState_Y: () => 2000, getState_NoConnected: () => undefined }];
	};
	globalThis.eda.sch_PrimitiveWire.getAll = async () => [{
		getState_Line: () => [0, 0, 100, 0, 100, 0, 100, 100],
		getState_Net: () => '',
	}];
	const result = await handleSchematicReadTask({});
	assert.equal(result.ok, true);
	const snapshot = JSON.parse(result.schematicCircuitSnapshot);
	const inspectedPin = snapshot.components.find(component => component.componentInstanceId === 'device').pins[0];
	assert.deepEqual([inspectedPin.pinId, inspectedPin.x, inspectedPin.y, inspectedPin.rotation, inspectedPin.noConnected], ['device-pin-1', pinX, pinY, 180, false], 'complete readback keeps native pin identity, geometry and NC');
	const unmarkedPin = snapshot.components.find(component => component.componentInstanceId === 'device').pins[1];
	assert.equal(unmarkedPin.noConnected, false, 'an existing SDK getter returning undefined means the ordinary unmarked NC state');
	assert.equal(unmarkedPin.hasNoConnectMark, false);
	const completePinRead = globalThis.eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId;
	globalThis.eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId = async id => (await completePinRead(id)).map((pin) => {
		const { getState_NoConnected: _ncGetter, ...withoutGetter } = pin;
		return withoutGetter;
	});
	const missingNcSnapshot = JSON.parse((await handleSchematicReadTask({})).schematicCircuitSnapshot);
	assert.equal(missingNcSnapshot.components.find(component => component.componentInstanceId === 'device').pins[1].noConnected, null, 'missing getters remain a recovery capability failure');
	globalThis.eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId = completePinRead;
	assert.deepEqual(snapshot.networks.find(network => network.networkName === 'SIG').connectedPinRefs, ['SIG.1', 'U1.1']);
	portX = 50;
	const portMidpoint = JSON.parse((await handleSchematicReadTask({})).schematicCircuitSnapshot);
	assert.deepEqual(portMidpoint.networks.find(network => network.networkName === 'SIG').connectedPinRefs, ['SIG.1', 'U1.1'], 'NetPort on an unnamed wire midpoint must name the connected pin');
	portX = 0;
	pinY = 50;
	const pinMidpoint = JSON.parse((await handleSchematicReadTask({})).schematicCircuitSnapshot);
	assert.deepEqual(pinMidpoint.networks.find(network => network.networkName === 'SIG').connectedPinRefs, ['SIG.1', 'U1.1'], 'pin on an unnamed wire midpoint must inherit the NetPort name');
	// A branch endpoint on a trunk midpoint is a normal T junction, even with no pin at the junction.
	pinX = 50;
	pinY = 100;
	globalThis.eda.sch_PrimitiveWire.getAll = async () => [
		{ getState_Line: () => [0, 0, 100, 0], getState_Net: () => '' },
		{ getState_Line: () => [50, 0, 50, 100], getState_Net: () => '' },
	];
	const tJunction = JSON.parse((await handleSchematicReadTask({})).schematicCircuitSnapshot);
	assert.deepEqual(tJunction.networks.find(network => network.networkName === 'SIG').connectedPinRefs, ['SIG.1', 'U1.1'], 'a T junction must carry a NetPort name through the branch to its pin');

	const wires = Array.from({ length: 121 }, (_, index) => ({
		getState_PrimitiveId: () => `wire-${index}`,
		getState_Line: () => [index * 20, 0, index * 20 + 10, 0],
		getState_Net: () => index === 0 ? 'SIG' : undefined,
	}));
	const label = {
		getState_PrimitiveId: () => 'label-1',
		getState_Key: () => 'NET',
		getState_ParentPrimitiveId: () => 'wire-0',
		getState_Value: () => 'SIG',
		getState_X: () => 5,
		getState_Y: () => 0,
	};
	globalThis.eda.sch_PrimitiveWire.getAll = async () => wires;
	globalThis.eda.sch_PrimitiveComponent.getAll = async type => type === 'netport'
		? [{
				getState_PrimitiveId: () => 'net-port',
				getState_Net: () => 'SIG',
				getState_X: () => 0,
				getState_Y: () => 0,
			}]
		: type === 'netflag' ? [netFlag] : [netPort, device, netFlag];
	globalThis.eda.sch_PrimitiveAttribute.getAll = async () => [label];
	const completeReadback = await handleSchematicReadTask({ includeConnectivityPrimitives: true });
	assert.equal(completeReadback.ok, true);
	const serialized = toSerializable(completeReadback);
	const primitiveSnapshot = JSON.parse(serialized.connectivityPrimitivesSnapshot);
	assert.equal(primitiveSnapshot.pageUuid, 'P2');
	assert.equal(primitiveSnapshot.wireCount, 121, 'recovery must retain more than the normal 120-item serialization cap');
	assert.equal(primitiveSnapshot.wires.length, 121);
	assert.deepEqual(primitiveSnapshot.wires[120].line, [2400, 0, 2410, 0]);
	assert.deepEqual(primitiveSnapshot.netPorts, [{ primitiveId: 'net-port', net: 'SIG', x: 0, y: 0 }]);
	assert.equal(primitiveSnapshot.netFlagCount, 1);
	assert.deepEqual(primitiveSnapshot.netFlags, [{ primitiveId: 'net-flag', net: 'PWR', x: 20, y: 30 }]);
	assert.deepEqual(primitiveSnapshot.netLabels, [{ primitiveId: 'label-1', parentWireId: 'wire-0', net: 'SIG', x: 5, y: 0 }]);
	assert.equal(primitiveSnapshot.wires[1].net, '', 'unnamed wires may return undefined net');
	assert.equal(completeReadback.schematicCircuitSnapshot !== undefined, true);

	globalThis.eda.sch_PrimitiveComponent.getAll = async type => type === 'netport'
		? [{
				getState_PrimitiveId: () => 'net-port',
				getState_Net: () => undefined,
				getState_X: () => 0,
				getState_Y: () => 0,
			}]
		: type === 'netflag' ? [netFlag] : [netPort, device, netFlag];
	assert.equal((await handleSchematicReadTask({ includeConnectivityPrimitives: true })).ok, false, 'NetPort network must be readable');
	globalThis.eda.sch_PrimitiveComponent.getAll = async type => type === 'netport'
		? [{
				getState_PrimitiveId: () => 'net-port',
				getState_Net: () => 'SIG',
				getState_X: () => 0,
				getState_Y: () => 0,
			}]
		: type === 'netflag' ? [netFlag] : [netPort, device, netFlag];
	globalThis.eda.sch_PrimitiveComponent.getAll = async type => type === 'netflag'
		? [{ ...netFlag, getState_Net: () => undefined }]
		: type === 'netport' ? [netPort] : [netPort, device, netFlag];
	assert.equal((await handleSchematicReadTask({ includeConnectivityPrimitives: true })).ok, false, 'NetFlag network must be readable');
	globalThis.eda.sch_PrimitiveComponent.getAll = async type => type === 'netport'
		? [netPort]
		: type === 'netflag' ? [netFlag] : [netPort, device, netFlag];
	globalThis.eda.dmt_Schematic.getCurrentSchematicPageInfo = (() => {
		let calls = 0;
		return async () => ({ uuid: ++calls === 1 ? 'P2' : 'P3' });
	})();
	assert.equal((await handleSchematicReadTask({ includeConnectivityPrimitives: true })).ok, false, 'page switch during readback must fail');
	globalThis.eda.dmt_Schematic.getCurrentSchematicPageInfo = (() => {
		let calls = 0;
		return async () => ({ uuid: ++calls === 1 ? 'P2' : 'P3' });
	})();
	assert.equal((await handleSchematicReadTask({})).errorCode, 'PAGE_NOT_READY', 'page switch during ordinary read must fail');
	globalThis.eda.dmt_Schematic.getCurrentSchematicPageInfo = async () => ({ uuid: currentPage });
	globalThis.eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId = async () => undefined;
	assert.equal((await handleSchematicReadTask({ includeConnectivityPrimitives: true })).ok, false, 'failed pin read must not clear recovery');
	globalThis.eda.sch_PrimitiveWire.getAll = async () => undefined;
	assert.equal((await handleSchematicReadTask({})).ok, false, 'failed wire read must not produce a partial semantic snapshot');
	console.log('schematic_read current-page test passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
