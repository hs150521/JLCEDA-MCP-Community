const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');

const { handleApiInvokeTask } = require('../src/mcp/invoke-handler.ts');
const { handleSchematicConnectivityTask } = require('../src/mcp/schematic-connectivity-handler.ts');
const { handleSchematicReadTask } = require('../src/mcp/schematic-read-handler.ts');
const { getBridgeTaskHandler } = require('../src/runtime/bridge-handler-registry.ts');
const { requiresHostRestartForResult, startTimedTask } = require('../src/runtime/task-timeout.ts');

function wire(id, net, line) {
	return {
		getState_PrimitiveId: () => id,
		getState_Net: () => net,
		getState_Line: () => line,
	};
}

function port(state) {
	return {
		getState_PrimitiveId: () => state.id,
		getState_ComponentType: () => {
			if (state.typeReadError)
				throw new Error('component type getter failed');
			return state.type ?? 'netport';
		},
		getState_Net: () => state.net,
		getState_X: () => state.x + (state.readbackDeltaX ?? 0),
		getState_Y: () => state.y + (state.readbackDeltaY ?? 0),
		getState_Designator: () => '',
		toAsync() { return this; },
		setState_X(x) {
			state.pendingX = x;
			return this;
		},
		setState_Y(y) {
			state.pendingY = y;
			return this;
		},
		async done() {
			if (state.doneError)
				throw new Error(state.doneError);
			state.x = state.pendingX;
			state.y = state.pendingY;
			return this;
		},
	};
}

function attribute(id, parentId, key, value, x, y) {
	return {
		getState_PrimitiveId: () => id,
		getState_ParentPrimitiveId: () => parentId,
		getState_Key: () => key,
		getState_Value: () => value,
		getState_X: () => x,
		getState_Y: () => y,
	};
}

function wireCreateFixture(before, create) {
	let wires = before;
	const calls = [];
	globalThis.eda = {
		dmt_Schematic: { async getCurrentSchematicPageInfo() { return { uuid: 'wire-page' }; } },
		dmt_SelectControl: { async getCurrentDocumentInfo() { return { documentType: 1, uuid: 'wire-page' }; } },
		sch_PrimitiveComponent: { async getAll() { return []; } },
		sch_PrimitiveAttribute: { async getAll() { return []; } },
		sch_PrimitiveWire: {
			async getAll() { return wires; },
			async create(...args) {
				assert.equal(this, globalThis.eda.sch_PrimitiveWire);
				calls.push(args);
				const result = create(args);
				wires = result.after;
				if (result.error)
					throw new Error(result.error);
				return result.returned;
			},
		},
	};
	return calls;
}

