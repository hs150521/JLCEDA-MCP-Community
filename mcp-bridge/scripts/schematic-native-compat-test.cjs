const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');
const { handleComponentPlaceAutoTask } = require('../src/mcp/component-place-auto-handler.ts');
const { handleApiInvokeTask } = require('../src/mcp/invoke-handler.ts');
const { requiresHostRestartForResult } = require('../src/runtime/task-timeout.ts');
const { toSerializableAsync } = require('../src/utils.ts');

function pinState(id, number) {
	return { primitiveId: id, x: 530, y: 330, rotation: 180, pinNumber: number, pinName: 'IO', pinLength: 10, pinColor: null, pinShape: 'None', pinType: 'BI', noConnected: true, otherProperty: { net: 'IO' } };
}

function schematicCreateFixture(options = {}) {
	const pageUuid = 'raw-create-page';
	const oldProperties = {
		u4: { 'Manufacturer': 'ACME', 'Supplier': 'LCSC', 'Supplier Part': 'C1004', 'Value': 'MCU', 'includeInBom': true, 'channels': 4 },
		u5: { 'Manufacturer': 'ACME', 'Supplier': 'LCSC', 'Supplier Part': 'C1005', 'Value': 'MCU', 'includeInBom': false, 'channels': 5 },
	};
	const components = new Map([
		['u4', { primitiveId: 'u4', designator: 'U4', otherProperty: { ...oldProperties.u4 } }],
		['u5', { primitiveId: 'u5', designator: 'U5', otherProperty: { ...oldProperties.u5 } }],
	]);
	const createCalls = [];
	const modifyCalls = [];
	const getCalls = [];
	const libraryLookups = [];
	let pageReadFailure = false;
	let snapshotReads = 0;
	const deviceItem = { libraryType: '3', uuid: 'raw-device', libraryUuid: 'system', name: 'Test Device', association: { symbol: { uuid: 'raw-symbol', libraryUuid: 'system' } }, property: {}, subPartNames: [] };
	function nativeComponent(state, source) {
		return {
			...state,
			otherProperty: { ...state.otherProperty },
			readSource: source,
			getState_PrimitiveId: () => state.primitiveId,
			getState_Designator: () => state.designator,
			getState_ComponentType: () => 'part',
			getState_OtherProperty: () => ({ ...state.otherProperty }),
		};
	}
	const api = {
		async create(...args) {
			assert.equal(this, api, 'native create retains its API receiver');
			createCalls.push(args);
			if (options.drift !== false) {
				components.get('u4').designator = 'U15';
				components.get('u5').designator = 'U16';
			}
			const added = { primitiveId: 'new-r', designator: 'R1', otherProperty: { 'Value': '10k', 'Supplier': 'LCSC', 'Supplier Part': 'C21190' }, x: args[1], y: args[2] };
			components.set('new-r', added);
			if (options.nativeCreateError)
				throw new Error(options.nativeCreateError);
			if (options.createReturnsUndefined)
				return undefined;
			return nativeComponent({ ...added }, 'create');
		},
		async getAll(componentType, allSchematicPages) {
			assert.equal(this, api);
			assert.deepEqual([componentType, allSchematicPages], [null, false], 'baseline and restore verification must read only the current page');
			snapshotReads += 1;
			if (options.postReadFailure && snapshotReads === 3)
				throw new Error('post-restore component read failed');
			return [...components.values()].map(state => nativeComponent(state, 'inventory'));
		},
		async modify(id, patch) {
			assert.equal(this, api, 'restoration retains its API receiver');
			modifyCalls.push({ id, patch });
			assert.deepEqual(patch.otherProperty, oldProperties[id], 'restoration supplies the complete BOM object, including boolean and numeric values');
			if (options.restoreTimeout) {
				pageReadFailure = options.pageFailureAfterTimeout === true;
				throw new Error('ETIMEDOUT: restoration timed out');
			}
			if (!options.ignoreRestore) {
				Object.assign(components.get(id), patch);
				components.get('new-r').designator = 'R2';
			}
			return nativeComponent(components.get(id), 'modify');
		},
		async get(id) {
			assert.equal(this, api);
			getCalls.push(id);
			if (options.freshReadFailure)
				throw new Error('fresh created component read failed');
			return nativeComponent(components.get(id), 'fresh-get');
		},
	};
	if (options.noModify)
		delete api.modify;
	globalThis.eda = {
		EDMT_EditorDocumentType: { SCHEMATIC_PAGE: 1 },
		ELIB_LibraryType: { DEVICE: '3', SYMBOL: '2' },
		dmt_SelectControl: { async getCurrentDocumentInfo() { return { documentType: 1, uuid: pageUuid }; } },
		dmt_Schematic: {
			async getCurrentSchematicPageInfo() {
				if (pageReadFailure)
					throw new Error('page read failed after restoration timeout');
				return { uuid: pageUuid };
			},
		},
		lib_Device: {
			async get(uuid, libraryUuid) {
				libraryLookups.push([uuid, libraryUuid]);
				return uuid === deviceItem.uuid && libraryUuid === deviceItem.libraryUuid ? deviceItem : undefined;
			},
		},
		sch_PrimitiveComponent: api,
	};
	return { pageUuid, deviceItem, components, oldProperties, createCalls, modifyCalls, getCalls, libraryLookups };
}

