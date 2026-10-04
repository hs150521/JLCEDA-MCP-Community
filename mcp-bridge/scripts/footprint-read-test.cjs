const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');
const { handleApiIndexTask } = require('../src/mcp/api-index-handler.ts');
const { readFootprintPrimitiveState } = require('../src/mcp/footprint-primitive-state.ts');
const { handleFootprintReadTask } = require('../src/mcp/footprint-read-handler.ts');
const { toSerializableAsync } = require('../src/utils.ts');

const TYPES = { pad: 'Pad', via: 'Via', line: 'Line', arc: 'Arc', polyline: 'Polyline', string: 'String', attribute: 'Attribute' };
const KINDS = Object.keys(TYPES);
const MASK = { topSolderMask: 0.5, bottomSolderMask: 0.25, topPasteMask: undefined };
const PAD = { layer: 12, padNumber: '1', x: 100.2, y: 200.4, rotation: 90, net: undefined, pad: ['ELLIPSE', 80, 60], hole: ['ROUND', 35], holeOffsetX: 2, holeOffsetY: -3, holeRotation: 15, metallization: true, padType: 0, specialPad: undefined, solderMaskAndPasteMaskExpansion: MASK, heatWelding: { connectionMethod: 'Divergent', divergenceSpacing: 8, divergenceLineWidth: 10, divergenceAngle: 45 } };
const LINE = { net: null, layer: 3, startX: 1, startY: 2, endX: 50, endY: 70, lineWidth: 6 };
const TEXT = { layer: 3, x: 5, y: 7, fontFamily: 'default', fontSize: 40, lineWidth: 5, alignMode: 5, rotation: 45, reverse: false, expansion: 0, mirror: true };
const STATES = {
	pad: PAD,
	via: { net: '', x: 40, y: 60, holeDiameter: 19.6, diameter: 39.4, viaType: 0, designRuleBlindViaName: null, solderMaskExpansion: MASK },
	line: LINE,
	arc: { ...LINE, net: '', arcAngle: 90, interactiveMode: 1 },
	polyline: { net: null, layer: 10, lineWidth: 1, polygonSource: ['R', 0, 0, 100, 200, 0, 0] },
	string: { ...TEXT, text: 'FP_TEST' },
	attribute: { ...TEXT, x: null, y: null, parentPrimitiveId: 'footprint-parent', key: 'Value', value: 'FOOTPRINT', keyVisible: false, valueVisible: true },
};

function native(kind, id = `${kind}-1`, patch = {}) {
	const state = { primitiveId: id, primitiveType: TYPES[kind], primitiveLock: false, ...STATES[kind], ...patch };
	const result = {};
	for (const [field, value] of Object.entries(state)) {
		if (field !== 'polygonSource')
			result[`getState_${field[0].toUpperCase()}${field.slice(1)}`] = () => value;
	}
	if (kind === 'polyline')
		result.getState_Polygon = () => ({ getSource: () => state.polygonSource });
	return result;
}

function fixture() {
	const document = { documentType: 4, uuid: 'fp-document', parentLibraryUuid: 'library-one', tabId: 'fp-document@library-one' };
	const runtime = { dmt_SelectControl: {
		async getCurrentDocumentInfo() {
			return { ...document };
		},
	} };
	const lists = {};
	for (const kind of KINDS) {
		lists[kind] = [native(kind)];
		runtime[`pcb_Primitive${TYPES[kind]}`] = {
			async getAll(...args) {
				assert.equal(args.length, 0, 'complete footprint read must not use filters');
				return lists[kind];
			},
			async getAllPrimitiveId(...args) {
				assert.equal(args.length, 0, 'complete footprint inventory must not use filters');
				return lists[kind].map(item => item.getState_PrimitiveId());
			},
		};
	}
	globalThis.eda = runtime;
	return { document, runtime, lists };
}

async function incomplete(change, pattern) {
	const f = fixture();
	change(f);
	const result = await handleFootprintReadTask({});
	assert.equal(result.ok, false);
	assert.equal(result.complete, false);
	assert.match(result.error, pattern);
	return result;
}