async function wireCoverageAndRawTests() {
	for (const timeoutMs of [1000, 4999]) {
		const args = [[0, 0, 100, 0], 'NET_A', '#FF0000', 6, 1];
		const calls = wireCreateFixture([], (nativeArgs) => {
			const created = wire('short-raw-timeout', 'NET_A', nativeArgs[0]);
			return { after: [created], returned: created };
		});
		const created = await handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitiveWire.create', args, timeoutMs });
		assert.equal(created.ok, true, 'raw Wire.create accepts its API timeout policy and retains time for actual readback');
		assert.equal(created.committed, true);
		assert.equal(created.commitUnknown, false);
		assert.equal(created.nativeCallSettled, true);
		assert.deepEqual(calls, [args]);
	}
	const controlledCalls = wireCreateFixture([], (args) => {
		const created = wire('standard-controlled-timeout', 'NET_A', args[0]);
		return { after: [created], returned: created };
	});
	await assert.rejects(handleSchematicConnectivityTask({ action: 'wire_create', line: [0, 0, 100, 0], net: 'NET_A', timeoutMs: 1000 }), /timeoutMs must be an integer between 5000 and 120000/);
	assert.equal(controlledCalls.length, 0, 'controlled connectivity still rejects a 1s timeout before native create');
	const controlled = await handleSchematicConnectivityTask({ action: 'wire_create', line: [0, 0, 100, 0], net: 'NET_A', timeoutMs: 5000 });
	assert.equal(controlled.ok, true);
	assert.equal(controlledCalls.length, 1);

	wireCreateFixture([wire('existing-a', 'NET_A', [0, 0, 100, 0])], () => {
		const partial = wire('existing-a', 'NET_A', [0, 0, 120, 0]);
		return { after: [partial], returned: partial };
	});
	const partial = await handleSchematicConnectivityTask({ action: 'wire_create', line: [100, 0, 150, 0], net: 'NET_A', allowedWireIds: ['existing-a'], timeoutMs: 5000 });
	assert.equal(partial.ok, false, 'changing the returned old ID does not prove the entire requested extension');
	assert.equal(partial.committed, false);
	assert.equal(partial.commitUnknown, true);
	assert.equal(partial.nativeCallSettled, true);
	assert.deepEqual(partial.changedWireIds, ['existing-a']);

	wireCreateFixture([], () => ({ after: [wire('split-1', 'NET_A', [0, 0, 40, 0]), wire('split-2', 'NET_A', [100, 0, 40, 0])], returned: wire('removed-native-id', 'NET_A', [0, 0, 100, 0]) }));
	const split = await handleSchematicConnectivityTask({ action: 'wire_create', line: [0, 0, 100, 0], net: 'NET_A' });
	assert.equal(split.ok, true, 'native split IDs collectively cover the requested segment');
	assert.deepEqual(split.confirmedPrimitiveIds, ['split-1', 'split-2']);
	assert.equal(split.confirmedPrimitiveId, 'split-1');

	wireCreateFixture([wire('covered', 'NET_A', [0, 0, 100, 0])], () => ({ after: [wire('covered', 'NET_A', [0, 0, 100, 0]), wire('wrong', 'NET_A', [300, 0, 400, 0])], returned: wire('wrong', 'NET_A', [300, 0, 400, 0]) }));
	const unchangedCoverage = await handleSchematicConnectivityTask({ action: 'wire_create', line: [0, 0, 100, 0], net: 'NET_A', allowedWireIds: ['covered'], timeoutMs: 5000 });
	assert.equal(unchangedCoverage.committed, false, 'old unchanged coverage cannot verify an unrelated native return');
	assert.equal(unchangedCoverage.commitUnknown, true);

	wireCreateFixture([wire('old-half', 'NET_A', [0, 0, 50, 0])], () => ({ after: [wire('old-half', 'NET_A', [0, 0, 50, 0]), wire('new-half', 'NET_A', [50, 0, 100, 0])], returned: wire('new-half', 'NET_A', [50, 0, 100, 0]) }));
	const combined = await handleSchematicConnectivityTask({ action: 'wire_create', line: [0, 0, 100, 0], net: 'NET_A', allowedWireIds: ['old-half'] });
	assert.equal(combined.ok, true, 'unchanged approved old geometry can contribute to complete coverage with a real new segment');
	assert.deepEqual(combined.confirmedPrimitiveIds, ['old-half', 'new-half']);
	assert.deepEqual(combined.changedWireIds, ['new-half']);

	wireCreateFixture([], () => ({ after: [wire('wrong-net', 'NET_B', [0, 0, 100, 0])], returned: wire('wrong-net', 'NET_B', [0, 0, 100, 0]) }));
	const wrongNet = await handleSchematicConnectivityTask({ action: 'wire_create', line: [0, 0, 100, 0], net: 'NET_A', timeoutMs: 5000 });
	assert.equal(wrongNet.committed, false, 'complete geometry on a different actual named net cannot confirm the request');
	assert.equal(wrongNet.commitUnknown, true);

	wireCreateFixture([], () => ({ after: [wire('partial-path', 'NET_A', [0, 10, 20, 10])], returned: wire('partial-path', 'NET_A', [0, 10, 20, 10]) }));
	const missingSecondPath = await handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitiveWire.create', args: [[[0, 10, 20, 10], [20, 10, 20, 30]], 'NET_A'], timeoutMs: 5000 });
	assert.equal(missingSecondPath.committed, false, 'every native path must be covered, including the second branch');
	assert.equal(missingSecondPath.commitUnknown, true);

	const raw = { apiFullName: 'eda.sch_PrimitiveWire.create', args: [[100, 0, 150, 0], 'NET_A', '#FF0000', 6, 1] };
	const rawCalls = wireCreateFixture([wire('existing-a', 'NET_A', [0, 0, 100, 0])], () => {
		const merged = wire('existing-a', 'NET_A', [0, 0, 150, 0]);
		return { after: [merged], returned: merged };
	});
	const blocked = await handleApiInvokeTask(raw);
	assert.equal(blocked.canCreate, false);
	assert.deepEqual(blocked.unapprovedWireIds, ['existing-a']);
	assert.equal(rawCalls.length, 0, 'raw create must use the controlled contact preflight');
	const merged = await handleApiInvokeTask({ ...raw, allowedWireIds: ['existing-a'] });
	assert.equal(merged.ok, true);
	assert.equal(merged.returnedExistingWire, true);
	assert.deepEqual(rawCalls, [raw.args], 'all five native arguments and the API receiver are preserved');
	assert.equal(Object.hasOwn(merged, 'result'), true, 'raw API retains its result field');

	const lowercaseArgs = [[0, 100, 100, 100], 'sig', '#AA0000', 2, 0];
	const lowercaseCalls = wireCreateFixture([], (args) => {
		const created = wire('uppercase-sdk', args[1].toUpperCase(), args[0]);
		return { after: [created], returned: created };
	});
	const lowercase = await handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitiveWire.create', args: lowercaseArgs });
	assert.equal(lowercase.ok, true, 'native uppercase network normalization must not become unknown');
	assert.equal(lowercase.net, 'SIG');
	assert.deepEqual(lowercaseCalls, [lowercaseArgs], 'lowercase network and every native style parameter remain unchanged');
	const lowercaseMergeArgs = [[100, 100, 150, 100], 'sig'];
	const lowercaseMergeCalls = wireCreateFixture([wire('existing-sig', 'SIG', [0, 100, 100, 100])], (args) => {
		const extended = wire('existing-sig', args[1].toUpperCase(), [0, 100, 150, 100]);
		return { after: [extended], returned: extended };
	});
	const lowercaseMerge = await handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitiveWire.create', args: lowercaseMergeArgs, allowedWireIds: ['existing-sig'] });
	assert.equal(lowercaseMerge.ok, true, 'lowercase request must pass contact checks against an existing uppercase SDK net');
	assert.deepEqual(lowercaseMergeCalls, [lowercaseMergeArgs]);

	const paths = [[999, 999], [0, 10, 20, 10], [20, 10, 20, 30]];
	const multiArgs = [paths, undefined, null, null, null];
	const multiCalls = wireCreateFixture([], args => ({ after: [wire('multi-path', '', args[0].filter(path => path.length >= 4))], returned: wire('multi-path', '', args[0].filter(path => path.length >= 4)) }));
	const multi = await handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitiveWire.create', args: multiArgs });
	assert.equal(multi.ok, true);
	assert.deepEqual(multiCalls, [multiArgs], 'official connected paths, ignored single-point path, undefined net and null styles survive');
	assert.deepEqual(paths, multiArgs[0], 'input arguments are not mutated');
	await assert.rejects(handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitiveWire.getAll', args: [], allowedWireIds: [] }), /allowedWireIds.*Wire.create/);

	let guardCalls = 0;
	const noWriteCalls = wireCreateFixture([], args => ({ after: [wire('guarded', '', args[0])], returned: wire('guarded', '', args[0]) }));
	await assert.rejects(handleSchematicConnectivityTask({ action: 'wire_create', line: [0, 0, 10, 0] }, undefined, () => {
		guardCalls++;
		throw new Error('lease expired before native create');
	}), /lease expired/);
	assert.equal(guardCalls, 1);
	assert.equal(noWriteCalls.length, 0);

	const timeoutCalls = wireCreateFixture([], args => ({ after: [wire('late', '', args[0])], error: 'WebSocket is not open' }));
	const timeout = await handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitiveWire.create', args: [[0, 0, 10, 0]] });
	assert.equal(timeoutCalls.length, 1);
	assert.equal(timeout.commitUnknown, true);
	assert.equal(timeout.nativeCallSettled, false);
	assert.equal(requiresHostRestartForResult('/bridge/jlceda/api/invoke', { apiFullName: 'eda.sch_PrimitiveWire.create' }, timeout), true);
}

async function main() {
	await wireCoverageAndRawTests();
	let pageUuid = 'page-1';
	let editorPageOverride = null;
	const wires = [wire('wire-a', 'NET_A', [0, 0, 100, 0])];
	const ports = [{ id: 'port-a', net: 'NET_A', x: 0, y: 0 }];
	let wireReads = 0;
	const attributes = [];
	let wireCreates = 0;
	let portCreates = 0;
	let createdPortReadbackDeltaY = 0;
	let drcChecks = 0;
	globalThis.eda = {
		dmt_Schematic: { async getCurrentSchematicPageInfo() { return { uuid: pageUuid }; } },
		dmt_SelectControl: { async getCurrentDocumentInfo() { return { uuid: editorPageOverride ?? pageUuid }; } },
		sch_PrimitiveWire: {
			async getAll() {
				wireReads += 1;
				return wires;
			},
			async getAllPrimitiveId() { return wires.map(item => item.getState_PrimitiveId()); },
			async create(line, net) {
				wireCreates += 1;
				const created = wire(`wire-${wireCreates}`, net ?? '', line);
				wires.push(created);
				return created;
			},
		},
		sch_PrimitiveComponent: {
			async getAllPrimitiveId(componentType, allPages) {
				assert.equal(componentType, undefined);
				return (await this.getAll(undefined, allPages)).map(component => component.getState_PrimitiveId());
			},
			async getAll(_type, allPages) {
				assert.equal(typeof allPages, 'boolean');
				assert.ok(_type === undefined || _type === 'netport' || _type === 'netflag');
				return ports.filter(state => _type === undefined || (state.type ?? 'netport') === _type).map(port);
			},
			async getAllPinsByPrimitiveId() { return []; },
			async createNetPort(_direction, net, x, y) {
				portCreates += 1;
				const state = { id: `port-${portCreates}`, net, x, y, readbackDeltaY: createdPortReadbackDeltaY };
				ports.push(state);
				return port(state);
			},
		},
		sch_PrimitiveAttribute: {
			async getAll() { return attributes; },
		},
		sch_Drc: {
			async check() {
				drcChecks += 1;
				return true;
			},
		},
	};

	const oversizedLine = Array.from({ length: 257 }, (_, index) => [index, 0]).flat();
	for (const action of ['wire_preview', 'wire_create'])
		await assert.rejects(handleSchematicConnectivityTask({ action, line: oversizedLine }), /at most 512 coordinates/);
	assert.equal(wireReads, 0, 'oversized input must fail before EDA readback');
	assert.equal(wireCreates, 0);

	// Incomplete connection primitives must not disappear from the pre-write
	// intersection checks when an SDK state getter is missing or throws.
	ports.push({ id: 'missing-net', net: undefined, x: 5, y: 0 });
	await assert.rejects(handleSchematicConnectivityTask({ action: 'wire_create', line: [5, -10, 5, 0], net: 'NET_B' }), /netport has incomplete ID, net, or coordinates/);
	assert.equal(wireCreates, 0);
	ports.pop();
	ports.push({ id: 'missing-x', type: 'netflag', net: 'NET_B', x: undefined, y: 0 });
	await assert.rejects(handleSchematicConnectivityTask({ action: 'netport_create', net: 'NET_A', x: 5, y: 0 }), /netflag has incomplete ID, net, or coordinates/);
	assert.equal(portCreates, 0);
	ports.pop();
	ports.push({ id: '', type: 'netflag', net: 'NET_B', x: 5, y: 0 });
	await assert.rejects(handleSchematicConnectivityTask({ action: 'netport_move', id: 'port-a', x: 10, y: 0 }), /netflag has incomplete ID, net, or coordinates/);
	assert.equal(ports[0].x, 0);
	ports.pop();
	ports.push({ id: 'typed-flag', type: 'netflag', typeReadError: true, net: 'NET_B', x: 5, y: 0 });
	const typedFlagConflict = await handleSchematicConnectivityTask({ action: 'wire_preview', line: [5, -10, 5, 0], net: 'NET_A' });
	assert.deepEqual(typedFlagConflict.conflictingNetPortIds, ['typed-flag']);
	ports.pop();

	// The input limit must not reject longer wires already present on the EDA page.
	wires.push(wire('long-existing', '', Array.from({ length: 257 }, (_, index) => [10000 + index, 0]).flat()));
	const previewBesideLongWire = await handleSchematicConnectivityTask({ action: 'wire_preview', line: [0, 100, 10, 100] });
	assert.equal(previewBesideLongWire.canCreate, true);
	wires.pop();
	wires.push(wire('point-existing', 'NET_OTHER', [8000, 8000, 8000, 8000]));
	const previewAtPoint = await handleSchematicConnectivityTask({ action: 'wire_preview', line: [8000, 7990, 8000, 8010], net: 'NET_A' });
	assert.equal(previewAtPoint.canCreate, true, 'point wires contribute no contact segment');
	assert.deepEqual(previewAtPoint.touches, []);
	const portAtPoint = await handleSchematicConnectivityTask({ action: 'netport_create', net: 'NET_A', x: 8000, y: 8000 });
	assert.equal(portAtPoint.ok, true, 'point wires do not block unrelated NetPort creation');
	ports.pop();
	portCreates -= 1;
	wires.pop();
	wires.push(wire('malformed-existing', '', [8000, 8000, Number.NaN, 8000]));
	await assert.rejects(handleSchematicConnectivityTask({ action: 'wire_preview', line: [8000, 7990, 8000, 8010] }), /no readable line geometry/);
	wires.pop();

	const preview = await handleSchematicConnectivityTask({ action: 'wire_preview', line: [50, -50, 50, 0], net: 'NET_A' });
	assert.equal(preview.canCreate, false);
	assert.deepEqual(preview.unapprovedWireIds, ['wire-a']);
	assert.equal(wireCreates, 0);

	const blocked = await handleSchematicConnectivityTask({ action: 'wire_create', line: [50, -50, 50, 0], net: 'NET_B', allowedWireIds: ['wire-a'] });
	assert.equal(blocked.canCreate, false);
	assert.deepEqual(blocked.conflictingNetWireIds, ['wire-a']);
	assert.equal(wireCreates, 0);

	const created = await handleSchematicConnectivityTask({ action: 'wire_create', line: [50, -50, 50, 0], net: 'NET_A', allowedWireIds: ['wire-a'] });
	assert.equal(created.ok, true);
	assert.equal(created.returnedPrimitiveId, 'wire-1');
	assert.equal(created.confirmedPrimitiveId, 'wire-1');
	assert.deepEqual(created.changedWireIds, ['wire-1']);
	assert.equal(created.readbackRequired, true);
	assert.equal(created.nativeCallSettled, true);
	const originalCreate = globalThis.eda.sch_PrimitiveWire.create;
	globalThis.eda.sch_PrimitiveWire.create = async () => {
		wires[0] = wire('wire-a', 'NET_A', [0, 0, 150, 0]);
		return wires[0];
	};
	const merged = await handleSchematicConnectivityTask({ action: 'wire_create', line: [100, 0, 150, 0], net: 'NET_A', allowedWireIds: ['wire-a'] });
	assert.equal(merged.ok, true);
	assert.equal(merged.returnedExistingWire, true);
	assert.deepEqual(merged.changedWireIds, ['wire-a']);
	globalThis.eda.sch_PrimitiveWire.create = originalCreate;

	// The native Promise may settle before getAll includes its returned ID.
	const delayedWireApi = globalThis.eda.sch_PrimitiveWire;
	const originalDelayedGetAll = delayedWireApi.getAll;
	let delayedWire;
	let postCreateReads = 0;
	delayedWireApi.create = async () => {
		delayedWire = wire('wire-delayed', 'NET_DELAYED', [3100, 1000, 3000, 1000]);
		return delayedWire;
	};
	delayedWireApi.getAll = async () => {
		if (delayedWire) {
			postCreateReads += 1;
			if (postCreateReads === 1)
				wires.push(wire('wire-unrelated', 'NET_OTHER', [4000, 1000, 4100, 1000]));
			if (postCreateReads === 3)
				wires.push(delayedWire);
		}
		return wires;
	};
	const delayedCreate = await handleSchematicConnectivityTask({ action: 'wire_create', line: [3000, 1000, 3100, 1000], net: 'NET_DELAYED' });
	assert.equal(postCreateReads, 3);
	assert.equal(delayedCreate.ok, true);
	assert.equal(delayedCreate.committed, true);
	assert.equal(delayedCreate.commitUnknown, false);
	assert.equal(delayedCreate.nativeCallSettled, true);
	assert.equal(delayedCreate.returnedPrimitiveId, delayedWire.getState_PrimitiveId());
	assert.deepEqual(delayedCreate.changedWireIds, ['wire-unrelated', delayedWire.getState_PrimitiveId()]);
	assert.equal(requiresHostRestartForResult('/bridge/jlceda/schematic/connectivity', { action: 'wire_create' }, delayedCreate), false);
	delayedWireApi.create = originalCreate;
	delayedWireApi.getAll = originalDelayedGetAll;

	// Some EDA versions resolve create without returning a primitive. An unrelated
	// change must not end polling; a unique matching path may confirm the write.
	let noIdReads = 0;
	let noIdStarted = false;
	delayedWireApi.create = async () => {
		noIdStarted = true;
		return undefined;
	};
	delayedWireApi.getAll = async () => {
		if (noIdStarted) {
			noIdReads += 1;
			if (noIdReads === 1)
				wires.push(wire('no-id-unrelated', 'NET_OTHER', [4400, 1000, 4500, 1000]));
			if (noIdReads === 3)
				wires.push(wire('no-id-target', 'NET_DELAYED', [3700, 1000, 3600, 1000]));
		}
		return wires;
	};
	const noIdCreate = await handleSchematicConnectivityTask({ action: 'wire_create', line: [3600, 1000, 3700, 1000], net: 'NET_DELAYED' });
	assert.equal(noIdReads, 3);
	assert.equal(noIdCreate.ok, true);
	assert.equal(noIdCreate.committed, true);
	assert.equal(noIdCreate.commitUnknown, false);
	assert.equal(noIdCreate.returnedPrimitiveId, '');
	assert.equal(noIdCreate.confirmedPrimitiveId, 'no-id-target');
	assert.deepEqual(noIdCreate.changedWireIds, ['no-id-unrelated', 'no-id-target']);
	delayedWireApi.create = originalCreate;
	delayedWireApi.getAll = originalDelayedGetAll;
	wires.splice(wires.findIndex(item => item.getState_PrimitiveId() === 'no-id-unrelated'), 1);
	wires.splice(wires.findIndex(item => item.getState_PrimitiveId() === 'no-id-target'), 1);

	let missingNoIdStarted = false;
	delayedWireApi.create = async () => {
		missingNoIdStarted = true;
		return undefined;
	};
	delayedWireApi.getAll = async () => {
		if (missingNoIdStarted && !wires.some(item => item.getState_PrimitiveId() === 'no-id-only-unrelated'))
			wires.push(wire('no-id-only-unrelated', 'NET_OTHER', [4600, 1000, 4700, 1000]));
		return wires;
	};
	const missingNoId = await handleSchematicConnectivityTask({ action: 'wire_create', line: [3800, 1000, 3900, 1000], net: 'NET_DELAYED' });
	assert.equal(missingNoId.ok, false);
	assert.equal(missingNoId.committed, false, 'an unrelated wire cannot confirm a create with no returned ID');
	assert.equal(missingNoId.commitUnknown, true);
	assert.equal(missingNoId.nativeCallSettled, true);
	assert.equal(missingNoId.confirmedPrimitiveId, null);
	assert.deepEqual(missingNoId.changedWireIds, ['no-id-only-unrelated']);
	delayedWireApi.create = originalCreate;
	delayedWireApi.getAll = originalDelayedGetAll;
	wires.splice(wires.findIndex(item => item.getState_PrimitiveId() === 'no-id-only-unrelated'), 1);

	let unresolvedReads = 0;
	let unresolvedNativeStarted = false;
	let unrelatedAdded = false;
	delayedWireApi.create = async () => {
		unresolvedNativeStarted = true;
		return wire('unresolved-native-id', 'NET_DELAYED', [3200, 1000, 3300, 1000]);
	};
	delayedWireApi.getAll = async () => {
		unresolvedReads += 1;
		if (unresolvedNativeStarted && !unrelatedAdded) {
			wires.push(wire('unresolved-unrelated', 'NET_OTHER', [4200, 1000, 4300, 1000]));
			unrelatedAdded = true;
		}
		return wires;
	};
	const unresolvedCreate = await handleSchematicConnectivityTask({ action: 'wire_create', line: [3200, 1000, 3300, 1000], net: 'NET_DELAYED' });
	assert.ok(unresolvedReads > 2, 'readback retries must be bounded but allow delayed visibility');
	assert.equal(unresolvedCreate.ok, false);
	assert.equal(unresolvedCreate.committed, false, 'an unrelated new wire must not confirm the returned ID');
	assert.equal(unresolvedCreate.commitUnknown, true);
	assert.equal(unresolvedCreate.readbackRequired, true);
	assert.equal(unresolvedCreate.nativeCallSettled, true);
	assert.equal(unresolvedCreate.returnedPrimitiveId, 'unresolved-native-id');
	assert.deepEqual(unresolvedCreate.changedWireIds, ['unresolved-unrelated']);
	assert.equal(requiresHostRestartForResult('/bridge/jlceda/schematic/connectivity', { action: 'wire_create' }, unresolvedCreate), false);
	delayedWireApi.create = originalCreate;
	delayedWireApi.getAll = originalDelayedGetAll;

	// A short Bridge timeout with slow getAll must leave enough time to report
	// that the native create settled, even if the new ID never becomes visible.
	let budgetReads = 0;
	delayedWireApi.create = async () => wire('budget-native-id', 'NET_DELAYED', [3400, 1000, 3500, 1000]);
	delayedWireApi.getAll = async () => {
		budgetReads += 1;
		await new Promise(resolve => setTimeout(resolve, 300));
		return wires;
	};
	const budgetStartedAt = Date.now();
	const budgetPayload = { action: 'wire_create', line: [3400, 1000, 3500, 1000], net: 'NET_DELAYED', timeoutMs: 5000 };
	const budgetTask = startTimedTask(handleSchematicConnectivityTask(budgetPayload), '/bridge/jlceda/schematic/connectivity', 5000);
	const budgetResult = await budgetTask.result;
	assert.ok(Date.now() - budgetStartedAt < 5000, 'result must arrive before the Bridge task timeout');
	assert.ok(budgetReads > 2 && budgetReads < 13, 'readback should poll, then stop at the task budget');
	assert.equal(budgetResult.commitUnknown, true);
	assert.equal(budgetResult.nativeCallSettled, true);
	assert.equal(budgetResult.returnedPrimitiveId, 'budget-native-id');
	assert.equal(requiresHostRestartForResult('/bridge/jlceda/schematic/connectivity', budgetPayload, budgetResult), false);
	delayedWireApi.create = originalCreate;
	delayedWireApi.getAll = originalDelayedGetAll;

	const drcChecksBeforeMove = drcChecks;
	const moved = await handleSchematicConnectivityTask({ action: 'netport_move', id: 'port-a', x: 25, y: 0 });
	assert.equal(moved.ok, true);
	assert.deepEqual(moved.observed, { x: 25, y: 0, net: 'NET_A' });
	assert.equal(moved.netlistReadback.available, true);
	assert.equal(ports[0].id, 'port-a');
	assert.equal(drcChecks, drcChecksBeforeMove + 1, 'moving a port only needs one full semantic scan after the write');

	// A successful native move with an unavailable semantic readback must not
	// claim a verified result; the write may have changed the connected netlist.
	const originalMoveGetAll = globalThis.eda.sch_PrimitiveComponent.getAll;
	globalThis.eda.sch_PrimitiveComponent.getAll = async function (type, allPages) {
		if (type === undefined && ports[0].x === 35)
			return undefined;
		return originalMoveGetAll.call(this, type, allPages);
	};
	const movedWithoutNetlist = await handleSchematicConnectivityTask({ action: 'netport_move', id: 'port-a', x: 35, y: 0 });
	assert.equal(ports[0].x, 35);
	assert.equal(movedWithoutNetlist.ok, false);
	assert.equal(movedWithoutNetlist.reason, 'post_write_readback_failed');
	assert.equal(movedWithoutNetlist.commitUnknown, true);
	assert.equal(movedWithoutNetlist.nativeCallSettled, true);
	assert.match(movedWithoutNetlist.error, /Cannot verify the NetPort network after move/);
	globalThis.eda.sch_PrimitiveComponent.getAll = originalMoveGetAll;

	const conflict = await handleSchematicConnectivityTask({ action: 'netport_create', net: 'NET_B', x: 50, y: 0 });
	assert.equal(conflict.ok, false);
	assert.equal(conflict.reason, 'target_net_conflict');
	assert.equal(portCreates, 0);

	const newPort = await handleSchematicConnectivityTask({ action: 'netport_create', net: 'NET_A', x: 75, y: 0 });
	assert.equal(newPort.ok, true);
	assert.equal(newPort.primitiveVerified, true);
	assert.equal(newPort.netlistReadback.available, true);
	assert.equal(newPort.netlistReadback.found, true);
	assert.ok(newPort.netlistReadback.connectedPinRefs.includes('NET_A.1'));
	assert.equal(newPort.semanticScope, 'current_schematic_page_hierarchical_port');
	const mismatchedDirection = await handleSchematicConnectivityTask({ action: 'netport_create', net: 'NET_A', direction: 'OUT', x: 75, y: 0 });
	assert.equal(mismatchedDirection.ok, false);
	assert.equal(mismatchedDirection.reason, 'existing_port_direction_unverified');
	assert.equal(mismatchedDirection.requestedDirection, 'OUT');
	assert.deepEqual(mismatchedDirection.conflictingPrimitiveIds, ['port-1']);
	assert.equal(mismatchedDirection.unchanged, undefined);
	const repeated = await handleSchematicConnectivityTask({ action: 'netport_create', net: 'NET_A', x: 75, y: 0 });
	assert.equal(repeated.ok, false, 'the documented EDA getters cannot prove the existing port direction even for a repeated request');
	assert.equal(repeated.reason, 'existing_port_direction_unverified');
	assert.equal(portCreates, 1);

	ports.push({ id: 'isolated-b', net: 'NET_B', x: 200, y: 0 });
	const portConflict = await handleSchematicConnectivityTask({ action: 'wire_create', line: [200, -20, 200, 20], net: 'NET_A' });
	assert.equal(portConflict.canCreate, false);
	assert.deepEqual(portConflict.conflictingNetPortIds, ['isolated-b']);
	assert.equal(wireCreates, 1);

	wires.push(wire('wire-nested', 'NET_C', [[300, 0], [400, 0]]));
	const nestedConflict = await handleSchematicConnectivityTask({ action: 'wire_preview', line: [350, -20, 350, 0], net: 'NET_D' });
	assert.deepEqual(nestedConflict.conflictingNetWireIds, ['wire-nested']);
	wires.push(wire('wire-multipart', 'NET_E', [[500, 0, 600, 0], [600, 0, 600, 50]]));
	const multipartConflict = await handleSchematicConnectivityTask({ action: 'wire_preview', line: [550, -20, 550, 0], net: 'NET_D' });
	assert.deepEqual(multipartConflict.conflictingNetWireIds, ['wire-multipart']);
	const inPlaceLine = [700, 0, 800, 0];
	const inPlaceWire = wire('wire-in-place', 'NET_Z', inPlaceLine);
	wires.push(inPlaceWire);
	globalThis.eda.sch_PrimitiveWire.create = async () => {
		inPlaceLine[2] = 850;
		return inPlaceWire;
	};
	const inPlaceChange = await handleSchematicConnectivityTask({ action: 'wire_create', line: [800, 0, 850, 0], net: 'NET_Z', allowedWireIds: ['wire-in-place'] });
	assert.equal(inPlaceChange.ok, true);
	assert.deepEqual(inPlaceChange.changedWireIds, ['wire-in-place']);
	globalThis.eda.sch_PrimitiveWire.create = originalCreate;

	// A distant NetFlag names an otherwise unnamed connected wire component.
	wires.splice(0, wires.length, wire('unnamed-a1', '', [0, 0, 50, 0]), wire('unnamed-a2', '', [50, 0, 100, 0]));
	ports.splice(0, ports.length, { id: 'flag-a', type: 'netflag', net: 'NET_A', x: 0, y: 0 });
	const portCreatesBeforeConflict = portCreates;
	const remotePortConflict = await handleSchematicConnectivityTask({ action: 'netport_create', net: 'NET_B', x: 100, y: 0 });
	assert.equal(remotePortConflict.ok, false);
	assert.deepEqual(remotePortConflict.conflictingPrimitiveIds, ['unnamed-a2']);
	assert.equal(portCreates, portCreatesBeforeConflict);
	const remoteWireConflict = await handleSchematicConnectivityTask({ action: 'wire_preview', line: [100, 0, 150, 0], net: 'NET_B', allowedWireIds: ['unnamed-a2'] });
	assert.deepEqual(remoteWireConflict.conflictingNetWireIds, ['unnamed-a2']);
	const sameNetWire = await handleSchematicConnectivityTask({ action: 'wire_preview', line: [100, 0, 150, 0], net: 'NET_A', allowedWireIds: ['unnamed-a2'] });
	assert.equal(sameNetWire.canCreate, true);
	ports.push({ id: 'port-b', net: 'NET_B', x: 300, y: 0 });
	const remoteMoveConflict = await handleSchematicConnectivityTask({ action: 'netport_move', id: 'port-b', x: 100, y: 0 });
	assert.equal(remoteMoveConflict.ok, false);
	assert.deepEqual(remoteMoveConflict.conflictingPrimitiveIds, ['unnamed-a2']);
	assert.equal(ports.find(item => item.id === 'port-b').x, 300);
	wires.splice(0, wires.length);
	ports.splice(0, ports.length, { id: 'flag-b', type: 'netflag', net: 'NET_B', x: 100, y: 0 }, { id: 'port-a', net: 'NET_A', x: 300, y: 0 });
	const directFlagConflict = await handleSchematicConnectivityTask({ action: 'netport_create', net: 'NET_A', x: 100, y: 0 });
	assert.deepEqual(directFlagConflict.conflictingPrimitiveIds, ['flag-b']);
	const moveOntoFlag = await handleSchematicConnectivityTask({ action: 'netport_move', id: 'port-a', x: 100, y: 0 });
	assert.deepEqual(moveOntoFlag.conflictingPrimitiveIds, ['flag-b']);

	// Pro NetLabels are NET attributes of wires; the displayed text may be away
	// from the electrical contact, and the wire's cached net getter may be empty.
	wires.splice(0, wires.length, wire('labeled-wire', '', [0, 0, 100, 0]));
	ports.splice(0, ports.length);
	attributes.splice(0, attributes.length);
	attributes.push(attribute('label-a', 'labeled-wire', 'NET', 'NET_A', 500, 500));
	attributes.push(attribute('component-net', 'component-id', 'NET', 'NET_B', 50, 0));
	attributes.push(attribute('designator', 'labeled-wire', 'Designator', 'NET_B', 50, 0));
	const labeledWireLine = [100, 0, 150, 0];
	const labelConflict = await handleSchematicConnectivityTask({ action: 'wire_preview', line: labeledWireLine, net: 'NET_B', allowedWireIds: ['labeled-wire'] });
	assert.equal(labelConflict.canCreate, false);
	assert.deepEqual(labelConflict.conflictingNetWireIds, ['labeled-wire']);
	assert.deepEqual(labelConflict.touches[0].effectiveNets, ['NET_A']);
	const createsBeforeLabelConflict = wireCreates;
	const blockedByLabel = await handleSchematicConnectivityTask({ action: 'wire_create', line: labeledWireLine, net: 'NET_B', allowedWireIds: ['labeled-wire'] });
	assert.equal(blockedByLabel.canCreate, false);
	assert.equal(wireCreates, createsBeforeLabelConflict);
	const sameLabelNet = await handleSchematicConnectivityTask({ action: 'wire_preview', line: labeledWireLine, net: 'NET_A', allowedWireIds: ['labeled-wire'] });
	assert.equal(sameLabelNet.canCreate, true);
	wires[0] = wire('labeled-wire', 'NET_STALE', [0, 0, 100, 0]);
	const refreshedLabelNet = await handleSchematicConnectivityTask({ action: 'wire_preview', line: labeledWireLine, net: 'NET_A', allowedWireIds: ['labeled-wire'] });
	assert.equal(refreshedLabelNet.canCreate, true, 'the NET attribute takes precedence over a lagging wire net getter');
	attributes[0] = attribute('label-a', 'labeled-wire', 'NET', '', 500, 500);
	const clearedLabelNet = await handleSchematicConnectivityTask({ action: 'wire_preview', line: labeledWireLine, net: 'NET_B', allowedWireIds: ['labeled-wire'] });
	assert.equal(clearedLabelNet.canCreate, true, 'an empty NET attribute must override a stale wire net getter');
	const writesBeforeUnreadableLabel = wireCreates;
	const throwingValueGetter = () => {
		throw new Error('NET value getter failed');
	};
	for (const unreadableGetter of [undefined, throwingValueGetter]) {
		const unreadableLabel = attribute('label-a', 'labeled-wire', 'NET', '', 500, 500);
		unreadableLabel.getState_Value = unreadableGetter;
		attributes[0] = unreadableLabel;
		await assert.rejects(handleSchematicConnectivityTask({ action: 'wire_create', line: labeledWireLine, net: 'NET_B', allowedWireIds: ['labeled-wire'] }), /NET attribute has no readable value/);
	}
	assert.equal(wireCreates, writesBeforeUnreadableLabel);
	attributes[0] = attribute('label-a', 'labeled-wire', 'NET', 'NET_A', 500, 500);
	wires.splice(0, wires.length, wire('labeled-wire', '', [0, 0, 50, 0]), wire('cached-wire', 'NET_STALE', [50, 0, 100, 0]));
	const connectedLabelNet = await handleSchematicConnectivityTask({ action: 'wire_preview', line: labeledWireLine, net: 'NET_A', allowedWireIds: ['cached-wire'] });
	assert.equal(connectedLabelNet.canCreate, true, 'a NET label overrides stale net getters throughout the connected wire group');
	assert.deepEqual(connectedLabelNet.touches[0].effectiveNets, ['NET_A']);
	const portCreatesBeforeLabelConflict = portCreates;
	const portBlockedByLabel = await handleSchematicConnectivityTask({ action: 'netport_create', net: 'NET_B', x: 50, y: 0 });
	assert.equal(portBlockedByLabel.reason, 'target_net_conflict');
	assert.deepEqual(portBlockedByLabel.conflictingPrimitiveIds, ['labeled-wire']);
	assert.equal(portCreates, portCreatesBeforeLabelConflict);
	ports.push({ id: 'moving-port', net: 'NET_B', x: 200, y: 0 });
	const moveBlockedByLabel = await handleSchematicConnectivityTask({ action: 'netport_move', id: 'moving-port', x: 50, y: 0 });
	assert.equal(moveBlockedByLabel.reason, 'target_net_conflict');
	assert.deepEqual(moveBlockedByLabel.conflictingPrimitiveIds, ['labeled-wire']);
	assert.equal(ports[0].x, 200);
	wires.splice(0, wires.length);
	attributes.splice(0, attributes.length, attribute('independent-label', '', 'NET', 'NET_A', 25, 0));
	const independentLabelPreview = await handleSchematicConnectivityTask({ action: 'wire_preview', line: [0, 0, 50, 0], net: 'NET_B' });
	assert.equal(independentLabelPreview.canCreate, false);
	assert.deepEqual(independentLabelPreview.conflictingNetLabelIds, ['independent-label']);
	const independentLabelCreate = await handleSchematicConnectivityTask({ action: 'wire_create', line: [0, 0, 50, 0], net: 'NET_B' });
	assert.equal(independentLabelCreate.canCreate, false);
	assert.equal(wireCreates, createsBeforeLabelConflict);
	const portAtIndependentLabel = await handleSchematicConnectivityTask({ action: 'netport_create', net: 'NET_B', x: 25, y: 0 });
	assert.deepEqual(portAtIndependentLabel.conflictingPrimitiveIds, ['independent-label']);
	const moveAtIndependentLabel = await handleSchematicConnectivityTask({ action: 'netport_move', id: 'moving-port', x: 25, y: 0 });
	assert.deepEqual(moveAtIndependentLabel.conflictingPrimitiveIds, ['independent-label']);
	assert.equal(ports[0].x, 200);
	attributes.splice(0, attributes.length);

	// Joining two unnamed wires must see their distant, different NetPorts.
	wires.splice(0, wires.length, wire('unnamed-a', '', [0, 0, 100, 0]), wire('unnamed-b', '', [200, 0, 300, 0]));
	ports.splice(0, ports.length, { id: 'port-a', net: 'NET_A', x: 0, y: 0 }, { id: 'port-b', net: 'NET_B', x: 300, y: 0 });
	const joinLine = [100, 0, 200, 0];
	const previewConflict = await handleSchematicConnectivityTask({ action: 'wire_preview', line: joinLine, allowedWireIds: ['unnamed-a', 'unnamed-b'] });
	assert.equal(previewConflict.canCreate, false);
	assert.equal(previewConflict.mixedNamedNets, true);
	assert.deepEqual(previewConflict.touches.map(item => item.effectiveNets), [['NET_A'], ['NET_B']]);
	const wireCreatesBeforeConflict = wireCreates;
	const createConflict = await handleSchematicConnectivityTask({ action: 'wire_create', line: joinLine, allowedWireIds: ['unnamed-a', 'unnamed-b'] });
	assert.equal(createConflict.canCreate, false);
	assert.equal(wireCreates, wireCreatesBeforeConflict);

	// A crossing without a shared endpoint does not merge two existing nets.
	wires.splice(0, wires.length, wire('cross-a', 'NET_A', [0, 0, 100, 0]), wire('cross-b', 'NET_B', [50, -50, 50, 50]));
	ports.splice(0, ports.length);
	const independentCrossing = await handleSchematicConnectivityTask({ action: 'wire_preview', line: [-50, 0, 0, 0], net: 'NET_A', allowedWireIds: ['cross-a'] });
	assert.equal(independentCrossing.canCreate, true);
	wires.splice(0, wires.length, wire('cross-only', 'NET_A', [0, 0, 100, 0]));
	const crossingLine = [50, -50, 50, 50];
	const crossingPreview = await handleSchematicConnectivityTask({ action: 'wire_preview', line: crossingLine, net: 'NET_B' });
	assert.equal(crossingPreview.canCreate, true);
	assert.deepEqual(crossingPreview.touches, []);
	const crossingCreatesBefore = wireCreates;
	const crossingCreated = await handleSchematicConnectivityTask({ action: 'wire_create', line: crossingLine, net: 'NET_B' });
	assert.equal(crossingCreated.ok, true);
	assert.equal(wireCreates, crossingCreatesBefore + 1);
	assert.deepEqual(crossingCreated.touches, []);

	// EDA may read a grid coordinate back as 324.99999999999994 instead of 325.
	const nearly325 = 324.99999999999994;
	wires.splice(0, wires.length, wire('float-end-a', 'NET_A', [300, 325, 325, 325]));
	const nearEndpoint = [325, nearly325, 325, 300];
	const endpointPreview = await handleSchematicConnectivityTask({ action: 'wire_preview', line: nearEndpoint, net: 'NET_B', allowedWireIds: ['float-end-a'] });
	assert.equal(endpointPreview.canCreate, false);
	assert.deepEqual(endpointPreview.conflictingNetWireIds, ['float-end-a']);
	const wireCreatesBeforeFloat = wireCreates;
	const endpointCreate = await handleSchematicConnectivityTask({ action: 'wire_create', line: nearEndpoint, net: 'NET_B', allowedWireIds: ['float-end-a'] });
	assert.equal(endpointCreate.canCreate, false);
	assert.equal(wireCreates, wireCreatesBeforeFloat);
	const actualGap = await handleSchematicConnectivityTask({ action: 'wire_preview', line: [325, 324.99, 325, 300], net: 'NET_B' });
	assert.equal(actualGap.canCreate, true, 'a real 0.01-unit gap must not count as a contact');

	wires.splice(0, wires.length);
	ports.splice(0, ports.length, { id: 'float-port-b', net: 'NET_B', x: 325, y: nearly325 });
	const nearPortLine = [300, 325, 350, 325];
	const portPreview = await handleSchematicConnectivityTask({ action: 'wire_preview', line: nearPortLine, net: 'NET_A' });
	assert.equal(portPreview.canCreate, false);
	assert.deepEqual(portPreview.conflictingNetPortIds, ['float-port-b']);
	const portCreate = await handleSchematicConnectivityTask({ action: 'wire_create', line: nearPortLine, net: 'NET_A' });
	assert.equal(portCreate.canCreate, false);
	assert.equal(wireCreates, wireCreatesBeforeFloat);

	wires.splice(0, wires.length, wire('float-unnamed', '', [300, 325, 350, 325]));
	ports.splice(0, ports.length, { id: 'float-port-a', net: 'NET_A', x: 300, y: nearly325 });
	const remotePortPreview = await handleSchematicConnectivityTask({ action: 'wire_preview', line: [350, 325, 375, 325], net: 'NET_B', allowedWireIds: ['float-unnamed'] });
	assert.equal(remotePortPreview.canCreate, false);
	assert.deepEqual(remotePortPreview.conflictingNetWireIds, ['float-unnamed']);

	// The native wire API rejects diagonal segments; preview and create must agree before calling it.
	wires.splice(0, wires.length);
	ports.splice(0, ports.length);
	const diagonalLine = [0, 0, 100, 100];
	const diagonalPreview = await handleSchematicConnectivityTask({ action: 'wire_preview', line: diagonalLine });
	assert.equal(diagonalPreview.canCreate, false);
	assert.equal(diagonalPreview.reason, 'non_orthogonal_wire');
	assert.equal(diagonalPreview.requiresBend, true);
	assert.equal(diagonalPreview.segmentIndex, 0);
	const wireCreatesBeforeDiagonal = wireCreates;
	const diagonalCreate = await handleSchematicConnectivityTask({ action: 'wire_create', line: diagonalLine });
	assert.equal(diagonalCreate.canCreate, false);
	assert.equal(diagonalCreate.reason, 'non_orthogonal_wire');
	assert.equal(wireCreates, wireCreatesBeforeDiagonal);
	const bentPreview = await handleSchematicConnectivityTask({ action: 'wire_preview', line: [0, 0, 100, 0, 100, 100] });
	assert.equal(bentPreview.canCreate, true);
	const nearAxisCreate = await handleSchematicConnectivityTask({ action: 'wire_create', line: [0, 0, 100, 1e-13], net: 'NET_A' });
	assert.equal(nearAxisCreate.ok, true);
	assert.deepEqual(wires.at(-1).getState_Line(), [0, 0, 100, 0], 'native API receives an exactly orthogonal line');
	const wireCreatesBeforeTiny = wireCreates;
	await assert.rejects(handleSchematicConnectivityTask({ action: 'wire_preview', line: [0, 0, 1e-13, 1e-13] }), /too short/);
	assert.equal(wireCreates, wireCreatesBeforeTiny);

	// Existing and newly read NetPorts use the same tiny coordinate tolerance as wire contacts.
	wires.splice(0, wires.length);
	const portCreatesBeforeFloat = portCreates;
	ports.splice(0, ports.length, { id: 'foreign-near', net: 'NET_B', x: 325, y: nearly325 });
	const foreignNearCreate = await handleSchematicConnectivityTask({ action: 'netport_create', net: 'NET_A', x: 325, y: 325 });
	assert.equal(foreignNearCreate.reason, 'target_net_conflict');
	assert.deepEqual(foreignNearCreate.conflictingPrimitiveIds, ['foreign-near']);
	ports.splice(0, ports.length, { id: 'existing-near', net: 'NET_A', x: 325, y: nearly325 });
	const existingNearCreate = await handleSchematicConnectivityTask({ action: 'netport_create', net: 'NET_A', x: 325, y: 325 });
	assert.equal(existingNearCreate.reason, 'existing_port_direction_unverified');
	assert.equal(portCreates, portCreatesBeforeFloat);
	const unchangedState = { id: 'move-near', net: 'NET_A', x: 325, y: nearly325 };
	ports.splice(0, ports.length, unchangedState);
	const unchangedMove = await handleSchematicConnectivityTask({ action: 'netport_move', id: 'move-near', x: 325, y: 325 });
	assert.equal(unchangedMove.unchanged, true);
	assert.equal(unchangedMove.from.y, nearly325);
	assert.equal(unchangedState.y, nearly325);
	ports.splice(0, ports.length, { id: 'moving-port', net: 'NET_A', x: 300, y: 300 }, { id: 'foreign-near', net: 'NET_B', x: 325, y: nearly325 });
	const foreignNearMove = await handleSchematicConnectivityTask({ action: 'netport_move', id: 'moving-port', x: 325, y: 325 });
	assert.equal(foreignNearMove.reason, 'target_net_conflict');
	assert.deepEqual(foreignNearMove.conflictingPrimitiveIds, ['foreign-near']);
	ports.splice(0, ports.length, { id: 'moving-readback', net: 'NET_A', x: 300, y: 300, readbackDeltaY: nearly325 - 325 });
	const movedWithReadbackNoise = await handleSchematicConnectivityTask({ action: 'netport_move', id: 'moving-readback', x: 325, y: 325 });
	assert.equal(movedWithReadbackNoise.ok, true);
	assert.equal(movedWithReadbackNoise.commitUnknown, false);
	assert.equal(movedWithReadbackNoise.observed.y, nearly325);
	ports.splice(0, ports.length);
	createdPortReadbackDeltaY = nearly325 - 325;
	const createdWithReadbackNoise = await handleSchematicConnectivityTask({ action: 'netport_create', net: 'NET_A', x: 325, y: 325 });
	assert.equal(createdWithReadbackNoise.ok, true);
	assert.equal(createdWithReadbackNoise.primitiveVerified, true);
	assert.equal(createdWithReadbackNoise.commitUnknown, false);

	// The registered Bridge route must report an unknown commit when an EDA write
	// succeeds but its following primitive read fails. A pre-write failure still throws.
	const route = getBridgeTaskHandler('/bridge/jlceda/schematic/connectivity');
	assert.equal(route, handleSchematicConnectivityTask);
	wires.splice(0, wires.length);
	ports.splice(0, ports.length);
	const wireApi = globalThis.eda.sch_PrimitiveWire;
	const originalWireGetAll = wireApi.getAll;
	let wireReadAttempts = 0;
	wireApi.getAll = async () => {
		if (++wireReadAttempts === 2)
			throw new Error('wire readback failed');
		return wires;
	};
	const wireWritesBeforeReadbackFailure = wireCreates;
	const uncertainWire = await route({ action: 'wire_create', line: [0, 0, 10, 0] });
	assert.equal(wireCreates, wireWritesBeforeReadbackFailure + 1);
	assert.equal(uncertainWire.ok, false);
	assert.equal(uncertainWire.reason, 'post_write_readback_failed');
	assert.match(uncertainWire.error, /wire readback failed/);
	assert.equal(uncertainWire.commitUnknown, true);
	assert.equal(uncertainWire.readbackRequired, true);
	assert.equal(uncertainWire.nativeCallSettled, true);
	wireApi.getAll = async () => {
		throw new Error('wire pre-write read failed');
	};
	await assert.rejects(route({ action: 'wire_create', line: [20, 0, 30, 0] }), /wire pre-write read failed/);
	assert.equal(wireCreates, wireWritesBeforeReadbackFailure + 1);
	wireApi.getAll = originalWireGetAll;

	wires.splice(0, wires.length);
	const movedPort = { id: 'port-readback-failure', net: 'NET_A', x: 0, y: 0 };
	ports.splice(0, ports.length, movedPort);
	const componentApi = globalThis.eda.sch_PrimitiveComponent;
	const originalComponentGetAll = componentApi.getAll;
	componentApi.getAll = async (...args) => {
		if (movedPort.x === 10 && args[0] === 'netport')
			throw new Error('port move readback failed');
		return originalComponentGetAll(...args);
	};
	const uncertainMove = await route({ action: 'netport_move', id: movedPort.id, x: 10, y: 0 });
	assert.equal(movedPort.x, 10, 'NetPort move completed before the readback error');
	assert.equal(uncertainMove.ok, false);
	assert.equal(uncertainMove.reason, 'post_write_readback_failed');
	assert.match(uncertainMove.error, /port move readback failed/);
	assert.equal(uncertainMove.commitUnknown, true);
	assert.equal(uncertainMove.nativeCallSettled, true);
	componentApi.getAll = async () => {
		throw new Error('port move pre-write read failed');
	};
	await assert.rejects(route({ action: 'netport_move', id: movedPort.id, x: 20, y: 0 }), /port move pre-write read failed/);
	assert.equal(movedPort.x, 10);
	componentApi.getAll = originalComponentGetAll;

	ports.splice(0, ports.length);
	let createReadAttempts = 0;
	componentApi.getAll = async (...args) => {
		if (++createReadAttempts === 3)
			throw new Error('port create readback failed');
		return originalComponentGetAll(...args);
	};
	const portWritesBeforeReadbackFailure = portCreates;
	const uncertainPort = await route({ action: 'netport_create', net: 'NET_A', x: 20, y: 20 });
	assert.equal(portCreates, portWritesBeforeReadbackFailure + 1);
	assert.equal(uncertainPort.ok, false);
	assert.equal(uncertainPort.reason, 'post_write_readback_failed');
	assert.match(uncertainPort.error, /port create readback failed/);
	assert.equal(uncertainPort.commitUnknown, true);
	assert.equal(uncertainPort.nativeCallSettled, true);
	assert.equal(uncertainPort.primitiveId, ports[0].id);
	componentApi.getAll = async () => {
		throw new Error('port create pre-write read failed');
	};
	await assert.rejects(route({ action: 'netport_create', net: 'NET_A', x: 30, y: 30 }), /port create pre-write read failed/);
	assert.equal(portCreates, portWritesBeforeReadbackFailure + 1);
	componentApi.getAll = originalComponentGetAll;

	// A native RPC timeout may still commit after its Promise rejects. Keep the
	// host in recovery until a fresh EDA instance supplies complete readback.
	wires.splice(0, wires.length);
	ports.splice(0, ports.length);
	wireApi.create = async () => {
		throw new Error('RPC Call Timed Out');
	};
	const timedOutWire = await route({ action: 'wire_create', line: [0, 0, 10, 0] });
	assert.equal(timedOutWire.commitUnknown, true);
	assert.equal(timedOutWire.nativeCallSettled, false);
	assert.equal(timedOutWire.reason, 'native_call_result_unknown');
	assert.equal(requiresHostRestartForResult('/bridge/jlceda/schematic/connectivity', { action: 'wire_create' }, timedOutWire), true);
	wireApi.create = async () => {
		throw new Error('invalid wire geometry');
	};
	await assert.rejects(route({ action: 'wire_create', line: [0, 0, 10, 0] }), /invalid wire geometry/);
	wireApi.create = originalCreate;

	const moving = { id: 'move-native-timeout', net: 'NET_A', x: 0, y: 0, doneError: 'RPC Call Timed Out' };
	ports.push(moving);
	const timedOutMove = await route({ action: 'netport_move', id: moving.id, x: 10, y: 0 });
	assert.equal(timedOutMove.commitUnknown, true);
	assert.equal(timedOutMove.nativeCallSettled, false);
	assert.equal(moving.x, 0);
	moving.doneError = 'invalid port move';
	await assert.rejects(route({ action: 'netport_move', id: moving.id, x: 10, y: 0 }), /invalid port move/);
	ports.splice(0, ports.length);

	const originalCreateNetPort = componentApi.createNetPort;
	componentApi.createNetPort = async () => {
		throw new Error('RPC Call Timed Out');
	};
	const timedOutPort = await route({ action: 'netport_create', net: 'NET_A', x: 10, y: 10 });
	assert.equal(timedOutPort.commitUnknown, true);
	assert.equal(timedOutPort.nativeCallSettled, false);
	componentApi.createNetPort = async () => {
		throw new Error('invalid netport');
	};
	await assert.rejects(route({ action: 'netport_create', net: 'NET_A', x: 10, y: 10 }), /invalid netport/);
	componentApi.createNetPort = originalCreateNetPort;

	// A page switch during the pre-write reads must not move a port from the old page.
	const switchingPort = { id: 'page-switch-port', net: 'NET_A', x: 0, y: 0 };
	ports.splice(0, ports.length, switchingPort);
	const originalSwitchWireGetAll = wireApi.getAll;
	wireApi.getAll = async () => {
		pageUuid = 'page-2';
		return wires;
	};
	await assert.rejects(route({ action: 'netport_move', id: switchingPort.id, x: 10, y: 0 }), /图页已切换|active schematic page changed/);
	assert.equal(switchingPort.x, 0);
	wireApi.getAll = originalSwitchWireGetAll;
	pageUuid = 'page-1';

	// If the page changes after the native move, report an unknown post-write state.
	const originalSwitchComponentGetAll = componentApi.getAll;
	componentApi.getAll = async (...args) => {
		const result = await originalSwitchComponentGetAll(...args);
		if (switchingPort.x === 10 && args[0] === 'netport')
			pageUuid = 'page-2';
		return result;
	};
	const switchedAfterWrite = await route({ action: 'netport_move', id: switchingPort.id, x: 10, y: 0 });
	assert.equal(switchingPort.x, 10);
	assert.equal(switchedAfterWrite.ok, false);
	assert.equal(switchedAfterWrite.reason, 'post_write_readback_failed');
	assert.equal(switchedAfterWrite.commitUnknown, true);
	componentApi.getAll = originalSwitchComponentGetAll;
	pageUuid = 'page-1';

	// The editor may switch before the page API catches up.
	const beforeEditorSwitchX = switchingPort.x;
	editorPageOverride = 'page-2';
	await assert.rejects(route({ action: 'netport_move', id: switchingPort.id, x: 20, y: 0 }), /not synchronized/);
	assert.equal(switchingPort.x, beforeEditorSwitchX);
	editorPageOverride = null;

	// A port from the old page is absent from the new page's current inventory.
	const oldPagePort = { id: 'copied-page-port', net: 'NET_A', x: 0, y: 0 };
	ports.splice(0, ports.length, oldPagePort);
	assert.equal((await handleSchematicReadTask({})).ok, true);
	pageUuid = 'page-2';
	ports.splice(0, ports.length);
	await assert.rejects(route({ action: 'netport_move', id: oldPagePort.id, x: 20, y: 0 }), /Current schematic page/);
	assert.equal(oldPagePort.x, 0);

	// A copied page may reuse that ID. Moving its current-page port is valid.
	const copiedPagePort = { id: oldPagePort.id, net: 'NET_A', x: 0, y: 0 };
	ports.push(copiedPagePort);
	const copiedPageMove = await route({ action: 'netport_move', id: copiedPagePort.id, x: 20, y: 0 });
	assert.equal(copiedPageMove.ok, true);
	assert.equal(copiedPageMove.pageUuid, 'page-2');
	assert.equal(copiedPagePort.x, 20);
	assert.equal(oldPagePort.x, 0);
	pageUuid = 'page-1';

	// A stale component list must not be used after both page APIs report the new page.
	const cachedPort = { id: 'cached-old-page-port', net: 'NET_A', x: 0, y: 0 };
	ports.splice(0, ports.length, cachedPort);
	assert.equal((await handleSchematicReadTask({})).ok, true);
	const originalCurrentComponentIds = globalThis.eda.sch_PrimitiveComponent.getAllPrimitiveId;
	pageUuid = 'page-2';
	componentApi.getAllPrimitiveId = async () => ['new-page-port'];
	await assert.rejects(route({ action: 'netport_move', id: cachedPort.id, x: 20, y: 0 }), /器件列表与图元 ID 列表不一致/);
	assert.equal(cachedPort.x, 0);
	componentApi.getAllPrimitiveId = originalCurrentComponentIds;
	pageUuid = 'page-1';
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
