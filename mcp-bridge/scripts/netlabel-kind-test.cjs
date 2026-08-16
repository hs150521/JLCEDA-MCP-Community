const assert = require('node:assert/strict');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ moduleResolution: 'node' });
require('ts-node/register/transpile-only');

const { detectNetLabelKind, findPin, handleNetLabelPlaceTask } = require('../src/mcp/netlabel-place-handler.ts');
const { handleNetLabelModifyTask } = require('../src/mcp/netlabel-modify-handler.ts');
const { handleComponentPlaceAutoTask } = require('../src/mcp/component-place-auto-handler.ts');

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
	const createNetLabelCalls = [];
	const regionCalls = [];
	const modifyCalls = [];
	globalThis.eda = {
		sch_PrimitiveComponent: {
			getAllPinsByPrimitiveId: async () => [sdkPin],
		},
		sch_PrimitiveAttribute: {
			createNetLabel: async (...args) => {
				createNetLabelCalls.push(args);
				return { primitiveId: 'label-1' };
			},
			get: async () => ({ value: 'UART_TX' }),
			modify: async (...args) => {
				modifyCalls.push(args);
				return true;
			},
		},
		sch_PrimitiveComponent: {
			createNetFlag: async () => ({ primitiveId: 'flag-1' }),
			getAllPinsByPrimitiveId: async () => [sdkPin],
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

	globalThis.eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId = async () => [];
	const failed = await handleNetLabelPlaceTask({
		placements: [{ componentId: 'missing', pinIdentifier: '1', netName: 'UART_TX' }],
	});
	assert.equal(failed.ok, false);
	assert.equal(failed.failureCount, 1);

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
