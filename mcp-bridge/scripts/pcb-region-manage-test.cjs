const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');

const { handlePcbRegionManageTask } = require('../src/mcp/pcb-region-manage-handler.ts');
const { requiresHostRestartForResult } = require('../src/runtime/task-timeout.ts');
const { toSerializableAsync } = require('../src/utils.ts');

const path = '/bridge/jlceda/pcb/region-manage';
const source = ['R', 100, 200, 300, 400, 0, 0];
const complexSource = [source, ['R', 140, 240, 180, 280, 0, 0]];
const regions = new Map();
let page = 'pcb-1';
let serial = 1;
let writes = 0;
let layerLocked = false;

function state(id, patch = {}) {
	return { primitiveId: id, layer: 1, polygonSource: source, ruleType: [2], regionName: null, lineWidth: 0.2, primitiveLock: false, ...patch };
}

function primitive(value) {
	return {
		getState_PrimitiveId: () => value.primitiveId,
		getState_Layer: () => value.layer,
		getState_ComplexPolygon: () => ({ getSource: () => value.polygonSource }),
		getState_RuleType: () => value.ruleType,
		getState_RegionName: () => value.regionName ?? undefined,
		getState_LineWidth: () => value.lineWidth,
		getState_PrimitiveLock: () => value.primitiveLock,
	};
}

