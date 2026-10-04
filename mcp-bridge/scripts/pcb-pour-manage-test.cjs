const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');

const { handlePcbPourManageTask } = require('../src/mcp/pcb-pour-manage-handler.ts');
const { requiresHostRestartForResult } = require('../src/runtime/task-timeout.ts');
const { toSerializableAsync } = require('../src/utils.ts');

const path = '/bridge/jlceda/pcb/pour-manage';
const rectangle = ['R', 10, 20, 100, 80, 0, 0];

function makePour(id, patch = {}) {
	return {
		primitiveId: id,
		net: 'GND',
		layer: 1,
		polygonSource: rectangle,
		pourFillMethod: 'solid',
		preserveSilos: false,
		pourName: '',
		pourPriority: 0,
		lineWidth: 0.2,
		primitiveLock: false,
		...patch,
	};
}

function primitive(state) {
	return {
		getState_PrimitiveId: () => state.primitiveId,
		getState_Net: () => state.net,
		getState_Layer: () => state.layer,
		getState_ComplexPolygon: () => ({ getSource: () => state.polygonSource }),
		getState_PourFillMethod: () => state.pourFillMethod,
		getState_PreserveSilos: () => state.preserveSilos,
		getState_PourName: () => state.pourName,
		getState_PourPriority: () => state.pourPriority,
		getState_LineWidth: () => state.lineWidth,
		getState_PrimitiveLock: () => state.primitiveLock,
	};
}

function pouredPrimitive(state) {
	return {
		getState_PrimitiveId: () => state.primitiveId,
		getState_PourPrimitiveId: () => state.pourPrimitiveId,
		getState_PourFills: () => state.fills,
	};
}

function fill(id, source = rectangle, patch = {}) {
	return {
		id,
		fill: true,
		lineWidth: 0.2,
		path: { getSourceStrictComplex: () => [source] },
		...patch,
	};
}