async function rawSchematicCreateTests() {
	const path = '/bridge/jlceda/api/invoke';
	const apiFullName = 'eda.sch_PrimitiveComponent.create';
	const payloadFor = component => ({ apiFullName, args: [component, 300, 400, 'ExplicitPart', 135, false, false, false] });
	let f = schematicCreateFixture();
	const restored = await handleApiInvokeTask(payloadFor(f.deviceItem));
	assert.deepEqual([restored.apiFullName, restored.ok, restored.pageUuid, restored.commitUnknown], [apiFullName, true, f.pageUuid, undefined]);
	assert.deepEqual(restored.designatorChanges, []);
	assert.deepEqual(restored.restoredDesignators, [
		{ primitiveId: 'u4', before: 'U15', after: 'U4' },
		{ primitiveId: 'u5', before: 'U16', after: 'U5' },
	]);
	assert.deepEqual([...f.components.values()].map(state => [state.primitiveId, state.designator]), [['u4', 'U4'], ['u5', 'U5'], ['new-r', 'R2']]);
	for (const id of ['u4', 'u5'])
		assert.deepEqual(f.components.get(id).otherProperty, f.oldProperties[id]);
	assert.deepEqual(f.modifyCalls.map(call => call.id), ['u4', 'u5'], 'only renumbered existing components are restored');
	assert.deepEqual(f.getCalls, ['new-r'], 'a new component is read freshly after any designator restoration');
	assert.deepEqual([restored.result.primitiveId, restored.result.designator, restored.result.readSource], ['new-r', 'R2', 'fresh-get']);
	assert.deepEqual(restored.result.otherProperty, f.components.get('new-r').otherProperty);

	f = schematicCreateFixture({ drift: false });
	const unchanged = await handleApiInvokeTask(payloadFor(f.deviceItem));
	assert.equal(unchanged.ok, true);
	assert.deepEqual(unchanged.designatorChanges, []);
	assert.deepEqual(unchanged.restoredDesignators, []);
	assert.equal(f.modifyCalls.length, 0, 'create without annotation drift must not invoke modify');
	assert.equal(f.getCalls.length, 0, 'no-drift create retains the original native result without an unnecessary read');
	assert.equal(unchanged.result.readSource, 'create');

	const inputCases = [
		['DEVICE reference', () => ({ libraryType: '3', uuid: 'raw-device', libraryUuid: 'system' }), true],
		['SYMBOL reference', () => ({ libraryType: '2', uuid: 'raw-symbol', libraryUuid: 'system' }), false],
		['DeviceItem', fixture => fixture.deviceItem, false],
		['DeviceSearchItem', () => ({ uuid: 'searched-device', libraryUuid: 'system', ordinal: 1, name: 'Test Device', symbolName: 'Test Symbol', symbolUuid: 'raw-symbol', symbol: { name: 'Test Symbol', uuid: 'raw-symbol', libraryUuid: 'system' }, footprintUuid: 'raw-footprint', model3DUuid: 'raw-model' }), false],
		['SymbolItem', () => ({ libraryType: '2', uuid: 'raw-symbol', libraryUuid: 'system', name: 'Test Symbol', type: 2, subPartNames: [] }), false],
		['SymbolSearchItem', () => ({ uuid: 'raw-symbol', libraryUuid: 'system', ordinal: 1, name: 'Test Symbol', type: 2, updateTimestamp: 1, ascription: 'system', lastModifiedBy: 'tester' }), false],
	];
	for (const [name, input, resolvedDevice] of inputCases) {
		f = schematicCreateFixture({ drift: false });
		const component = input(f);
		const payload = payloadFor(component);
		const result = await handleApiInvokeTask(payload);
		assert.equal(result.ok, true, `${name} remains an official native create overload`);
		assert.equal(f.createCalls.length, 1, name);
		assert.equal(f.createCalls[0].length, 8, `${name} keeps all eight native arguments`);
		assert.equal(f.createCalls[0][0], resolvedDevice ? f.deviceItem : component, `${name} preserves the accepted native item`);
		assert.deepEqual(f.createCalls[0].slice(1), [300, 400, 'ExplicitPart', 135, false, false, false], `${name} must not replace explicit false mirror/BOM/PCB flags`);
		assert.equal(f.libraryLookups.length, resolvedDevice ? 1 : 0, `${name} should only resolve bare DEVICE references`);
	}

	for (const options of [{ noModify: true }, { ignoreRestore: true }]) {
		f = schematicCreateFixture(options);
		const warning = await handleApiInvokeTask(payloadFor(f.deviceItem));
		assert.deepEqual([warning.ok, warning.needsReview, warning.commitUnknown], [false, true, undefined]);
		assert.ok(warning.annotationWarning);
		assert.equal(warning.designatorChanges.length, 2);
		assert.equal(f.modifyCalls.length, options.noModify ? 0 : 2, 'the warning fixture must reach the intended restoration path');
	}
	for (const pageFailureAfterTimeout of [false, true]) {
		f = schematicCreateFixture({ restoreTimeout: true, pageFailureAfterTimeout });
		const payload = payloadFor(f.deviceItem);
		const uncertain = await handleApiInvokeTask(payload);
		assert.deepEqual([uncertain.ok, uncertain.commitUnknown, uncertain.readbackRequired, uncertain.nativeCallSettled], [false, true, true, false], 'restoration timeout stays unsettled even if the following page read fails');
		assert.equal(requiresHostRestartForResult(path, payload, uncertain), true);
		assert.equal(f.createCalls.length, 1);
		assert.equal(f.modifyCalls.length, 1, 'the timeout originates in the first actual restore mutation');
		assert.match(pageFailureAfterTimeout ? uncertain.error : uncertain.annotationWarning, pageFailureAfterTimeout ? /page read failed after restoration timeout/ : /ETIMEDOUT/);
	}
	for (const options of [{ postReadFailure: true }, { freshReadFailure: true }]) {
		f = schematicCreateFixture(options);
		const payload = payloadFor(f.deviceItem);
		const uncertain = await handleApiInvokeTask(payload);
		assert.deepEqual([uncertain.ok, uncertain.commitUnknown, uncertain.readbackRequired, uncertain.nativeCallSettled], [false, true, true, true], 'a settled restoration with failed readback remains unknown without requiring a host restart');
		assert.equal(requiresHostRestartForResult(path, payload, uncertain), false);
		assert.equal(f.modifyCalls.length, 2, 'both native restore writes have completed before this readback failure');
		assert.equal(f.getCalls.length, options.freshReadFailure ? 1 : 0);
	}
	for (const options of [{ nativeCreateError: 'WebSocket is not open' }, { createReturnsUndefined: true }]) {
		f = schematicCreateFixture(options);
		const payload = payloadFor(f.deviceItem);
		const uncertain = await handleApiInvokeTask(payload);
		const unsettled = Boolean(options.nativeCreateError);
		assert.deepEqual([uncertain.ok, uncertain.commitUnknown, uncertain.readbackRequired, uncertain.nativeCallSettled], [false, true, true, !unsettled]);
		assert.equal(requiresHostRestartForResult(path, payload, uncertain), unsettled);
		assert.equal(f.createCalls.length, 1);
		assert.equal(f.components.has('new-r'), true, 'a missing native response does not undo the created component');
		assert.equal(f.modifyCalls.length, 0);
	}
	f = schematicCreateFixture();
	let mutationGuards = 0;
	const guarded = await handleApiInvokeTask(payloadFor(f.deviceItem), undefined, () => {
		if (++mutationGuards === 2)
			throw new Error('lease changed before the restore mutation');
	});
	assert.deepEqual([guarded.ok, guarded.needsReview, guarded.commitUnknown], [false, true, undefined]);
	assert.match(guarded.annotationWarning, /lease changed before the restore mutation/);
	assert.deepEqual(guarded.designatorChanges, [{ primitiveId: 'u4', before: 'U4', after: 'U15' }, { primitiveId: 'u5', before: 'U5', after: 'U16' }]);
	assert.equal(mutationGuards, 2, 'the final guard executes again before the first restore write');
	assert.equal(f.createCalls.length, 1);
	assert.equal(f.modifyCalls.length, 0, 'lease loss after create must stop native restoration');
}

