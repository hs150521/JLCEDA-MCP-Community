const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ moduleResolution: 'node' });
require('ts-node/register/transpile-only');

const { handleAutoLayoutTask } = require('../src/mcp/auto-layout-handler.ts');
const { handleAutoRoutingTask } = require('../src/mcp/auto-routing-handler.ts');
const { handleComponentPlaceAutoTask } = require('../src/mcp/component-place-auto-handler.ts');
const { handleNetLabelModifyTask } = require('../src/mcp/netlabel-modify-handler.ts');
const { createNetLabelWithTimeout, detectNetLabelKind, findPin, handleNetLabelPlaceTask } = require('../src/mcp/netlabel-place-handler.ts');
const { shouldLogTransportMessage } = require('../src/runtime/bridge-transport.ts');
const { BridgeTaskQuarantine, BridgeTaskTimeoutError, resolveBridgeTaskTimeoutMs, startTimedTask } = require('../src/runtime/task-timeout.ts');

for (const name of ['UART_TX', 'SPI_CLK', 'BLUE_LED_DATA']) {
	assert.equal(detectNetLabelKind(name), 'NetLabel', `${name} must use an ordinary net label`);
}
for (const name of ['VCC', '+5V', 'FIELD_12V', '3V3']) {
	assert.equal(detectNetLabelKind(name), 'Power', `${name} must use a power net flag`);
}
assert.equal(detectNetLabelKind('GND'), 'Ground');
assert.equal(detectNetLabelKind('AGND'), 'AnalogGround');
assert.equal(detectNetLabelKind('PE'), 'ProtectGround');

const sdkPin = {
	getState_PinNumber: () => '1',
	getState_PinName: () => 'TX',
	getState_X: () => 320,
	getState_Y: () => 240,
	getState_Rotation: () => 180,
	getState_PinLength: () => 20,
};
assert.deepEqual(findPin([sdkPin], '1'), {
	x: 320,
	y: 240,
	rotation: 180,
	pinLength: 20,
	pinNumber: '1',
	pinName: 'TX',
});

