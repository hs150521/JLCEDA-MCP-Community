const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');

const { handleSchematicReadTask } = require('../src/mcp/schematic-read-handler.ts');
const { handleSchematicWireManageTask } = require('../src/mcp/schematic-wire-manage-handler.ts');
const { toSerializableAsync } = require('../src/utils.ts');

function fixture(point = false) {
	const wires = new Map([
		['target', { primitiveId: 'target', line: point ? [60, 10, 60, 10] : [60, 10, 80, 10], net: 'TEST_NET', color: null, lineWidth: null, lineType: null }],
		['other', { primitiveId: 'other', line: [200, 0, 300, 0], net: 'OTHER_NET', color: null, lineWidth: null, lineType: null }],
	]);
	let nativeCalls = 0;
	function primitive(wire) {
		return Object.fromEntries(Object.entries(wire).map(([field, value]) => [`getState_${field.charAt(0).toUpperCase()}${field.slice(1)}`, () => value]));
	}
	globalThis.eda = {
		dmt_Schematic: { async getCurrentSchematicPageInfo() { return { uuid: 'test-page' }; } },
		dmt_SelectControl: { async getCurrentDocumentInfo() { return { uuid: 'test-page' }; } },
		sch_PrimitiveComponent: {
			async getAll() {
				return [];
			},
			async getAllPrimitiveId() {
				return [];
			},
		},
		sch_PrimitiveAttribute: { async getAll() { return []; } },
		sch_PrimitiveWire: {
			async getAll() { return [...wires.values()].map(primitive); },
			async getAllPrimitiveId() { return [...wires.keys()]; },
			async modify(id, property) {
				nativeCalls += 1;
				Object.assign(wires.get(id), property);
			},
		},
	};
	return { wires, calls: () => nativeCalls };
}

const requested = [60, 10, 40, 10, 40, 90];
const triangle = [40, 10, 60, 10, 40, 90, 40, 10];

async function pointConversion() {
	const test = fixture(true);
	const native = globalThis.eda.sch_PrimitiveWire.modify;
	globalThis.eda.sch_PrimitiveWire.modify = async (...args) => {
		await native(...args);
		test.wires.get('target').line = triangle;
	};
	const result = await handleSchematicWireManageTask({ action: 'modify', primitiveId: 'target', property: { line: requested } });
	assert.equal(result.reason, 'point_wire_path_conversion_unsupported');
	assert.equal(result.applied, false);
	assert.equal(test.calls(), 0, 'known unsafe point-to-corner conversion is rejected before the native mutation');
	assert.deepEqual(test.wires.get('target').line, [60, 10, 60, 10]);
	assert.equal(result.commitUnknown, undefined);
}

async function mismatchDiagnostics() {
	const test = fixture();
	const native = globalThis.eda.sch_PrimitiveWire.modify;
	globalThis.eda.sch_PrimitiveWire.modify = async (...args) => {
		await native(...args);
		test.wires.get('target').line = triangle;
		test.wires.get('other').color = '#123456';
		test.wires.set('native-added', { primitiveId: 'native-added', line: [600, 0, 700, 0], net: 'OTHER_NET', color: null, lineWidth: null, lineType: null });
	};
	const result = await toSerializableAsync(await handleSchematicWireManageTask({ action: 'modify', primitiveId: 'target', property: { line: requested } }));
	assert.equal(result.reason, 'post_write_readback_failed');
	assert.deepEqual(result.after.line, triangle, 'failure must report actual geometry');
	assert.deepEqual(result.requested.line, requested);
	assert.deepEqual(result.changedWireIds, ['target', 'other', 'native-added']);
	assert.deepEqual(result.changedOtherWireIds, ['other']);
	assert.deepEqual(result.addedWireIds, ['native-added']);
	assert.equal(result.commitUnknown, true);
	assert.equal(result.readbackRequired, true);
	assert.equal(result.nativeCallSettled, true);
	assert.equal(test.calls(), 1, 'mismatch must not automatically retry or undo the native write');
	const snapshot = await handleSchematicReadTask({ includeConnectivityPrimitives: true, internalConnectivityOnly: true });
	const connectivity = JSON.parse(snapshot.connectivityPrimitivesSnapshot);
	assert.equal(connectivity.complete, true);
	assert.deepEqual(connectivity.wires.find(wire => wire.primitiveId === 'target').line, triangle);
	assert.equal(connectivity.wires.find(wire => wire.primitiveId === 'target').net, 'TEST_NET');
	assert.equal(connectivity.wires.find(wire => wire.primitiveId === 'other').net, 'OTHER_NET');
	const longTest = fixture();
	const longNative = globalThis.eda.sch_PrimitiveWire.modify;
	globalThis.eda.sch_PrimitiveWire.modify = async (...args) => {
		await longNative(...args);
		longTest.wires.get('target').line = triangle;
	};
	const longLine = Array.from({ length: 122 }, (_, index) => [600 + index, 80]).flat();
	const longMismatch = await toSerializableAsync(await handleSchematicWireManageTask({ action: 'modify', primitiveId: 'target', property: { line: longLine } }));
	assert.deepEqual(longMismatch.requested.line, longLine, 'failure diagnostics preserve the complete requested path');
}

async function validModifications() {
	const test = fixture();
	const ordinaryL = await handleSchematicWireManageTask({ action: 'modify', primitiveId: 'target', property: { line: requested } });
	assert.equal(ordinaryL.verified, true, 'ordinary nonzero wires may still be modified into L paths');
	assert.deepEqual(ordinaryL.after.line, requested);
	assert.equal(test.calls(), 1);
	const pointTest = fixture(true);
	const pointStyle = await handleSchematicWireManageTask({ action: 'modify', primitiveId: 'target', property: { color: '#123456' } });
	assert.equal(pointStyle.verified, true, 'point-wire style changes remain available');
	const straight = await handleSchematicWireManageTask({ action: 'modify', primitiveId: 'target', property: { line: [60, 10, 40, 10] } });
	assert.equal(straight.verified, true, 'single-segment conversion is outside the reported native corner bug');
	assert.equal(pointTest.calls(), 2);
}

async function main() {
	const selected = process.argv[2] || 'all';
	if (selected === 'point' || selected === 'all')
		await pointConversion();
	if (selected === 'mismatch' || selected === 'all')
		await mismatchDiagnostics();
	if (selected === 'valid' || selected === 'all')
		await validModifications();
	console.log('Schematic wire modification issue tests passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