async function main() {
	const f = fixture();
	const result = await handleFootprintReadTask({});
	assert.deepEqual([result.ok, result.complete, result.scope, result.pageKind, result.documentType], [true, true, 'current_footprint_document', 'footprint', 4]);
	assert.deepEqual([result.documentUuid, result.pageUuid, result.libraryUuid, result.tabId], ['fp-document', 'fp-document', 'library-one', 'fp-document@library-one']);
	assert.equal(result.primitiveCount, 7);
	for (const kind of KINDS)
		assert.equal(result[`${kind}Count`], 1);
	assert.deepEqual(result.pads[0].pad, PAD.pad);
	assert.deepEqual(result.pads[0].hole, PAD.hole);
	assert.deepEqual([result.pads[0].holeOffsetX, result.pads[0].holeOffsetY, result.pads[0].holeRotation, result.pads[0].rotation, result.pads[0].padType], [2, -3, 15, 90, 0]);
	assert.equal(result.pads[0].net, null);
	assert.equal(result.pads[0].specialPad, null);
	assert.deepEqual(result.polylines[0].polygonSource, STATES.polyline.polygonSource);
	assert.deepEqual([result.attributes[0].parentPrimitiveId, result.attributes[0].key, result.attributes[0].value, result.attributes[0].keyVisible, result.attributes[0].valueVisible, result.attributes[0].x], ['footprint-parent', 'Value', 'FOOTPRINT', false, true, null]);
	// 读取结果必须与原生对象解耦，保持共享参数和多边形数组的所有状态。
	result.pads[0].pad[1] = 999;
	assert.equal(PAD.pad[1], 80);
	assert.equal(Object.hasOwn(result.pads[0].solderMaskAndPasteMaskExpansion, 'topPasteMask'), false);
	f.lists.pad = Array.from({ length: 231 }, (_, index) => native('pad', `pad-${index}`));
	f.lists.polyline = [native('polyline', 'poly-big', { polygonSource: [0, 0, 'L', ...Array.from({ length: 2000 }, (_, index) => index)] })];
	const serialized = JSON.parse(JSON.stringify(await toSerializableAsync(await handleFootprintReadTask({}))));
	assert.equal(serialized.complete, true);
	assert.equal(serialized.pads.length, 231, 'final Bridge transport must preserve the complete inventory beyond generic array caps');
	assert.equal(serialized.polylines[0].polygonSource.length, 2003);
	assert.equal(JSON.stringify(serialized).includes('[Circular]'), false);
	for (const holeRotation of [null, undefined, Number.NaN]) {
		const smd = fixture();
		smd.lists.pad = [native('pad', 'smd-pad', { hole: null, holeRotation, specialPad: [] })];
		const readback = await handleFootprintReadTask({});
		assert.equal(readback.complete, true, 'an actual no-hole pad may report null, undefined or native NaN for inapplicable hole rotation');
		assert.equal(readback.pads[0].hole, null);
		assert.equal(readback.pads[0].holeRotation, null, 'inapplicable no-hole rotation must remain explicit null, not a fabricated zero');
		assert.equal(JSON.parse(JSON.stringify(readback)).pads[0].holeRotation, null);
		assert.deepEqual(readback.pads[0].specialPad, [], 'no additional special contours remain the native empty array');
	}
	await incomplete(({ lists }) => {
		lists.pad[0].getState_Pad = () => null;
		lists.pad[0].getState_SpecialPad = () => [];
	}, /pad shape is unavailable/);
	const emptyPad = await incomplete(({ lists }) => {
		lists.pad[0].getState_Pad = () => [];
		lists.pad[0].getState_SpecialPad = () => [];
	}, /getState_Pad geometry is not readable/);
	assert.match(emptyPad.error, /received array length 0/);
	const invalidSpecialPad = await incomplete(({ lists }) => {
		lists.pad[0].getState_SpecialPad = () => 'invalid';
	}, /getState_SpecialPad geometry is not readable/);
	assert.match(invalidSpecialPad.error, /received string/);
	const finiteSmd = fixture();
	finiteSmd.lists.pad = [native('pad', 'smd-pad', { hole: null, holeRotation: 15 })];
	assert.equal((await handleFootprintReadTask({})).pads[0].holeRotation, 15, 'a finite native rotation remains actual even without a hole');
	for (const holeRotation of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '0']) {
		await incomplete(({ lists }) => {
			lists.pad[0].getState_HoleRotation = () => holeRotation;
		}, /holeRotation is not readable/);
	}
	for (const holeRotation of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '0']) {
		const invalid = await incomplete(({ lists }) => {
			lists.pad[0].getState_Hole = () => null;
			lists.pad[0].getState_HoleRotation = () => holeRotation;
		}, /holeRotation is not readable/);
		assert.match(invalid.error, typeof holeRotation === 'number' ? /received number -?Infinity/ : /received string "0"/);
	}
	await incomplete(({ lists }) => {
		lists.pad[0].getState_Hole = () => null;
		delete lists.pad[0].getState_HoleRotation;
	}, /getState_HoleRotation is unavailable/);

	await incomplete(({ runtime }) => {
		delete runtime.pcb_PrimitivePad.getAllPrimitiveId;
	}, /getAll\/getAllPrimitiveId is unavailable/);
	await incomplete(({ runtime }) => {
		runtime.pcb_PrimitivePad.getAllPrimitiveId = async () => ['missing-pad'];
	}, /object IDs differ/);
	await incomplete(({ runtime }) => {
		runtime.pcb_PrimitivePad.getAllPrimitiveId = async () => ['pad-1', 'missing-pad'];
	}, /objects do not match/);
	await incomplete(({ lists }) => {
		delete lists.pad[0].getState_Hole;
	}, /getState_Hole is unavailable/);
	await incomplete(({ lists }) => {
		lists.pad[0].getState_Hole = () => undefined;
	}, /geometry is not readable/);
	await incomplete(({ lists }) => {
		lists.pad[0].getState_X = () => Number.NaN;
	}, /x is not readable/);
	await incomplete(({ lists }) => {
		lists.pad[0].getState_PadType = () => 77;
	}, /padType/);
	await incomplete(({ lists }) => {
		lists.via[0].getState_ViaType = () => 'Via';
	}, /viaType/);
	await incomplete(({ lists }) => {
		delete lists.attribute[0].getState_ParentPrimitiveId;
	}, /ParentPrimitiveId/);
	await incomplete(({ lists }) => {
		lists.polyline[0].getState_Polygon = () => ({ getSource: () => ['unknown', 1, 2] });
	}, /official source array/);
	await incomplete(({ lists }) => {
		lists.line[0].getState_PrimitiveType = () => 'Via';
	}, /identity\/type\/lock/);
	await incomplete(({ lists }) => {
		lists.via[0].getState_PrimitiveId = () => 'pad-1';
	}, /object IDs differ/);
	for (const field of ['uuid', 'parentLibraryUuid', 'tabId']) {
		await incomplete(({ document, runtime }) => {
			const original = runtime.pcb_PrimitivePad.getAll;
			runtime.pcb_PrimitivePad.getAll = async () => {
				const raw = await original();
				document[field] = 'other-context';
				return raw;
			};
		}, /changed|identity|match/i);
	}
	await incomplete(({ document }) => {
		document.documentType = 3;
	}, /footprint|type/i);
	await incomplete(({ document }) => {
		delete document.parentLibraryUuid;
	}, /library|identity/i);
	await incomplete(({ lists }) => {
		lists.pad = Array.from({ length: 10001 }, (_, index) => native('pad', `p-${index}`));
	}, /primitive budget/);
	const empty = fixture();
	for (const kind of KINDS)
		empty.lists[kind] = [];
	assert.equal((await handleFootprintReadTask({})).primitiveCount, 0);
	assert.equal((await handleFootprintReadTask({ timeoutMs: 60000 })).complete, true, 'timeout override must not be interpreted as a read filter');
	await assert.rejects(handleFootprintReadTask({ sections: ['pads'] }), /always reads all seven/);
	assert.equal(readFootprintPrimitiveState(native('attribute'), 'attribute').y, null);
	const indexed = await handleApiIndexTask({ owner: 'pcb_PrimitiveAttribute' });
	assert.equal(indexed.index.some(entry => entry.fullName.endsWith('.create')), false);
	assert.equal(indexed.index.some(entry => entry.fullName.endsWith('.getAllPrimitiveId')), true);
	console.log('Complete footprint state, inventory, identity and transport tests passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