async function main() {
	assert.equal(shouldLogTransportMessage('bridge/heartbeat'), false);
	assert.equal(shouldLogTransportMessage('bridge/result'), true);
	assert.equal(resolveBridgeTaskTimeoutMs('/bridge/jlceda/api/invoke', { timeoutMs: 42000 }), 42000);
	assert.equal(resolveBridgeTaskTimeoutMs('/bridge/jlceda/api/invoke', {}), 15000);
	assert.throws(
		() => resolveBridgeTaskTimeoutMs('/bridge/jlceda/api/invoke', { timeoutMs: 999 }),
		/timeoutMs/,
	);

	let resolveBackgroundTask;
	const backgroundTask = new Promise((resolve) => {
		resolveBackgroundTask = resolve;
	});
	const timedTask = startTimedTask(backgroundTask, '/bridge/jlceda/component/place-auto', 10);
	await assert.rejects(timedTask.result, BridgeTaskTimeoutError);
	let backgroundSettled = false;
	void timedTask.settled.then(() => {
		backgroundSettled = true;
	});
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(backgroundSettled, false, 'timed-out task must remain unsettled until its handler finishes');
	assert.equal(backgroundSettled, false, 'a timed-out mutation must keep its serialization barrier until it settles');
	const quarantine = new BridgeTaskQuarantine();
	quarantine.enter('/bridge/jlceda/component/place-auto', timedTask.settled);
	assert.equal(quarantine.getActive().path, '/bridge/jlceda/component/place-auto', 'timed-out mutations must quarantine the bridge client');
	resolveBackgroundTask('late result');
	await timedTask.settled;
	assert.equal(backgroundSettled, true);
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(quarantine.getActive(), undefined, 'the bridge client must recover after the original mutation settles');

	await assert.rejects(
		createNetLabelWithTimeout(new Promise(() => {}), 'UART_TX', 10),
		/createNetLabel alpha API timed out/,
	);

	const createNetLabelCalls = [];
	const regionCalls = [];
	const modifyCalls = [];
	const netFlag = {
		net: 'FIELD_12V',
		getState_PrimitiveType: () => 'Component',
		getState_ComponentType: () => 'netflag',
		getState_PrimitiveId: () => 'flag-1',
		getState_X: () => 320,
		getState_Y: () => 240,
		getState_Net() {
			return this.net;
		},
		setState_Net(net) {
			this.net = net;
			return this;
		},
		async done() {
			return this;
		},
	};
	globalThis.eda = {
		sch_PrimitiveAttribute: {
			createNetLabel: async (...args) => {
				createNetLabelCalls.push(args);
				return { primitiveId: 'label-1' };
			},
			get: async primitiveId => primitiveId === 'flag-1'
				? undefined
				: { getState_Value: () => 'UART_TX' },
			modify: async (...args) => {
				modifyCalls.push(args);
				return true;
			},
		},
		sch_PrimitiveComponent: {
			createNetFlag: async () => ({ primitiveId: 'flag-1' }),
			getAllPinsByPrimitiveId: async () => [sdkPin],
			get: async primitiveId => primitiveId === 'flag-1' ? netFlag : undefined,
		},
		sch_Document: {
			getPrimitivesInRegion: (...args) => {
				regionCalls.push(args);
				return [{
					getState_PrimitiveType: () => 'Attribute',
					getState_PrimitiveId: () => 'label-1',
					getState_X: () => 320,
					getState_Y: () => 240,
				}];
			},
		},
	};

	const placed = await handleNetLabelPlaceTask({
		placements: [{ componentId: 'component-1', pinIdentifier: '1', netName: 'UART_TX' }],
	});
	assert.equal(placed.ok, true);
	assert.deepEqual(createNetLabelCalls, [[320, 240, 'UART_TX']]);

	const modified = await handleNetLabelModifyTask({
		target: { type: 'pin', componentId: 'component-1', pinIdentifier: '1' },
		newNetName: 'SPI_CLK',
	});
	assert.equal(modified.ok, true);
	assert.deepEqual(regionCalls, [[290, 350, 210, 270]]);
	assert.equal(modifyCalls[0][0], 'label-1');

	const modifiedFlagById = await handleNetLabelModifyTask({
		target: { type: 'primitiveId', primitiveId: 'flag-1' },
		newNetName: 'FIELD_5V',
	});
	assert.equal(modifiedFlagById.ok, true);
	assert.equal(modifiedFlagById.kind, 'netFlag');
	assert.equal(netFlag.net, 'FIELD_5V');

	globalThis.eda.sch_Document.getPrimitivesInRegion = (...args) => {
		regionCalls.push(args);
		return [netFlag];
	};
	const modifiedFlagByPin = await handleNetLabelModifyTask({
		target: { type: 'pin', componentId: 'component-1', pinIdentifier: '1' },
		newNetName: 'FIELD_12V',
	});
	assert.equal(modifiedFlagByPin.ok, true);
	assert.equal(modifiedFlagByPin.kind, 'netFlag');
	assert.equal(netFlag.net, 'FIELD_12V');

	let autoLayoutCalls = 0;
	let autoRoutingCalls = 0;
	globalThis.eda.sch_Document.autoLayout = async () => {
		autoLayoutCalls += 1;
		return true;
	};
	globalThis.eda.sch_Document.autoRouting = async () => {
		autoRoutingCalls += 1;
		return true;
	};
	const emptyLayout = await handleAutoLayoutTask({ uuids: [] });
	const emptyRouting = await handleAutoRoutingTask({ uuids: [] });
	assert.equal(emptyLayout.ok, false);
	assert.equal(emptyRouting.ok, false);
	assert.equal(autoLayoutCalls, 0);
	assert.equal(autoRoutingCalls, 0);

	globalThis.eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId = async () => [];
	const failed = await handleNetLabelPlaceTask({
		placements: [{ componentId: 'missing', pinIdentifier: '1', netName: 'UART_TX' }],
	});
	assert.equal(failed.ok, false);
	assert.equal(failed.failureCount, 1);

	const autoPlacementCalls = [];
	globalThis.eda.sch_PrimitiveComponent.create = async (...args) => {
		autoPlacementCalls.push(args);
		return { primitiveId: `auto-${autoPlacementCalls.length}` };
	};
	const partialCoordinates = await handleComponentPlaceAutoTask({
		components: [
			{ uuid: 'x-only', libraryUuid: 'test-library', x: 111 },
			{ uuid: 'y-only', libraryUuid: 'test-library', y: 222 },
		],
		layoutStrategy: 'grid',
		gridLayout: { startX: 10, startY: 20, spacingX: 100, spacingY: 200, columns: 4 },
	});
	assert.equal(partialCoordinates.ok, true);
	assert.deepEqual(autoPlacementCalls.map(call => call.slice(1, 3)), [[111, 20], [110, 222]]);

	globalThis.eda.sch_PrimitiveComponent.create = async () => undefined;
	const autoPlacement = await handleComponentPlaceAutoTask({
		components: [{ uuid: 'missing-device', libraryUuid: 'test-library', x: 10, y: 20 }],
		layoutStrategy: 'fixed',
	});
	assert.equal(autoPlacement.ok, false);
	assert.equal(autoPlacement.placedCount, 0);
	assert.equal(autoPlacement.failedCount, 1);
}

main().then(() => {
	process.stdout.write('Net label handler tests passed\n');
}).catch((error) => {
	process.stderr.write(`${error.stack || error}\n`);
	process.exitCode = 1;
});