async function main() {
	for (let index = 0; index < 130; index++)
		regions.set(`old-${index}`, state(`old-${index}`));
	globalThis.eda = {
		dmt_Pcb: { async getCurrentPcbInfo() { return { uuid: page }; } },
		pcb_Layer: { async getAllLayers() { return [{ id: 1, layerStatus: 1, locked: layerLocked }, { id: 12, layerStatus: 1, locked: false }]; } },
		pcb_MathPolygon: {
			createPolygon(value) { return { getSource: () => value }; },
		},
		pcb_PrimitiveRegion: {
			async getAll() { return [...regions.values()].map(primitive); },
			async get(id) { return regions.has(id) ? primitive(regions.get(id)) : undefined; },
			async create(layer, polygon, ruleType, regionName, lineWidth, primitiveLock) {
				writes += 1;
				assert.equal(Array.isArray(polygon.getSource()[0]), false);
				const id = `region-${serial++}`;
				const value = state(id, { layer, polygonSource: polygon.getSource(), ruleType, regionName: regionName ?? null, lineWidth: lineWidth ?? 0.2, primitiveLock: primitiveLock ?? false });
				regions.set(id, value);
				return primitive(value);
			},
			async modify(id, property) {
				writes += 1;
				const patch = { ...property };
				if (patch.complexPolygon) {
					assert.equal(Array.isArray(patch.complexPolygon.getSource()[0]), false);
					patch.polygonSource = patch.complexPolygon.getSource();
					delete patch.complexPolygon;
				}
				Object.assign(regions.get(id), patch);
				return primitive(regions.get(id));
			},
			async delete(id) {
				writes += 1;
				return regions.delete(id);
			},
		},
	};

	const all = await handlePcbRegionManageTask({ action: 'read' });
	assert.equal(all.complete, true);
	assert.equal(all.regionCount, 130);
	const serialized = await toSerializableAsync(all);
	assert.equal(serialized.regions.length, 130);
	assert.deepEqual(serialized.regions[0].polygonSource, source);
	assert.deepEqual(serialized.regions[0].ruleType, [2]);
	assert.equal((await handlePcbRegionManageTask({ action: 'read', primitiveId: 'old-0' })).found, true);
	assert.equal((await handlePcbRegionManageTask({ action: 'read', primitiveId: 'missing' })).found, false);
	regions.set('complex', state('complex', { polygonSource: complexSource }));
	const complexRead = await toSerializableAsync(await handlePcbRegionManageTask({ action: 'read' }));
	assert.equal(complexRead.regionCount, 131);
	assert.deepEqual(complexRead.regions.find(region => region.primitiveId === 'complex').polygonSource, complexSource);
	await assert.rejects(() => handlePcbRegionManageTask({ action: 'modify', primitiveId: 'complex', property: { polygonSource: [source, ['R', 145, 245, 185, 285, 0, 0]] } }), /single-polygon/);
	const complexModified = await handlePcbRegionManageTask({ action: 'modify', primitiveId: 'complex', property: { polygonSource: source } });
	assert.equal(complexModified.verified, true);
	assert.deepEqual(complexModified.region.polygonSource, source);
	const createSingle = globalThis.eda.pcb_PrimitiveRegion.create;
	globalThis.eda.pcb_PrimitiveRegion.create = async (...args) => {
		const created = await createSingle(...args);
		const value = regions.get(created.getState_PrimitiveId());
		value.polygonSource = [value.polygonSource];
		return created;
	};
	const normalized = await handlePcbRegionManageTask({ action: 'create', layer: 1, polygonSource: source, ruleType: [2] });
	assert.equal(normalized.verified, true);
	assert.deepEqual(normalized.region.polygonSource, [source]);
	globalThis.eda.pcb_PrimitiveRegion.create = createSingle;
	globalThis.eda.pcb_PrimitiveRegion.create = async () => undefined;
	const noEffect = await handlePcbRegionManageTask({ action: 'create', layer: 1, polygonSource: source, ruleType: [2] });
	assert.equal(noEffect.ok, false);
	assert.equal(noEffect.reason, 'native_create_no_effect');
	assert.equal(noEffect.applied, false);
	assert.equal(noEffect.commitUnknown, undefined);
	assert.equal(requiresHostRestartForResult(path, {}, noEffect), false);
	globalThis.eda.pcb_PrimitiveRegion.create = async (...args) => {
		await createSingle(...args);
		return undefined;
	};
	const createdWithoutNativeResult = await handlePcbRegionManageTask({ action: 'create', layer: 1, polygonSource: source, ruleType: [2] });
	assert.equal(createdWithoutNativeResult.verified, true);
	assert.equal(createdWithoutNativeResult.region.primitiveId, createdWithoutNativeResult.primitiveId);
	globalThis.eda.pcb_PrimitiveRegion.create = async (...args) => {
		const result = await createSingle(...args);
		regions.get(result.getState_PrimitiveId()).regionName = 'native-name';
		return undefined;
	};
	const createMismatch = await handlePcbRegionManageTask({ action: 'create', layer: 1, polygonSource: source, ruleType: [2], regionName: 'requested-name' });
	assert.equal(createMismatch.ok, false);
	assert.equal(createMismatch.reason, 'create_readback_mismatch');
	assert.equal(createMismatch.applied, true);
	assert.equal(createMismatch.verified, false);
	assert.equal(createMismatch.commitUnknown, undefined);
	assert.equal(createMismatch.after.primitiveId, createMismatch.primitiveId);
	assert.deepEqual(createMismatch.requestedMismatches, [{ field: 'regionName', expected: 'requested-name', actual: 'native-name' }]);
	globalThis.eda.pcb_PrimitiveRegion.create = createSingle;

	const ringPoints = Array.from({ length: 64 }, (_, index) => [
		200 + Math.cos(index * Math.PI / 32) * 80.123456,
		400 + Math.sin(index * Math.PI / 32) * 60.234567,
	]);
	const ringSource = [...ringPoints[0], 'L', ...ringPoints.slice(1).flat(), ...ringPoints[0]];
	const normalizedPoints = [...ringPoints].reverse();
	const shiftedPoints = [...normalizedPoints.slice(7), ...normalizedPoints.slice(0, 7)]
		.map(point => point.map(value => Number(value.toFixed(4))));
	const normalizedSource = [...shiftedPoints[0], 'L', ...shiftedPoints.slice(1).flat(), ...shiftedPoints[0]];
	globalThis.eda.pcb_PrimitiveRegion.create = async (...args) => {
		const result = await createSingle(...args);
		regions.get(result.getState_PrimitiveId()).polygonSource = normalizedSource;
		return result;
	};
	const ringCreated = await handlePcbRegionManageTask({ action: 'create', layer: 1, polygonSource: ringSource, ruleType: [2, 5], regionName: '轮廓规范化' });
	assert.equal(ringCreated.ok, true, 'native winding and four-decimal coordinate rounding preserve region geometry');
	assert.equal(ringCreated.verified, true);
	assert.equal(ringCreated.normalization.reversed, true);
	assert.equal(ringCreated.normalization.precisionAdjusted, true);
	assert.equal(ringCreated.normalization.coordinateToleranceMil, 0.00005);
	assert.deepEqual((await toSerializableAsync(ringCreated)).region.polygonSource, normalizedSource);
	assert.equal(requiresHostRestartForResult(path, {}, ringCreated), false);
	globalThis.eda.pcb_PrimitiveRegion.create = async (...args) => {
		const result = await createSingle(...args);
		const changedSource = [...normalizedSource];
		changedSource[3] += 0.02;
		regions.get(result.getState_PrimitiveId()).polygonSource = changedSource;
		return result;
	};
	const changedRing = await handlePcbRegionManageTask({ action: 'create', layer: 1, polygonSource: ringSource, ruleType: [2, 5] });
	assert.equal(changedRing.reason, 'create_readback_mismatch');
	assert.equal(changedRing.verified, false);
	const serializedChangedRing = await toSerializableAsync(changedRing);
	assert.deepEqual(serializedChangedRing.requestedMismatches[0].actual, changedRing.after.polygonSource, 'the transport diagnostic must preserve the complete polygon instead of [Circular]');
	globalThis.eda.pcb_PrimitiveRegion.create = createSingle;
	globalThis.eda.pcb_PrimitiveRegion.create = async (...args) => {
		const result = await createSingle(...args);
		Object.assign(regions.get(result.getState_PrimitiveId()), { polygonSource: normalizedSource, layer: 12, ruleType: [9] });
		return result;
	};
	const changedRegionProperties = await handlePcbRegionManageTask({ action: 'create', layer: 1, polygonSource: ringSource, ruleType: [2, 5] });
	assert.equal(changedRegionProperties.verified, false, 'equivalent geometry cannot hide a wrong layer or region rule');
	assert.deepEqual(changedRegionProperties.requestedMismatches.map(item => item.field), ['layer', 'ruleType']);
	globalThis.eda.pcb_PrimitiveRegion.create = createSingle;
	const beforeNormalizeModify = globalThis.eda.pcb_PrimitiveRegion.modify;
	globalThis.eda.pcb_PrimitiveRegion.modify = async (...args) => {
		const result = await beforeNormalizeModify(...args);
		regions.get(args[0]).polygonSource = [normalizedSource];
		return result;
	};
	const ringModified = await handlePcbRegionManageTask({ action: 'modify', primitiveId: ringCreated.primitiveId, property: { polygonSource: ringSource } });
	assert.equal(ringModified.verified, true);
	assert.equal(ringModified.normalization.reversed, true);
	assert.deepEqual((await toSerializableAsync(ringModified)).region.polygonSource, [normalizedSource]);
	globalThis.eda.pcb_PrimitiveRegion.modify = beforeNormalizeModify;
	const created = await handlePcbRegionManageTask({ action: 'create', layer: 1, polygonSource: source, ruleType: [2, 5], regionName: '禁布区' });
	assert.equal(created.verified, true);
	assert.deepEqual(created.region.ruleType, [2, 5]);
	assert.deepEqual(created.region.polygonSource, source);
	const modified = await handlePcbRegionManageTask({ action: 'modify', primitiveId: created.primitiveId, property: { layer: 12, polygonSource: ['R', 100, 200, 500, 400, 0, 0], ruleType: [9], regionName: '电源约束区', primitiveLock: true } });
	assert.equal(modified.verified, true);
	assert.equal(modified.region.layer, 12);
	assert.deepEqual(modified.region.ruleType, [9]);
	assert.equal(modified.region.regionName, '电源约束区');
	const propertyModify = globalThis.eda.pcb_PrimitiveRegion.modify;
	globalThis.eda.pcb_PrimitiveRegion.modify = async (id, property) => {
		const { lineWidth: _ignored, ...applied } = property;
		return propertyModify(id, applied);
	};
	const partiallyModified = await handlePcbRegionManageTask({ action: 'modify', primitiveId: 'old-0', property: { polygonSource: ['R', 100, 200, 320, 400, 0, 0], lineWidth: 0.3 } });
	assert.equal(partiallyModified.ok, false);
	assert.equal(partiallyModified.applied, true);
	assert.equal(partiallyModified.verified, false);
	assert.equal(partiallyModified.commitUnknown, undefined);
	assert.deepEqual(partiallyModified.requestedMismatches, ['lineWidth']);
	assert.deepEqual(partiallyModified.after.polygonSource, ['R', 100, 200, 320, 400, 0, 0]);
	assert.equal(partiallyModified.after.lineWidth, 0.2);
	globalThis.eda.pcb_PrimitiveRegion.modify = propertyModify;
	const placeholderGet = globalThis.eda.pcb_PrimitiveRegion.get;
	globalThis.eda.pcb_PrimitiveRegion.get = async () => ({ getState_PrimitiveId: () => created.primitiveId });
	const deleted = await handlePcbRegionManageTask({ action: 'delete', primitiveId: created.primitiveId });
	assert.equal(deleted.verified, true);
	assert.equal(deleted.deleted, true);
	assert.equal((await handlePcbRegionManageTask({ action: 'read', primitiveId: created.primitiveId })).found, false);
	globalThis.eda.pcb_PrimitiveRegion.get = placeholderGet;
	const actualDelete = globalThis.eda.pcb_PrimitiveRegion.delete;
	globalThis.eda.pcb_PrimitiveRegion.delete = async () => false;
	const stillPresent = await handlePcbRegionManageTask({ action: 'delete', primitiveId: 'old-1' });
	assert.equal(stillPresent.ok, false);
	assert.equal(stillPresent.reason, 'region_still_present');
	assert.equal(stillPresent.applied, false);
	assert.equal(stillPresent.commitUnknown, undefined);
	globalThis.eda.pcb_PrimitiveRegion.delete = actualDelete;

	const beforeRejected = writes;
	await assert.rejects(() => handlePcbRegionManageTask({ action: 'create', layer: 3, polygonSource: source, ruleType: [2] }), /layer must/);
	await assert.rejects(() => handlePcbRegionManageTask({ action: 'create', layer: 1, polygonSource: complexSource, ruleType: [2] }), /single-polygon/);
	await assert.rejects(() => handlePcbRegionManageTask({ action: 'create', layer: 1, polygonSource: source, ruleType: [] }), /at least one rule/);
	await assert.rejects(() => handlePcbRegionManageTask({ action: 'modify', primitiveId: 'old-0', property: { net: 'GND' } }), /Unsupported/);
	layerLocked = true;
	await assert.rejects(() => handlePcbRegionManageTask({ action: 'delete', primitiveId: 'old-0' }), /locked/);
	layerLocked = false;
	assert.equal(writes, beforeRejected);

	const originalModify = globalThis.eda.pcb_PrimitiveRegion.modify;
	globalThis.eda.pcb_PrimitiveRegion.modify = async () => {
		throw new Error('RPC Call Timed Out');
	};
	const unknown = await handlePcbRegionManageTask({ action: 'modify', primitiveId: 'old-0', property: { primitiveLock: true } });
	assert.equal(unknown.commitUnknown, true);
	assert.equal(unknown.nativeCallSettled, false);
	assert.equal(requiresHostRestartForResult(path, {}, unknown), true);
	globalThis.eda.pcb_PrimitiveRegion.modify = originalModify;

	const originalGetAll = globalThis.eda.pcb_PrimitiveRegion.getAll;
	let reads = 0;
	globalThis.eda.pcb_PrimitiveRegion.getAll = async (...args) => {
		reads += 1;
		if (reads === 2)
			throw new Error('readback failed');
		return originalGetAll(...args);
	};
	const readbackUnknown = await handlePcbRegionManageTask({ action: 'modify', primitiveId: 'old-0', property: { primitiveLock: true } });
	assert.equal(readbackUnknown.commitUnknown, true);
	assert.equal(readbackUnknown.nativeCallSettled, true);
	globalThis.eda.pcb_PrimitiveRegion.getAll = originalGetAll;

	const originalCreate = globalThis.eda.pcb_PrimitiveRegion.create;
	globalThis.eda.pcb_PrimitiveRegion.create = async (...args) => {
		const result = await originalCreate(...args);
		page = 'pcb-2';
		return result;
	};
	const changedPage = await handlePcbRegionManageTask({ action: 'create', layer: 1, polygonSource: source, ruleType: [5] });
	assert.equal(changedPage.commitUnknown, true);
	assert.match(changedPage.error, /active PCB changed/);
	console.log('PCB region management tests passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