async function main() {
	let pageUuid = 'pcb-1';
	let writeCount = 0;
	let serial = 1;
	const pours = new Map([['pour-1', makePour('pour-1')]]);
	const poured = new Map([['filled-1', { primitiveId: 'filled-1', pourPrimitiveId: 'pour-1', fills: [fill('a'), fill('b')] }]]);
	const pourApi = {
		async getAll(...args) {
			assert.equal(args.length, 0, 'read must not filter any pour');
			return [...pours.values()].map(primitive);
		},
		async create(net, layer, polygon, pourFillMethod, preserveSilos, pourName, pourPriority, lineWidth, primitiveLock) {
			writeCount += 1;
			const id = `new-${serial++}`;
			const state = makePour(id, {
				net,
				layer,
				polygonSource: polygon.getSource(),
				pourFillMethod: pourFillMethod ?? 'solid',
				preserveSilos: preserveSilos ?? false,
				pourName: pourName ?? '',
				pourPriority: pourPriority ?? 0,
				lineWidth: lineWidth ?? 0.2,
				primitiveLock: primitiveLock ?? false,
			});
			pours.set(id, state);
			return primitive(state);
		},
		async modify(id, patch) {
			writeCount += 1;
			const state = pours.get(id);
			assert.ok(state);
			if (patch.complexPolygon)
				patch = { ...patch, polygonSource: patch.complexPolygon.getSource() };
			delete patch.complexPolygon;
			Object.assign(state, patch);
			return primitive(state);
		},
		async delete(id) {
			writeCount += 1;
			pours.delete(id);
			for (const [fillId, state] of poured) {
				if (state.pourPrimitiveId === id)
					poured.delete(fillId);
			}
			return true;
		},
		async rebuildCopperRegions(ids) {
			writeCount += 1;
			const targets = ids ?? [...pours.keys()];
			for (const id of targets) {
				for (const [fillId, state] of poured) {
					if (state.pourPrimitiveId === id)
						poured.delete(fillId);
				}
				poured.set(`filled-${id}`, { primitiveId: `filled-${id}`, pourPrimitiveId: id, fills: [fill(`fill-${id}`)] });
			}
			return targets.map(id => pouredPrimitive(poured.get(`filled-${id}`)));
		},
	};
	globalThis.eda = {
		dmt_Pcb: { async getCurrentPcbInfo() { return { uuid: pageUuid }; } },
		pcb_PrimitivePour: pourApi,
		pcb_PrimitivePoured: {
			async getAll(...args) {
				assert.equal(args.length, 0);
				return [...poured.values()].map(pouredPrimitive);
			},
		},
		pcb_MathPolygon: { createPolygon: source => source[0] === 'BAD' ? undefined : { getSource: () => [...source] } },
		pcb_Net: {
			async getAllNets() {
				return [{ net: 'GND' }, { net: 'VCC' }];
			},
		},
		pcb_Layer: {
			async getAllLayers() {
				return [
					{ id: 1, type: 'SIGNAL', layerStatus: 1, locked: false },
					{ id: 2, type: 'SIGNAL', layerStatus: 1, locked: false },
					{ id: 15, type: 'PLANE', layerStatus: 1, locked: false },
					{ id: 16, type: 'SIGNAL', layerStatus: 0, locked: false },
				];
			},
		},
	};

	const first = await handlePcbPourManageTask({ action: 'read' });
	assert.deepEqual([first.ok, first.scope, first.complete, first.pageUuid, first.pourCount, first.pouredCount], [true, 'current_pcb_page', true, 'pcb-1', 1, 1]);
	assert.deepEqual(first.pours[0].polygonSource, rectangle);
	assert.deepEqual([first.poured[0].pourPrimitiveId, first.poured[0].fillCount], ['pour-1', 2]);
	assert.match(first.poured[0].fillGeometryDigest, /^fnv1a64:[0-9a-f]{16}$/);
	const initialDigest = first.poured[0].fillGeometryDigest;
	poured.get('filled-1').fills.reverse();
	assert.equal((await handlePcbPourManageTask({ action: 'read' })).poured[0].fillGeometryDigest, initialDigest, 'fill enumeration order should not affect digest');
	poured.get('filled-1').fills[0].path = { getSourceStrictComplex: () => [['R', 11, 20, 100, 80, 0, 0]] };
	assert.notEqual((await handlePcbPourManageTask({ action: 'read' })).poured[0].fillGeometryDigest, initialDigest, 'same fill IDs and count with changed geometry must change digest');
	poured.get('filled-1').fills = [fill('a'), fill('b')];
	for (let index = 0; index < 125; index++)
		pours.set(`extra-${index}`, makePour(`extra-${index}`));
	pours.get('pour-1').polygonSource = Array.from({ length: 151 }, (_, index) => index);
	for (let index = 0; index < 125; index++)
		poured.set(`extra-filled-${index}`, { primitiveId: `extra-filled-${index}`, pourPrimitiveId: 'pour-1', fills: [] });
	const serializable = await toSerializableAsync(await handlePcbPourManageTask({ action: 'read' }));
	assert.equal(serializable.pourCount, 126);
	assert.equal(serializable.pours.length, 126, 'full pour list must not be truncated by bridge serialization');
	assert.equal(serializable.pours[0].polygonSource.length, 151, 'polygon source must not be truncated by bridge serialization');
	assert.deepEqual(serializable.pours[0].polygonSource, Array.from({ length: 151 }, (_, index) => index), 'polygon coordinates must survive bridge serialization');
	assert.equal(serializable.poured.length, 126, 'full poured list must not be truncated by bridge serialization');
	assert.match(serializable.poured.find(item => item.primitiveId === 'extra-filled-0').fillGeometryDigest, /^fnv1a64:[0-9a-f]{16}$/, 'an empty fill list must still have a stable digest');
	for (let index = 0; index < 125; index++)
		pours.delete(`extra-${index}`);
	pours.get('pour-1').polygonSource = rectangle;
	for (let index = 0; index < 125; index++)
		poured.delete(`extra-filled-${index}`);
	poured.get('filled-1').fills[0].path = {};
	await assert.rejects(handlePcbPourManageTask({ action: 'read' }), /getSourceStrictComplex/, 'unreadable fill geometry must fail the snapshot');
	poured.get('filled-1').fills = [fill('a'), fill('b')];
	await assert.rejects(handlePcbPourManageTask({ action: 'create', net: 'GND', layer: 3, polygonSource: rectangle }), /copper layer/);
	await assert.rejects(handlePcbPourManageTask({ action: 'create', net: 'GND', layer: 1, polygonSource: ['R', 1, Number.POSITIVE_INFINITY] }), /polygonSource/);
	await assert.rejects(handlePcbPourManageTask({ action: 'create', net: 'MISSING', layer: 1, polygonSource: rectangle }), /does not exist/);
	await assert.rejects(handlePcbPourManageTask({ action: 'create', net: 'GND', layer: 16, polygonSource: rectangle }), /enabled, unlocked copper layer/);
	assert.equal(writeCount, 0);

	const created = await handlePcbPourManageTask({ action: 'create', net: 'GND', layer: 15, polygonSource: rectangle, pourFillMethod: '45grid', preserveSilos: true, pourName: 'Ground', pourPriority: 2, lineWidth: 0.25, primitiveLock: false });
	assert.deepEqual([created.ok, created.verified, created.primitiveId, created.pour.layer, created.pour.pourFillMethod], [true, true, 'new-1', 15, '45grid']);
	assert.equal(created.pour.pourName, 'Ground');
	assert.equal(poured.has('filled-new-1'), false, 'create does not rebuild copper automatically');
	const nativeEmptyTargetRebuild = pourApi.rebuildCopperRegions;
	pourApi.rebuildCopperRegions = async () => [];
	const emptyNewTarget = await handlePcbPourManageTask({ action: 'rebuild', primitiveId: 'new-1' });
	assert.deepEqual([emptyNewTarget.ok, emptyNewTarget.applied, emptyNewTarget.verified, emptyNewTarget.commitUnknown], [false, false, false, undefined], 'rebuild of a newly created pour must not verify an empty fill set');
	assert.equal(emptyNewTarget.reason, 'rebuild_no_target_fill');
	pourApi.rebuildCopperRegions = nativeEmptyTargetRebuild;
	const nativePriorityCreate = pourApi.create;
	pourApi.create = async (...args) => {
		const result = await nativePriorityCreate(...args);
		pours.get(result.getState_PrimitiveId()).pourPriority += 1;
		return result;
	};
	const reorderedCreate = await handlePcbPourManageTask({ action: 'create', net: 'GND', layer: 15, polygonSource: rectangle, pourName: 'Priority test', pourPriority: 31 });
	assert.deepEqual([reorderedCreate.ok, reorderedCreate.applied, reorderedCreate.verified, reorderedCreate.commitUnknown], [false, true, false, undefined]);
	assert.deepEqual([reorderedCreate.primitiveId, reorderedCreate.before, reorderedCreate.after.pourPriority], ['new-2', null, 32]);
	assert.deepEqual(reorderedCreate.requestedMismatches, [{ field: 'pourPriority', expected: 31, actual: 32 }]);
	assert.deepEqual(reorderedCreate.sideEffects, [{ primitiveId: 'new-2', field: 'pourPriority', before: 31, after: 32 }]);
	assert.equal((await handlePcbPourManageTask({ action: 'delete', primitiveId: 'new-2' })).verified, true, 'known create side effect must not isolate later writes');
	pourApi.create = async (...args) => {
		await nativePriorityCreate(...args);
		return primitive(makePour('wrong-native-id'));
	};
	const wrongNativeId = await handlePcbPourManageTask({ action: 'create', net: 'GND', layer: 15, polygonSource: rectangle });
	assert.deepEqual([wrongNativeId.commitUnknown, wrongNativeId.nativeCallSettled], [true, true], 'conflicting native and readback IDs remain uncertain');
	pours.delete('new-3');
	pourApi.create = nativePriorityCreate;
	const modified = await handlePcbPourManageTask({ action: 'modify', primitiveId: 'new-1', property: { net: 'VCC', layer: 2, polygonSource: ['CIRCLE', 50, 60, 20], pourPriority: 3 } });
	assert.deepEqual([modified.ok, modified.pour.net, modified.pour.layer, modified.pour.pourPriority], [true, 'VCC', 2, 3]);
	assert.deepEqual(modified.pour.polygonSource, ['CIRCLE', 50, 60, 20]);
	const nativePriorityModify = pourApi.modify;
	pourApi.modify = async (id, patch) => {
		const result = await nativePriorityModify(id, patch);
		pours.get(id).pourPriority += 1;
		return result;
	};
	const reorderedByName = await handlePcbPourManageTask({ action: 'modify', primitiveId: 'new-1', property: { pourName: 'Renamed' } });
	assert.deepEqual([reorderedByName.ok, reorderedByName.applied, reorderedByName.verified, reorderedByName.commitUnknown], [false, true, false, undefined]);
	assert.deepEqual([reorderedByName.before.pourPriority, reorderedByName.after.pourPriority], [3, 4]);
	assert.deepEqual(reorderedByName.sideEffects.map(item => item.field), ['pourPriority']);
	const reorderedExplicitly = await handlePcbPourManageTask({ action: 'modify', primitiveId: 'new-1', property: { pourPriority: 4 } });
	assert.deepEqual([reorderedExplicitly.ok, reorderedExplicitly.applied, reorderedExplicitly.verified, reorderedExplicitly.commitUnknown], [false, true, false, undefined]);
	assert.deepEqual(reorderedExplicitly.requestedMismatches.map(item => item.field), ['pourPriority']);
	pourApi.modify = nativePriorityModify;
	pours.get('new-1').pourPriority = 3;
	const nativeBeforeFreshRebuild = pourApi.rebuildCopperRegions;
	pourApi.rebuildCopperRegions = async () => [pouredPrimitive(poured.get('filled-1'))];
	const skippedNewPour = await handlePcbPourManageTask({ action: 'rebuild', all: true });
	assert.deepEqual([skippedNewPour.commitUnknown, skippedNewPour.nativeCallSettled], [true, true], 'all-page rebuild must include a newly created pour with no prior fill');
	pourApi.rebuildCopperRegions = nativeBeforeFreshRebuild;
	const rebuilt = await handlePcbPourManageTask({ action: 'rebuild', primitiveId: 'new-1' });
	assert.equal(rebuilt.ok, true);
	assert.equal(rebuilt.all, false);
	assert.equal(rebuilt.poured.find(item => item.pourPrimitiveId === 'new-1').fillCount, 1);
	const rebuiltAll = await handlePcbPourManageTask({ action: 'rebuild', all: true });
	assert.equal(rebuiltAll.all, true);
	assert.equal(rebuiltAll.pouredCount, 2);
	assert.match(rebuiltAll.poured.find(item => item.pourPrimitiveId === 'new-1').fillGeometryDigest, /^fnv1a64:[0-9a-f]{16}$/);
	// #70：活跃 PCB 可读但批量重建不存在时，先检查实例能力。
	const savedBatchRebuild = pourApi.rebuildCopperRegions;
	const savedPourGetAll = pourApi.getAll;
	const writeCountBeforeCapability = writeCount;
	globalThis.eda.sys_Environment = { getEditorCurrentVersion: () => '3.2.181' };
	delete pourApi.rebuildCopperRegions;
	assert.equal((await handlePcbPourManageTask({ action: 'read' })).ok, true);
	const missingRebuild = await handlePcbPourManageTask({ action: 'rebuild', all: true });
	assert.deepEqual([missingRebuild.reason, missingRebuild.errorCode, missingRebuild.editorVersion, missingRebuild.applied, missingRebuild.commitUnknown], ['unsupported_capability', 'EDA_CAPABILITY_UNAVAILABLE', '3.2.181', false, undefined]);
	assert.ok(missingRebuild.unavailableApis.includes('eda.pcb_PrimitivePour.rebuildCopperRegions'));
	assert.doesNotMatch(missingRebuild.error, /Open a PCB first/);
	assert.equal(writeCount, writeCountBeforeCapability);
	pourApi.getAll = async function () {
		return (await savedPourGetAll.call(pourApi)).map(item => ({
			...item,
			async rebuildCopperRegion() {
				return (await savedBatchRebuild.call(pourApi, [this.getState_PrimitiveId()]))[0];
			},
		}));
	};
	const fallbackSingle = await handlePcbPourManageTask({ action: 'rebuild', primitiveId: 'new-1' });
	assert.deepEqual([fallbackSingle.ok, fallbackSingle.verified, fallbackSingle.rebuildReturnedCount], [true, true, 1]);
	const fallbackAll = await handlePcbPourManageTask({ action: 'rebuild', all: true });
	assert.deepEqual([fallbackAll.ok, fallbackAll.verified, fallbackAll.rebuildReturnedCount], [true, true, 2]);
	const writesBeforePartialCapability = writeCount;
	const supportedInstanceGetAll = pourApi.getAll;
	pourApi.getAll = async function () {
		const items = await supportedInstanceGetAll.call(pourApi);
		delete items.at(-1).rebuildCopperRegion;
		return items;
	};
	assert.equal((await handlePcbPourManageTask({ action: 'rebuild', all: true })).applied, false);
	assert.equal(writeCount, writesBeforePartialCapability, 'all target capabilities must be checked before any native write');
	pourApi.getAll = savedPourGetAll;
	pourApi.rebuildCopperRegions = savedBatchRebuild;
	const nativeAllRebuild = pourApi.rebuildCopperRegions;
	pourApi.rebuildCopperRegions = async () => [];
	const emptyAllWithExistingFills = await handlePcbPourManageTask({ action: 'rebuild', all: true });
	assert.deepEqual([emptyAllWithExistingFills.commitUnknown, emptyAllWithExistingFills.nativeCallSettled], [true, true], 'all-page rebuild must reject an empty result while fills remain');
	pourApi.rebuildCopperRegions = async () => [pouredPrimitive(poured.get('filled-pour-1'))];
	const partialAllWithExistingFills = await handlePcbPourManageTask({ action: 'rebuild', all: true });
	assert.deepEqual([partialAllWithExistingFills.commitUnknown, partialAllWithExistingFills.nativeCallSettled], [true, true], 'all-page rebuild must reject a partial returned fill set');
	const secondFill = poured.get('filled-new-1');
	pourApi.rebuildCopperRegions = async () => {
		poured.delete('filled-new-1');
		return [pouredPrimitive(poured.get('filled-pour-1'))];
	};
	const partialAllWithMissingReadback = await handlePcbPourManageTask({ action: 'rebuild', all: true });
	assert.deepEqual([partialAllWithMissingReadback.commitUnknown, partialAllWithMissingReadback.nativeCallSettled], [true, true], 'all-page rebuild must reject a lost previously filled pour even when return and readback match');
	poured.set('filled-new-1', secondFill);
	pourApi.rebuildCopperRegions = nativeAllRebuild;
	await assert.rejects(handlePcbPourManageTask({ action: 'rebuild', all: true, primitiveId: 'new-1' }), /either/);
	const nativeDeleteWithFill = pourApi.delete;
	const newPourBeforeDelete = pours.get('new-1');
	pourApi.delete = async (id) => {
		pours.delete(id);
		return true;
	};
	const staleFillAfterDelete = await handlePcbPourManageTask({ action: 'delete', primitiveId: 'new-1' });
	assert.deepEqual([staleFillAfterDelete.ok, staleFillAfterDelete.applied, staleFillAfterDelete.verified, staleFillAfterDelete.commitUnknown], [false, true, false, undefined], 'deleting a boundary must not verify while its fill remains');
	assert.deepEqual([staleFillAfterDelete.reason, staleFillAfterDelete.after.pour, staleFillAfterDelete.after.poured[0].pourPrimitiveId], ['delete_left_associated_fill', null, 'new-1']);
	pours.set('new-1', newPourBeforeDelete);
	pourApi.delete = nativeDeleteWithFill;
	const deleted = await handlePcbPourManageTask({ action: 'delete', primitiveId: 'new-1' });
	assert.deepEqual([deleted.ok, deleted.deleted, deleted.verified], [true, true, true]);
	await assert.rejects(handlePcbPourManageTask({ action: 'delete', primitiveId: 'new-1' }), /does not exist/);

	const nativeRebuild = pourApi.rebuildCopperRegions;
	pourApi.rebuildCopperRegions = async () => [pouredPrimitive({ primitiveId: 'missing-fill', pourPrimitiveId: 'pour-1', fills: [fill('missing')] })];
	const missingReadback = await handlePcbPourManageTask({ action: 'rebuild', primitiveId: 'pour-1' });
	assert.deepEqual([missingReadback.commitUnknown, missingReadback.nativeCallSettled], [true, true]);
	pourApi.rebuildCopperRegions = async () => [pouredPrimitive({ primitiveId: 'filled-1', pourPrimitiveId: 'pour-1', fills: [fill('a', ['R', 99, 20, 100, 80, 0, 0]), fill('b')] })];
	const changedReadback = await handlePcbPourManageTask({ action: 'rebuild', primitiveId: 'pour-1' });
	assert.deepEqual([changedReadback.commitUnknown, changedReadback.nativeCallSettled], [true, true], 'same IDs and fill count with changed geometry must fail rebuild verification');
	pourApi.rebuildCopperRegions = async () => [pouredPrimitive({ primitiveId: 'filled-1', pourPrimitiveId: 'another-pour', fills: [fill('a'), fill('b')] })];
	const wrongAssociation = await handlePcbPourManageTask({ action: 'rebuild', primitiveId: 'pour-1' });
	assert.deepEqual([wrongAssociation.commitUnknown, wrongAssociation.nativeCallSettled], [true, true]);
	const fillsBeforeEmptyTarget = [...poured.entries()].filter(([, state]) => state.pourPrimitiveId === 'pour-1');
	pourApi.rebuildCopperRegions = async () => {
		for (const [id] of fillsBeforeEmptyTarget)
			poured.delete(id);
		return [];
	};
	const emptyWithExistingFill = await handlePcbPourManageTask({ action: 'rebuild', primitiveId: 'pour-1' });
	assert.deepEqual([emptyWithExistingFill.ok, emptyWithExistingFill.applied, emptyWithExistingFill.verified, emptyWithExistingFill.commitUnknown], [false, true, false, undefined]);
	for (const [id, state] of fillsBeforeEmptyTarget)
		poured.set(id, state);
	pourApi.rebuildCopperRegions = async () => {
		throw new Error('Native rebuild failed internally');
	};
	const unknownRebuild = await handlePcbPourManageTask({ action: 'rebuild', primitiveId: 'pour-1' });
	assert.deepEqual([unknownRebuild.commitUnknown, unknownRebuild.readbackRequired, unknownRebuild.nativeCallSettled], [true, true, true]);
	assert.equal(requiresHostRestartForResult(path, { action: 'rebuild' }, unknownRebuild), false);
	pourApi.rebuildCopperRegions = async () => {
		throw new Error('RPC call timed out');
	};
	const timeoutRebuild = await handlePcbPourManageTask({ action: 'rebuild', primitiveId: 'pour-1' });
	assert.deepEqual([timeoutRebuild.commitUnknown, timeoutRebuild.nativeCallSettled], [true, false]);
	assert.equal(requiresHostRestartForResult(path, { action: 'rebuild' }, timeoutRebuild), true);
	pourApi.rebuildCopperRegions = nativeRebuild;
	const nativeModify = pourApi.modify;
	pourApi.modify = async () => {
		throw new Error('WebSocket connection closed');
	};
	const unknownModify = await handlePcbPourManageTask({ action: 'modify', primitiveId: 'pour-1', property: { pourPriority: 4 } });
	assert.deepEqual([unknownModify.commitUnknown, unknownModify.nativeCallSettled], [true, false]);
	pourApi.modify = nativeModify;
	const nativeCreate = pourApi.create;
	pourApi.create = async (...args) => {
		const result = await nativeCreate(...args);
		pageUuid = 'pcb-2';
		return result;
	};
	const switched = await handlePcbPourManageTask({ action: 'create', net: 'GND', layer: 1, polygonSource: rectangle });
	assert.deepEqual([switched.commitUnknown, switched.nativeCallSettled], [true, true]);
	pageUuid = 'pcb-1';
	pourApi.create = nativeCreate;
	const normalizedSource = [50.123456, 50.123456, 'L', 950.123456, 50.123456, 950.123456, 950.123456, 50.123456, 950.123456, 50.123456, 50.123456];
	const reversedSource = [50.1235, 50.1235, 'L', 50.1235, 950.1235, 950.1235, 950.1235, 950.1235, 50.1235, 50.1235, 50.1235];
	pourApi.create = async (...args) => {
		const result = await nativeCreate(...args);
		pours.get(result.getState_PrimitiveId()).polygonSource = reversedSource;
		return result;
	};
	const normalizedCreate = await handlePcbPourManageTask({ action: 'create', net: 'GND', layer: 1, polygonSource: normalizedSource });
	assert.deepEqual([normalizedCreate.ok, normalizedCreate.verified, normalizedCreate.normalization.reversed, normalizedCreate.normalization.precisionAdjusted], [true, true, true, true]);
	assert.deepEqual(normalizedCreate.pour.polygonSource, reversedSource);
	pourApi.modify = async (id, patch) => {
		const result = await nativeModify(id, patch);
		pours.get(id).polygonSource = reversedSource;
		return result;
	};
	const normalizedModify = await handlePcbPourManageTask({ action: 'modify', primitiveId: normalizedCreate.primitiveId, property: { polygonSource: normalizedSource } });
	assert.equal(normalizedModify.verified, true);
	const genuinelyDifferent = [50, 50, 'L', 900, 50, 900, 950, 50, 950, 50, 50];
	const differentModify = await handlePcbPourManageTask({ action: 'modify', primitiveId: normalizedCreate.primitiveId, property: { polygonSource: genuinelyDifferent } });
	assert.equal(differentModify.ok, false, 'different geometry must still report the actual mismatch');
	const serializedMismatch = JSON.parse(JSON.stringify(await toSerializableAsync(differentModify)));
	assert.deepEqual(serializedMismatch.requestedMismatches[0].actual, reversedSource, 'actual geometry must not become Circular');
	assert.deepEqual(serializedMismatch.requestedMismatches[0].expected, genuinelyDifferent);
	pourApi.create = nativeCreate;
	pourApi.modify = nativeModify;
	console.log('PCB pour management tests passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
