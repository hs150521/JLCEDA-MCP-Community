const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');
const { handleComponentPlaceAutoTask } = require('../src/mcp/component-place-auto-handler.ts');
const { handleApiInvokeTask } = require('../src/mcp/invoke-handler.ts');
const { toSerializableAsync } = require('../src/utils.ts');

function pinState(id, number) {
	return { primitiveId: id, x: 530, y: 330, rotation: 180, pinNumber: number, pinName: 'IO', pinLength: 10, pinColor: null, pinShape: 'None', pinType: 'BI', noConnected: true, otherProperty: { net: 'IO' } };
}

async function main() {
	const pageUuid = 'page-1';
	let documentType = 1;
	let nativePinModifyCalls = 0;
	let doneCalls = 0;
	let corruptSibling = false;
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
					doneCalls += 1;
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
		dmt_Schematic: { async getCurrentSchematicPageInfo() { return { uuid: pageUuid }; } },
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
				nativePinModifyCalls += 1;
				return { primitiveId: id, ...patch };
			},
		},
	};
	const ncEdit = await handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitivePin.modify', args: ['pin-16', { noConnected: false }] });
	assert.deepEqual([ncEdit.ok, ncEdit.verified, ncEdit.adapter, ncEdit.after.noConnected, ncEdit.after.x, ncEdit.after.y], [true, true, 'component_pin_instance', false, 530, 330]);
	const ncWireResult = JSON.parse(JSON.stringify(await toSerializableAsync(ncEdit)));
	assert.deepEqual(ncWireResult.result, ncWireResult.after, 'final transport must preserve the native-compatible result snapshot');
	assert.equal(JSON.stringify(ncWireResult).includes('[Circular]'), false);
	assert.equal(states[1].noConnected, true);
	assert.equal(nativePinModifyCalls, 0, 'ComponentPin must bypass the faulty generic Pin.modify factory');
	const unchanged = await handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitivePin.modify', args: ['pin-16', { noConnected: false }] });
	assert.equal(unchanged.changed, false);
	const unchangedWireResult = JSON.parse(JSON.stringify(await toSerializableAsync(unchanged)));
	assert.deepEqual(unchangedWireResult.before, unchangedWireResult.after, 'no-op transport snapshots remain inspectable');
	assert.deepEqual(unchangedWireResult.result, unchangedWireResult.after);
	assert.equal(JSON.stringify(unchangedWireResult).includes('[Circular]'), false);
	assert.equal(doneCalls, 1);
	const renumbered = await handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitivePin.modify', args: ['pin-16', { pinNumber: '16A' }] });
	assert.equal(renumbered.after.pinNumber, '16A');
	assert.equal(renumbered.after.noConnected, false, 'pin number edits preserve NC state');
	await assert.rejects(handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitivePin.modify', args: ['pin-16', { y: -330 }] }), /geometry belongs to the library symbol/);
	assert.equal(nativePinModifyCalls, 0);
	corruptSibling = true;
	const drift = await handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitivePin.modify', args: ['pin-16', { noConnected: true }] });
	assert.deepEqual([drift.ok, drift.commitUnknown, drift.nativeCallSettled], [false, true, true]);
	assert.equal(drift.after.y, 330);
	assert.ok(drift.sideEffects.some(effect => effect.primitiveId === 'pin-17' && effect.field === 'y'));
	corruptSibling = false;
	states[1].y = 330;
	states[1].noConnected = undefined;
	const unmarkedSibling = await handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitivePin.modify', args: ['pin-16', { noConnected: false }] });
	assert.equal(unmarkedSibling.verified, true, 'official undefined NC state on an unmarked sibling remains compatible');
	states[1].noConnected = true;
	globalThis.eda.sch_PrimitiveComponent.getAll = async () => [{ getState_PrimitiveId: () => 'U1' }];
	globalThis.eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId = async (id) => {
		assert.equal(id, 'U1');
		return states.map(nativePin);
	};
	assert.equal((await handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitivePin.modify', args: ['pin-16', { noConnected: false }] })).verified, true, 'module enumeration also yields native ComponentPin instances');
	const realPinEnumeration = globalThis.eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId;
	globalThis.eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId = async () => states.map(state => ({ ...nativePin(state), toAsync: undefined }));
	await assert.rejects(handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitivePin.modify', args: ['pin-16', { noConnected: true }] }), /toAsync is unavailable/);
	globalThis.eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId = realPinEnumeration;
	documentType = 2;
	const normalPin = await handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitivePin.modify', args: ['symbol-pin', { y: 100 }] });
	assert.equal(normalPin.result.y, 100);
	assert.equal(nativePinModifyCalls, 1, 'independent symbol Pin keeps its native API path');
	documentType = 1;

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
	const beforeDirectLookup = lookupCalls;
	globalThis.eda.lib_Device.get = async () => {
		throw new Error('Full official DeviceItem must not require another lookup');
	};
	assert.equal((await handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitiveComponent.create', args: [item, 400, 400] })).result.x, 400);
	assert.equal(lookupCalls, beforeDirectLookup);
	delete globalThis.eda.lib_Device;
	assert.equal((await handleApiInvokeTask({ apiFullName: 'eda.sch_PrimitiveComponent.create', args: [item, 450, 400] })).result.x, 450, 'complete native item remains usable without the get capability');
	console.log('Schematic native pin and library creation compatibility tests passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