async function main() {
	const pageUuid = 'page-1';
	let documentType = 1;
	let nativePinModifyCalls = 0;
	let doneCalls = 0;
	let nativeDoneError;
	let nativePinModifyError;
	let corruptSibling = false;
	let pageReadHook;
	const adapters = [];
	const reportAdapter = adapter => adapters.push(adapter);
	const states = [pinState('pin-16', '16'), pinState('pin-17', '17')];
	function nativePin(state) {
		const primitive = { getState_PrimitiveId: () => state.primitiveId, getState_PrimitiveType: () => 'ComponentPin', getState_OtherProperty: () => ({ ...state.otherProperty }) };
		for (const [field, method] of Object.entries({ x: 'X', y: 'Y', rotation: 'Rotation', pinNumber: 'PinNumber', pinName: 'PinName', pinLength: 'PinLength', pinColor: 'PinColor', pinShape: 'PinShape', pinType: 'pinType', noConnected: 'NoConnected' }))
			primitive[`getState_${method}`] = () => state[field];
		primitive.toAsync = () => {
			const staged = {};
			return {
				setState_NoConnected(value) {
					staged.noConnected = value;
					return this;
				},
				setState_PinNumber(value) {
					staged.pinNumber = value;
					return this;
				},
				async done() {
					assert.equal(adapters.at(-1), 'component_pin_instance', 'classification is reported before native ComponentPin mutation');
					doneCalls += 1;
					if (nativeDoneError)
						throw new Error(nativeDoneError);
					Object.assign(state, staged);
					if (corruptSibling)
						states[1].y = -states[1].y;
					return nativePin(state);
				},
			};
		};
		return primitive;
	}
	globalThis.eda = {
		EDMT_EditorDocumentType: { SCHEMATIC_PAGE: 1, SYMBOL_COMPONENT: 2 },
		dmt_SelectControl: { async getCurrentDocumentInfo() { return { documentType, uuid: pageUuid }; } },
		dmt_Schematic: {
			async getCurrentSchematicPageInfo() {
				pageReadHook?.();
				return { uuid: pageUuid };
			},
		},
		sch_PrimitiveComponent: {
			async getAll(_type, allPages) {
				assert.equal(allPages, false);
				return [{
					getState_PrimitiveId: () => 'U1',
					async getAllPins() { return states.map(nativePin); },
				}];
			},
		},
		sch_PrimitivePin: {
			async modify(id, patch) {
				assert.equal(adapters.at(-1), 'native_pin', 'ordinary Pin classification is reported before native modify');
				nativePinModifyCalls += 1;
				if (nativePinModifyError)
					throw new Error(nativePinModifyError);
				return { primitiveId: id, ...patch };
			},
		},
	};
	const ncEdit = await handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitivePin.modify', args: ['pin-16', { noConnected: false }] }, reportAdapter);
	assert.deepEqual([ncEdit.ok, ncEdit.verified, ncEdit.adapter, ncEdit.after.noConnected, ncEdit.after.x, ncEdit.after.y], [true, true, 'component_pin_instance', false, 530, 330]);
	const ncWireResult = JSON.parse(JSON.stringify(await toSerializableAsync(ncEdit)));
	assert.deepEqual(ncWireResult.result, ncWireResult.after, 'final transport must preserve the native-compatible result snapshot');
	assert.equal(JSON.stringify(ncWireResult).includes('[Circular]'), false);
	assert.equal(states[1].noConnected, true);
	assert.equal(nativePinModifyCalls, 0, 'ComponentPin must bypass the faulty generic Pin.modify factory');
	const unchanged = await handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitivePin.modify', args: ['pin-16', { noConnected: false }] }, reportAdapter);
	assert.equal(unchanged.changed, false);
	const unchangedWireResult = JSON.parse(JSON.stringify(await toSerializableAsync(unchanged)));
	assert.deepEqual(unchangedWireResult.before, unchangedWireResult.after, 'no-op transport snapshots remain inspectable');
	assert.deepEqual(unchangedWireResult.result, unchangedWireResult.after);
	assert.equal(JSON.stringify(unchangedWireResult).includes('[Circular]'), false);
	assert.equal(doneCalls, 1);
	const renumbered = await handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitivePin.modify', args: ['pin-16', { pinNumber: '16A' }] }, reportAdapter);
	assert.equal(renumbered.after.pinNumber, '16A');
	assert.equal(renumbered.after.noConnected, false, 'pin number edits preserve NC state');
	await assert.rejects(handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitivePin.modify', args: ['pin-16', { y: -330 }] }), /geometry belongs to the library symbol/);
	assert.equal(nativePinModifyCalls, 0);
	corruptSibling = true;
	const drift = await handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitivePin.modify', args: ['pin-16', { noConnected: true }] }, reportAdapter);
	assert.deepEqual([drift.ok, drift.commitUnknown, drift.nativeCallSettled], [false, true, true]);
	assert.equal(requiresHostRestartForResult('/bridge/jlceda/api/invoke', { apiFullName: 'eda.sch_PrimitivePin.modify' }, drift), false, 'a completed write with state drift still requires readback without a host restart');
	assert.equal(drift.after.y, 330);
	assert.ok(drift.sideEffects.some(effect => effect.primitiveId === 'pin-17' && effect.field === 'y'));
	corruptSibling = false;
	states[1].y = 330;
	states[1].noConnected = undefined;
	const unmarkedSibling = await handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitivePin.modify', args: ['pin-16', { noConnected: false }] }, reportAdapter);
	assert.equal(unmarkedSibling.verified, true, 'official undefined NC state on an unmarked sibling remains compatible');
	const rpcFailures = ['WebSocket is not open', 'transport closed', 'ECONNABORTED'];
	const pinPayload = { apiFullName: 'eda.sch_PrimitivePin.modify', args: ['pin-16', { noConnected: true }] };
	for (const message of rpcFailures) {
		nativeDoneError = message;
		const uncertain = await handleApiInvokeTask(pinPayload, reportAdapter);
		assert.deepEqual([uncertain.ok, uncertain.commitUnknown, uncertain.readbackRequired, uncertain.nativeCallSettled], [false, true, true, false], message);
		assert.equal(uncertain.adapter, 'component_pin_instance');
		assert.equal(requiresHostRestartForResult('/bridge/jlceda/api/invoke', pinPayload, uncertain), true, message);
		assert.equal(states[0].noConnected, false, 'a rejected RPC cannot confirm the staged native state');
	}
	nativeDoneError = undefined;
	states[1].noConnected = true;
	globalThis.eda.sch_PrimitiveComponent.getAll = async () => [{ getState_PrimitiveId: () => 'U1' }];
	globalThis.eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId = async (id) => {
		assert.equal(id, 'U1');
		return states.map(nativePin);
	};
	assert.equal((await handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitivePin.modify', args: ['pin-16', { noConnected: false }] }, reportAdapter)).verified, true, 'module enumeration also yields native ComponentPin instances');
	const realPinEnumeration = globalThis.eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId;
	globalThis.eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId = async () => states.map(state => ({ ...nativePin(state), toAsync: undefined }));
	await assert.rejects(handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitivePin.modify', args: ['pin-16', { noConnected: true }] }, reportAdapter), /toAsync is unavailable/);
	globalThis.eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId = realPinEnumeration;
	let pageReads = 0;
	let staleLease = false;
	pageReadHook = () => {
		if (++pageReads === 3)
			staleLease = true;
	};
	const beforeStaleDone = doneCalls;
	await assert.rejects(handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitivePin.modify', args: ['pin-16', { noConnected: true }] }, (adapter) => {
		if (staleLease)
			throw new Error('Bridge lease changed before the pin mutation started.');
		reportAdapter(adapter);
	}), /lease changed/);
	assert.equal(pageReads, 3, 'the lease change occurs in the final page read before native done');
	assert.equal(doneCalls, beforeStaleDone, 'a lease change during final prewrite verification must not commit');
	pageReadHook = undefined;
	documentType = 2;
	const normalPin = await handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitivePin.modify', args: ['symbol-pin', { y: 100 }] }, reportAdapter);
	assert.equal(normalPin.result.y, 100);
	assert.equal(nativePinModifyCalls, 1, 'independent symbol Pin keeps its native API path');
	documentType = 1;
	const ordinaryPagePin = await handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitivePin.modify', args: ['ordinary-page-pin', { noConnected: false }] }, reportAdapter);
	assert.equal(ordinaryPagePin.result.primitiveId, 'ordinary-page-pin');
	assert.equal(adapters.at(-1), 'native_pin', 'a current-page Pin without a component owner keeps its native path');
	assert.equal(nativePinModifyCalls, 2);
	for (const message of rpcFailures) {
		nativePinModifyError = message;
		const ordinaryPayload = { apiFullName: 'eda.sch_PrimitivePin.modify', args: ['ordinary-page-pin', { noConnected: true }] };
		const uncertain = await handleApiInvokeTask(ordinaryPayload, reportAdapter);
		assert.deepEqual([uncertain.commitUnknown, uncertain.nativeCallSettled], [true, false], message);
		assert.equal(adapters.at(-1), 'native_pin');
		assert.equal(requiresHostRestartForResult('/bridge/jlceda/api/invoke', ordinaryPayload, uncertain), true, message);
	}
	nativePinModifyError = undefined;
	const beforeBlockedWrite = nativePinModifyCalls;
	await assert.rejects(handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitivePin.modify', args: ['ordinary-page-pin', { noConnected: true }] }, () => {
		throw new Error('execution context reporting failed');
	}), /execution context reporting failed/);
	assert.equal(nativePinModifyCalls, beforeBlockedWrite, 'failed classification reporting must not execute the native write');

	let createCalls = 0;
	let lookupCalls = 0;
	const validId = '12b82e200917452bb3341c77f32a2375';
	const badId = '112b82e200917452bb3341c77f32a2375';
	const item = { libraryType: '3', uuid: validId, libraryUuid: 'system', name: '0603WAF6202T5E', association: { symbolUuid: 'resistor-symbol', symbol: { uuid: 'resistor-symbol', libraryUuid: 'system' } }, subPartNames: ['0603WAF6202T5E.1'] };
	const placed = [];
	globalThis.eda.lib_Device = {
		async get(uuid, libraryUuid) {
			lookupCalls += 1;
			assert.equal(libraryUuid, 'system');
			return uuid === validId ? item : undefined;
		},
	};
	globalThis.eda.sch_PrimitiveComponent = {
		async create(component, x, y, subPartName) {
			createCalls += 1;
			assert.equal(component, item, 'resolved complete DeviceItem is passed to the native overload');
			assert.equal(subPartName, '0603WAF6202T5E.1');
			const primitive = { getState_PrimitiveId: () => `r${createCalls}`, getState_Designator: () => `R${createCalls}`, x, y };
			placed.push(primitive);
			return primitive;
		},
		async getAll() { return placed; },
	};
	const missingCreate = await handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitiveComponent.create', args: [{ uuid: badId, libraryUuid: 'system' }, 300, 400] });
	assert.deepEqual([missingCreate.errorCode, missingCreate.applied, missingCreate.nativeCallStarted, missingCreate.commitUnknown], ['DEVICE_NOT_FOUND', false, false, undefined]);
	assert.equal(createCalls, 0);
	const missingAuto = await handleComponentPlaceAutoTask({ components: [{ uuid: badId, libraryUuid: 'system', x: 300, y: 400 }] });
	assert.deepEqual([missingAuto.errorCode, missingAuto.placedCount, missingAuto.failedCount, missingAuto.applied], ['DEVICE_NOT_FOUND', 0, 1, false]);
	assert.equal(createCalls, 0);
	const validCreate = await handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitiveComponent.create', args: [{ uuid: validId, libraryUuid: 'system' }, 300, 400] });
	assert.equal(validCreate.result.x, 300);
	assert.equal(createCalls, 1);
	const auto = await handleComponentPlaceAutoTask({ components: [{ uuid: validId, libraryUuid: 'system', x: 350, y: 400 }] });
	assert.equal(auto.ok, true);
	assert.equal(auto.placedCount, 1);
	const beforeWrongLibraryCreate = createCalls;
	globalThis.eda.lib_Device.get = async () => ({ ...item, libraryUuid: 'different-library' });
	const wrongLibraryCreate = await handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitiveComponent.create', args: [{ uuid: validId, libraryUuid: 'system' }, 300, 400] });
	assert.deepEqual([wrongLibraryCreate.errorCode, wrongLibraryCreate.applied, wrongLibraryCreate.nativeCallStarted], ['DEVICE_LOOKUP_MISMATCH', false, false]);
	const wrongLibraryAuto = await handleComponentPlaceAutoTask({ components: [{ uuid: validId, libraryUuid: 'system', x: 350, y: 400 }] });
	assert.equal(wrongLibraryAuto.errorCode, 'DEVICE_LOOKUP_MISMATCH');
	assert.equal(createCalls, beforeWrongLibraryCreate, '同 UUID 的其他库版本不能交给原生创建');
	const beforeDirectLookup = lookupCalls;
	globalThis.eda.lib_Device.get = async () => {
		throw new Error('Full official DeviceItem must not require another lookup');
	};
	assert.equal((await handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitiveComponent.create', args: [item, 400, 400] })).result.x, 400);
	assert.equal(lookupCalls, beforeDirectLookup);
	delete globalThis.eda.lib_Device;
	assert.equal((await handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitiveComponent.create', args: [item, 450, 400] })).result.x, 450, 'complete native item remains usable without the get capability');
	await rawSchematicCreateTests();
	console.log('Schematic native pin and library creation compatibility tests passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
