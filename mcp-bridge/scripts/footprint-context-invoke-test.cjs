const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');
const { footprintApiAccess, isReadOnlyBridgeRequest } = require('../src/bridge/bridge-contract.ts');
const { assertFootprintIdentity, readFootprintIdentity } = require('../src/bridge/editor-context.ts');
const { handleEdaContextTask } = require('../src/mcp/context-handler.ts');
const { handleFootprintReadTask } = require('../src/mcp/footprint-read-handler.ts');
const { handleApiInvokeTask } = require('../src/mcp/invoke-handler.ts');
const { toSerializableAsync } = require('../src/utils.ts');

const TYPES = { pad: 'Pad', via: 'Via', line: 'Line', arc: 'Arc', polyline: 'Polyline', string: 'String', attribute: 'Attribute' };
const LINE = { net: '', layer: 3, startX: 1, startY: 2, endX: 50, endY: 70, lineWidth: 6 };
const TEXT = { layer: 3, x: 5, y: 7, fontFamily: 'default', fontSize: 40, lineWidth: 5, alignMode: 5, rotation: 45, reverse: false, expansion: 0, mirror: true };
const STATES = {
	pad: { layer: 12, padNumber: '1', x: 100, y: 200, rotation: 90, net: undefined, pad: ['ELLIPSE', 80, 60], hole: ['ROUND', 35], holeOffsetX: 2, holeOffsetY: -3, holeRotation: 15, metallization: true, padType: 0, specialPad: undefined, solderMaskAndPasteMaskExpansion: null, heatWelding: null },
	via: { net: '', x: 40, y: 60, holeDiameter: 19, diameter: 39, viaType: 0, designRuleBlindViaName: null, solderMaskExpansion: null },
	line: LINE,
	arc: { ...LINE, arcAngle: 90, interactiveMode: 1 },
	polyline: { net: null, layer: 10, lineWidth: 1, polygonSource: ['R', 0, 0, 100, 200, 0, 0] },
	string: { ...TEXT, text: 'FP_TEST' },
	attribute: { ...TEXT, x: null, y: null, parentPrimitiveId: 'footprint-parent', key: 'Value', value: 'FOOTPRINT', keyVisible: false, valueVisible: true },
};

function native(kind, id, patch = {}) {
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
	const document = { documentType: 4, uuid: 'fp-document', parentLibraryUuid: 'library-one', tabId: 'fp-tab', parentProjectUuid: 'cached-project' };
	const calls = [];
	const stores = {};
	const controls = {};
	const runtime = {
		dmt_SelectControl: { async getCurrentDocumentInfo() {
			return { ...document };
		} },
		dmt_Project: { async getCurrentProjectInfo() {
			return { uuid: 'cached-project' };
		} },
		dmt_Pcb: { async getCurrentPcbInfo() {
			return { uuid: 'cached-pcb' };
		} },
		dmt_Schematic: { async getCurrentSchematicPageInfo() {
			return { uuid: 'cached-schematic' };
		} },
		pcb_MathPolygon: { createPolygon(source) {
			calls.push(['polygon', source]);
			return { getSource: () => source };
		} },
		lib_Footprint: { async openInEditor(...args) {
			calls.push(['openInEditor', args]);
			return 'new-tab';
		} },
		sys_FontManager: { async getFontsList() {
			calls.push(['fonts']);
			return ['default', 'Arial'];
		} },
		sys_Storage: { getExtensionUserConfig() {}, async setExtensionUserConfig() {} },
		sys_MessageBus: { subscribe() {
			return { running: () => true, cancel() {} };
		}, publish() {} },
		sys_Message: { showToastMessage() {} },
	};
	for (const [kind, type] of Object.entries(TYPES)) {
		const store = stores[kind] = new Map([[`${kind}-1`, native(kind, `${kind}-1`)]]);
		const editable = (id) => {
			const raw = store.get(id);
			if (!raw)
				return raw;
			const target = Object.create(raw);
			const property = {};
			let asyncMode = false;
			target.toAsync = () => {
				asyncMode = true;
				calls.push([kind, 'toAsync', id]);
				return target;
			};
			target.isAsync = () => asyncMode;
			for (const field of [...Object.keys(STATES[kind]), 'primitiveLock', 'polygon']) {
				target[`setState_${field[0].toUpperCase()}${field.slice(1)}`] = (value) => {
					assert.equal(asyncMode, true, 'setters must not trigger implicit native writes');
					property[field] = value;
					if (kind === 'pad' && value) {
						if (field === 'pad')
							property.specialPad = undefined;
						if (field === 'specialPad')
							property.pad = undefined;
					}
					calls.push([kind, 'setter', field, value]);
					return target;
				};
			}
			target.done = async () => {
				calls.push([kind, 'done', id, { ...property }]);
				await controls[kind]?.gate?.promise;
				const previous = {};
				for (const field of [...Object.keys(STATES[kind]), 'primitiveLock']) {
					previous[field] = field === 'polygonSource' ? raw.getState_Polygon().getSource() : raw[`getState_${field[0].toUpperCase()}${field.slice(1)}`]();
				}
				const applied = { ...property };
				if (applied.polygon !== undefined) {
					applied.polygonSource = applied.polygon.getSource();
					delete applied.polygon;
				}
				for (const field of controls[kind]?.ignoredFields ?? [])
					delete applied[field];
				store.set(id, native(kind, id, { ...previous, ...applied, ...controls[kind]?.actualPatch }));
				controls[kind]?.afterCommit?.();
				if (controls[kind]?.error)
					throw controls[kind].error;
				return target;
			};
			return target;
		};
		const api = runtime[`pcb_Primitive${type}`] = {
			async get(id) {
				calls.push([kind, 'get', id]);
				return Array.isArray(id) ? id.map(value => store.get(value)).filter(Boolean) : editable(id);
			},
			async getAll(...args) {
				calls.push([kind, 'getAll', args]);
				return [...store.values()];
			},
			async getAllPrimitiveId(...args) {
				calls.push([kind, 'getAllPrimitiveId', args]);
				return [...store.keys()];
			},
			async modify(id, property) {
				calls.push([kind, 'modify', id, property]);
				const result = native(kind, id, property.polygon ? { polygonSource: property.polygon.getSource() } : property);
				store.set(id, result);
				return result;
			},
			async delete(ids) {
				calls.push([kind, 'delete', ids]);
				for (const id of Array.isArray(ids) ? ids : [ids]) store.delete(id);
				return true;
			},
		};
		if (kind !== 'attribute') {
			api.create = async (...args) => {
				calls.push([kind, 'create', args]);
				const id = `${kind}-created`;
				const result = native(kind, id, kind === 'polyline' ? { polygonSource: args[2].getSource() } : {});
				store.set(id, result);
				return result;
			};
		}
	}
	globalThis.eda = runtime;
	return { document, runtime, calls, stores, controls };
}

const invoke = (kind, method, args = [], extra = {}) => handleApiInvokeTask({ apiFullName: `eda.pcb_Primitive${TYPES[kind]}.${method}`, args, ...extra });

async function handlerTests() {
	let f = fixture();
	const identity = await readFootprintIdentity(f.runtime);
	assert.deepEqual(identity, { pageKind: 'footprint', documentType: 4, documentUuid: 'fp-document', pageUuid: 'fp-document', libraryUuid: 'library-one', tabId: 'fp-tab' });
	assert.equal(identity.projectUuid, undefined);
	assert.deepEqual((await handleEdaContextTask({})).footprintContext, identity);
	delete f.document.parentLibraryUuid;
	const missing = await handleEdaContextTask({});
	assert.equal(missing.footprintContext, null);
	assert.match(missing.footprintContextError, /library UUID/);
	await assert.rejects(readFootprintIdentity(f.runtime), /library UUID/);

	let readMethods = 0;
	let writeMethods = 0;
	for (const kind of Object.keys(TYPES)) {
		f = fixture();
		for (const method of ['get', 'getAll', 'getAllPrimitiveId']) {
			const name = `eda.pcb_Primitive${TYPES[kind]}.${method}`;
			assert.equal(footprintApiAccess(name), 'read');
			assert.equal(isReadOnlyBridgeRequest('/bridge/jlceda/api/invoke', { apiFullName: name, args: ['filter'] }), true);
			const value = await invoke(kind, method, method === 'get' ? [`${kind}-1`] : []);
			assert.equal(value.identityVerified, true);
			assert.equal(value.libraryUuid, 'library-one');
			assert.equal(value.pageUuid, 'fp-document');
			readMethods += 1;
		}
		const requested = await invoke(kind, 'get', [[`${kind}-1`, 'missing']]);
		assert.equal(requested.result.length, 1, 'native get(ids) may omit IDs that are absent');
		if (kind !== 'attribute') {
			assert.equal(footprintApiAccess(`eda.pcb_Primitive${TYPES[kind]}.create`), 'write');
			const created = await invoke(kind, 'create', kind === 'polyline' ? ['', 10, { polygonSource: STATES.polyline.polygonSource }] : []);
			assert.equal(created.after.primitiveId, `${kind}-created`);
			assert.equal(created.identityVerified, true);
			writeMethods += 1;
		}
		for (const method of ['modify', 'delete']) {
			assert.equal(footprintApiAccess(`eda.pcb_Primitive${TYPES[kind]}.${method}`), 'write');
			const value = await invoke(kind, method, method === 'modify' ? [`${kind}-1`, { primitiveLock: true }] : [[`${kind}-1`]]);
			assert.equal(value.identityVerified, true);
			assert.equal(value.commitUnknown, undefined);
			if (method === 'modify')
				assert.equal(value.after.primitiveLock, true);
			else assert.deepEqual(value.deletedIds, [`${kind}-1`]);
			writeMethods += 1;
		}
	}
	assert.deepEqual([readMethods, writeMethods], [21, 20]);
	for (const holeRotation of [null, undefined, Number.NaN]) {
		f = fixture();
		f.runtime.pcb_PrimitivePad.create = async () => {
			const result = native('pad', 'smd-created', { hole: null, holeRotation, specialPad: [] });
			f.stores.pad.set('smd-created', result);
			return result;
		};
		const smd = await invoke('pad', 'create');
		assert.equal(smd.commitUnknown, undefined, 'a confirmed no-hole pad must not enter unknown commit for null, undefined or native NaN hole rotation');
		assert.equal(smd.after.primitiveId, 'smd-created');
		assert.equal(smd.after.hole, null);
		assert.equal(smd.after.holeRotation, null);
		assert.deepEqual(smd.after.specialPad, []);
	}
	for (const name of ['eda.pcb_PrimitiveAttribute.create', 'eda.pcb_PrimitiveComponent.getAll', 'eda.pcb_Document.save', 'eda.sch_PrimitivePin.modify']) {
		f = fixture();
		const rejected = await handleApiInvokeTask({ apiFullName: name, args: [] });
		assert.equal(rejected.code, 'UNSUPPORTED_FOOTPRINT_API');
		assert.equal(rejected.nativeCallAttempted, false);
		assert.equal(f.calls.length, 0);
	}
	f = fixture();
	assert.equal((await handleApiInvokeTask({ apiFullName: 'eda.lib_Footprint.openInEditor', args: ['other-footprint', 'other-library'] })).result, 'new-tab');
	assert.deepEqual(f.calls[0], ['openInEditor', ['other-footprint', 'other-library']]);

	f = fixture();
	f.stores.pad.clear();
	for (let index = 0; index < 230; index++)
		f.stores.pad.set(`pad-${index}`, native('pad', `pad-${index}`));
	assert.equal(JSON.parse(JSON.stringify(await toSerializableAsync(await invoke('pad', 'getAll')))).result.length, 230);
	f = fixture();
	const polygonSource = [0, 0, 'L', ...Array.from({ length: 500 }, (_, index) => index)];
	const created = await invoke('polyline', 'create', ['', 10, polygonSource]);
	const serialized = JSON.parse(JSON.stringify(await toSerializableAsync(created)));
	assert.deepEqual(serialized.after.polygonSource, polygonSource);
	assert.deepEqual(f.calls.find(call => call[0] === 'polygon')[1], polygonSource);
	const changed = await invoke('polyline', 'modify', ['polyline-created', { polygonSource: ['R', 0, 0, 50, 70, 0, 0] }]);
	assert.deepEqual(changed.after.polygonSource, ['R', 0, 0, 50, 70, 0, 0]);
	assert.equal(f.calls.findLast(call => call[0] === 'polyline' && call[1] === 'done')[3].polygonSource, undefined);

	// 执行上下文与当前画布分支一致，切换到 PCB 不得继续写入缓存 PCB。
	f = fixture();
	const expected = await readFootprintIdentity(f.runtime);
	f.document.documentType = 3;
	await assert.rejects(invoke('line', 'create', [], { expectedFootprintIdentity: expected }), /not a footprint/);
	assert.equal(f.calls.length, 0);
	f = fixture();
	await assert.rejects(invoke('line', 'create', [], { expectedEditorPageKind: 'pcb' }), /page kind changed/);
	assert.equal(f.calls.length, 0);
	f.document.tabId = 'reopened-tab';
	await assert.rejects(assertFootprintIdentity(f.runtime, expected), /changed/);
	assert.equal((await readFootprintIdentity(f.runtime)).tabId, 'reopened-tab', 'a new recovery operation can use the reopened tab');

	for (const field of ['uuid', 'parentLibraryUuid', 'tabId', 'documentType']) {
		f = fixture();
		const original = f.runtime.pcb_PrimitiveLine.create;
		f.runtime.pcb_PrimitiveLine.create = async (...args) => {
			const result = await original(...args);
			f.document[field] = field === 'documentType' ? 3 : 'changed';
			return result;
		};
		const result = await invoke('line', 'create');
		assert.equal(result.commitUnknown, true);
		assert.equal(result.reason, 'post_write_footprint_readback_failed');
		assert.equal(result.nativeCallSettled, true);
	}
	f = fixture();
	f.runtime.pcb_PrimitiveLine.create = async () => {
		throw new Error('socket connection closed');
	};
	assert.equal((await invoke('line', 'create')).nativeCallSettled, false);
	f.runtime.pcb_PrimitiveLine.create = async () => undefined;
	assert.equal((await invoke('line', 'create')).commitUnknown, true);
	f.runtime.pcb_PrimitiveLine.delete = async () => true;
	assert.equal((await invoke('line', 'delete', ['line-1'])).reason, 'native_footprint_delete_incomplete');
}

function deferred() {
	let resolve;
	const promise = new Promise(done => resolve = done);
	return { promise, resolve };
}

async function modifyCommitTests() {
	const f = fixture();
	f.stores.pad.set('pad-1', native('pad', 'pad-1', { pad: ['ELLIPSE', 60, 60] }));
	const gate = deferred();
	f.controls.pad = { gate };
	let settled = false;
	const pending = invoke('pad', 'modify', ['pad-1', { x: 120, y: 80, rotation: 45, pad: ['ELLIPSE', 80, 60] }]).then((result) => {
		settled = true;
		return result;
	});
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(f.calls.filter(call => call[0] === 'pad' && call[1] === 'modify').length, 0, 'the fire-and-forget native wrapper must not be called');
	assert.equal(f.calls.filter(call => call[0] === 'pad' && call[1] === 'done').length, 1, 'one native commit must start');
	assert.equal(settled, false, 'the invoke result must await the actual native commit');
	assert.equal(f.calls.filter(call => call[0] === 'pad' && call[1] === 'get').length, 1, 'post-write readback must wait for native acknowledgement');
	assert.equal(f.stores.pad.get('pad-1').getState_X(), 100);
	assert.deepEqual(f.stores.pad.get('pad-1').getState_Pad(), ['ELLIPSE', 60, 60]);
	gate.resolve();
	const result = await pending;
	assert.equal(result.nativeCallSettled, undefined);
	assert.deepEqual([result.after.x, result.after.y, result.after.rotation, result.after.pad], [120, 80, 45, ['ELLIPSE', 80, 60]]);
	assert.equal(f.calls.filter(call => call[0] === 'pad' && call[1] === 'get').length, 2);
}

async function modifyMappingTests() {
	const fields = {
		pad: { layer: 12, padNumber: 'A1', x: 0, y: 0, rotation: 0, pad: ['ELLIPSE', 90, 60], net: '', hole: null, holeOffsetX: 0, holeOffsetY: 0, holeRotation: 0, metallization: false, solderMaskAndPasteMaskExpansion: null, heatWelding: null, primitiveLock: false },
		via: { net: '', x: 0, y: 0, holeDiameter: 20, diameter: 40, viaType: 0, designRuleBlindViaName: null, solderMaskExpansion: null, primitiveLock: false },
		line: { net: '', layer: 3, startX: 0, startY: 0, endX: 50, endY: 70, lineWidth: 8, primitiveLock: false },
		arc: { net: '', layer: 3, startX: 0, startY: 0, endX: 50, endY: 70, arcAngle: 60, lineWidth: 8, interactiveMode: 1, primitiveLock: false },
		polyline: { net: '', layer: 3, polygonSource: [0, 0, 'L', 50, 0, 50, 50], lineWidth: 8, primitiveLock: false },
		string: { fontFamily: 'Arial', layer: 3, x: 0, y: 0, text: 'mapped', fontSize: 40, lineWidth: 5, alignMode: 5, rotation: 0, reverse: false, expansion: 0, mirror: false, primitiveLock: false },
		attribute: { layer: 3, x: 0, y: 0, key: 'Value', value: 'mapped', keyVisible: false, valueVisible: false, fontFamily: 'Arial', fontSize: 40, lineWidth: 5, alignMode: 5, rotation: 0, reverse: false, expansion: 0, mirror: false, primitiveLock: false },
	};
	for (const [kind, property] of Object.entries(fields)) {
		const f = fixture();
		const result = await invoke(kind, 'modify', [`${kind}-1`, { ...property, unknownField: 'ignored', padType: 2 }]);
		assert.equal(result.identityVerified, true);
		assert.equal(result.commitUnknown, undefined);
		assert.equal(result.ok, undefined, `${kind} must not falsely report incomplete normal modifications`);
		assert.equal(result.fieldMismatches, undefined);
		const setters = f.calls.filter(call => call[0] === kind && call[1] === 'setter');
		assert.deepEqual(setters.map(call => call[2]), Object.keys(property).map(field => field === 'polygonSource' ? 'polygon' : field), `${kind} must retain the official setter order`);
		for (const call of setters) {
			if (call[2] === 'polygon')
				assert.deepEqual(call[3].getSource(), property.polygonSource);
			else assert.deepEqual(call[3], property[call[2]], `${kind}.${call[2]} must preserve false, zero, null and native shape values`);
		}
		assert.equal(f.calls.filter(call => call[0] === kind && call[1] === 'done').length, 1);
		assert.equal(f.calls.some(call => call[0] === kind && call[1] === 'modify'), false);
		assert.equal(f.calls.filter(call => call[0] === 'fonts').length, kind === 'string' ? 1 : 0);
		if (kind === 'pad')
			assert.equal(result.after.padType, 0, 'modify does not expose the create-only padType field');
	}
	let f = fixture();
	await invoke('line', 'modify', ['line-1', { net: undefined, primitiveLock: false }]);
	assert.deepEqual(f.calls.filter(call => call[0] === 'line' && call[1] === 'setter').map(call => call[2]), ['primitiveLock']);
	f = fixture();
	await assert.rejects(invoke('string', 'modify', ['string-1', { fontFamily: 'missing-font' }]), /font list does not contain/);
	assert.equal(f.calls.some(call => call[1] === 'done' || call[1] === 'setter'), false, 'unknown fonts must be refused before any native mutation');
	f = fixture();
	await assert.rejects(invoke('via', 'modify', ['via-1', { solderMaskExpansion: [] }]), /solderMaskExpansion/);
	assert.equal(f.calls.some(call => call[1] === 'done'), false);
	f = fixture();
	f.controls.line = { error: new Error('ETIMEDOUT') };
	const unknown = await invoke('line', 'modify', ['line-1', { lineWidth: 9 }]);
	assert.equal(unknown.commitUnknown, true);
	assert.equal(unknown.nativeCallSettled, false, 'a failed done acknowledgement cannot claim the native call is settled');
	assert.equal(unknown.readbackRequired, true);
	assert.equal(f.calls.filter(call => call[0] === 'line' && call[1] === 'get').length, 1, 'an unsettled mutation must not perform eager post-write readback');
	const full = await handleFootprintReadTask({});
	assert.equal(full.complete, true);
	assert.equal(full.lines[0].lineWidth, 9, 'full recovery readback must report the actual committed state after an acknowledgement failure');
	f = fixture();
	f.controls.line = { afterCommit() {
		f.document.tabId = 'changed-tab';
	} };
	const switched = await invoke('line', 'modify', ['line-1', { lineWidth: 9 }]);
	assert.equal(switched.commitUnknown, true);
	assert.equal(switched.nativeCallSettled, true, 'a completed done followed by an identity failure remains settled');
	assert.equal(switched.nativePrimitiveId, 'line-1');
	f = fixture();
	const get = f.runtime.pcb_PrimitiveLine.get;
	f.runtime.pcb_PrimitiveLine.get = async (id) => {
		const raw = await get(id);
		f.document.tabId = 'changed-before-done';
		return raw;
	};
	await assert.rejects(invoke('line', 'modify', ['line-1', { lineWidth: 9 }]), /changed/);
	assert.equal(f.calls.some(call => call[1] === 'done'), false, 'switching editor during pre-read must prevent the native commit');
}

async function partialModificationTests() {
	let f = fixture();
	f.stores.pad.set('pad-1', native('pad', 'pad-1', { pad: ['ELLIPSE', 60, 60] }));
	f.controls.pad = { ignoredFields: ['pad'] };
	const partial = await invoke('pad', 'modify', ['pad-1', { x: 130, pad: ['ELLIPSE', 80, 60] }]);
	assert.equal(partial.ok, false);
	assert.equal(partial.reason, 'native_footprint_modify_incomplete');
	assert.equal(partial.identityVerified, true);
	assert.equal(partial.after.x, 130);
	assert.deepEqual(partial.after.pad, ['ELLIPSE', 60, 60]);
	assert.deepEqual(partial.fieldMismatches, [{ field: 'pad', requested: ['ELLIPSE', 80, 60], actual: ['ELLIPSE', 60, 60] }]);
	assert.equal(partial.commitUnknown, undefined, 'a known partial native result must not enter unknown commit');
	assert.equal(partial.readbackRequired, undefined);
	assert.equal((await invoke('pad', 'modify', ['pad-1', { x: 140 }])).ok, undefined);
	assert.equal(f.stores.pad.size, 1, 'known partial results must not replace or duplicate the Pad');
	f = fixture();
	f.controls.pad = { actualPatch: { holeRotation: 14.999999999999998 } };
	const rounded = await invoke('pad', 'modify', ['pad-1', { hole: ['SLOT', 30, 50], holeRotation: 15 }]);
	assert.equal(rounded.ok, undefined, 'normal native floating point conversion must not report an incomplete rotation');
	assert.equal(rounded.fieldMismatches, undefined);
	assert.equal(rounded.after.holeRotation, 14.999999999999998);
	f = fixture();
	f.controls.pad = { actualPatch: { hole: null, holeRotation: Number.NaN } };
	const smd = await invoke('pad', 'modify', ['pad-1', { hole: null, holeRotation: 0 }]);
	assert.equal(smd.after.holeRotation, null);
	assert.equal(smd.fieldMismatches, undefined, 'a no-hole Pad has no applicable hole rotation even when the default zero is supplied');
	assert.equal(smd.ok, undefined);
	f = fixture();
	f.controls.via = { actualPatch: { solderMaskExpansion: { topSolderMask: 0, bottomSolderMask: 2 } } };
	const patch = await invoke('via', 'modify', ['via-1', { solderMaskExpansion: { topSolderMask: 0 } }]);
	assert.equal(patch.fieldMismatches, undefined, 'object patches compare requested subfields without requiring absent fields to disappear');
	const mismatch = await invoke('via', 'modify', ['via-1', { solderMaskExpansion: { topSolderMask: 1 } }]);
	assert.deepEqual(mismatch.fieldMismatches, [{ field: 'solderMaskExpansion', requested: { topSolderMask: 1 }, actual: { topSolderMask: 0, bottomSolderMask: 2 } }]);
	assert.equal(mismatch.commitUnknown, undefined);
	f = fixture();
	f.controls.via = { actualPatch: { solderMaskExpansion: null } };
	const emptyPatch = await invoke('via', 'modify', ['via-1', { solderMaskExpansion: {} }]);
	assert.equal(emptyPatch.fieldMismatches, undefined, 'an empty object patch has no requested subfields to compare');
	const inheritPatch = await invoke('via', 'modify', ['via-1', { solderMaskExpansion: { topSolderMask: null } }]);
	assert.equal(inheritPatch.fieldMismatches, undefined, 'an inherited mask subfield has no literal override to compare');
	f = fixture();
	f.controls.pad = { actualPatch: { solderMaskAndPasteMaskExpansion: { topSolderMask: 2, bottomSolderMask: 2, topPasteMask: 0, bottomPasteMask: 0 } } };
	const inherited = await invoke('pad', 'modify', ['pad-1', { solderMaskAndPasteMaskExpansion: null }]);
	assert.equal(inherited.fieldMismatches, undefined, 'inherit-rule mask values cannot be judged from their effective numeric readback');
	f = fixture();
	const requestedSource = [0, 0, 'L', 50, 0, 50, 50];
	const actualSource = [0, 0, 'L', 55, 0, 50, 50];
	f.controls.polyline = { actualPatch: { polygonSource: actualSource } };
	const polygon = await invoke('polyline', 'modify', ['polyline-1', { polygonSource: requestedSource }]);
	assert.deepEqual(polygon.fieldMismatches, [{ field: 'polygonSource', requested: requestedSource, actual: actualSource }]);
	assert.equal(polygon.commitUnknown, undefined);
	f = fixture();
	const closedSource = [500, 400, 'L', 650, 400, 650, 550, 500, 550, 500, 400];
	const reversedSource = [500, 400, 'L', 500, 550, 650, 550, 650, 400, 500, 400];
	f.controls.polyline = { actualPatch: { polygonSource: reversedSource } };
	const reversed = await invoke('polyline', 'modify', ['polyline-1', { polygonSource: closedSource }]);
	assert.equal(reversed.ok, undefined, 'the actual native clockwise reversal represents the same closed Polyline');
	assert.equal(reversed.fieldMismatches, undefined);
	assert.deepEqual(reversed.after.polygonSource, reversedSource, 'the actual native source remains visible without rewriting it to the request');
	const widerSource = [500, 400, 'L', 500, 550, 660, 550, 660, 400, 500, 400];
	f.controls.polyline.actualPatch.polygonSource = widerSource;
	const wider = await invoke('polyline', 'modify', ['polyline-1', { polygonSource: closedSource }]);
	assert.equal(wider.ok, false, 'a genuinely different closed Polyline width must remain incomplete');
	assert.deepEqual(wider.fieldMismatches, [{ field: 'polygonSource', requested: closedSource, actual: widerSource }]);
	assert.equal(wider.commitUnknown, undefined);
}

async function missingPrimitiveTests() {
	for (const kind of ['arc', 'polyline', 'attribute']) {
		let f = fixture();
		const api = f.runtime[`pcb_Primitive${TYPES[kind]}`];
		const get = api.get;
		api.get = async id => f.stores[kind].has(id) ? get(id) : [];
		const deleted = await invoke(kind, 'delete', [`${kind}-1`]);
		assert.deepEqual(deleted.deletedIds, [`${kind}-1`]);
		assert.deepEqual(deleted.remainingIds, []);
		assert.equal(deleted.ok, undefined);
		assert.equal(deleted.commitUnknown, undefined);
		await assert.rejects(invoke(kind, 'modify', [`${kind}-1`, { primitiveLock: true }]), /was not found/);
		assert.equal(f.calls.some(call => call[1] === 'done'), false);
		f = fixture();
		f.runtime[`pcb_Primitive${TYPES[kind]}`].delete = async () => true;
		f.runtime[`pcb_Primitive${TYPES[kind]}`].get = async id => [f.stores[kind].get(id)];
		const remaining = await invoke(kind, 'delete', [`${kind}-1`]);
		assert.deepEqual(remaining.deletedIds, []);
		assert.deepEqual(remaining.remainingIds, [`${kind}-1`]);
		assert.equal(remaining.ok, false, 'a nonempty native array still denotes a remaining primitive');
	}
	let f = fixture();
	f.runtime.pcb_PrimitiveArc.get = async () => [];
	const absent = await invoke('arc', 'create');
	assert.equal(absent.commitUnknown, true, 'an absent created Arc must not be treated as a confirmed creation');
	assert.equal(absent.nativeCallSettled, true);
	assert.equal(absent.nativePrimitiveId, 'arc-created', 'failed readback retains the unconfirmed native ID for diagnosis');
	assert.equal(absent.after, undefined);
	f = fixture();
	f.runtime.pcb_PrimitiveArc.create = async () => ({ getState_PrimitiveId: () => ['unexpected-id'] });
	const invalid = await invoke('arc', 'create');
	assert.equal(invalid.commitUnknown, true);
	assert.equal(invalid.nativeCallSettled, true);
	assert.deepEqual(invalid.nativePrimitiveId, ['unexpected-id'], 'bounded diagnosis preserves the real malformed native return');
	assert.equal(f.calls.some(call => call[0] === 'arc' && call[1] === 'get'), false, 'non-string native IDs must not be used as get targets');
}

let activeTransport;
class MockBridgeTransport {
	constructor(_url, _socketId, clientId, _version, context, callbacks) {
		this.clientId = clientId;
		this.context = context;
		this.callbacks = callbacks;
		this.results = new Map();
		this.waiters = new Map();
		this.started = new Map();
		activeTransport = this;
	}

	async connect() {
		this.callbacks.onRoleChanged({ type: 'bridge/role', clientId: this.clientId, activeClientId: this.clientId, role: 'active', leaseTerm: 1 });
	}

	completeTask(id, _lease, result, error) {
		const value = { result, error };
		this.results.set(id, value);
		this.waiters.get(id)?.(value);
	}

	resultFor(id) {
		return this.results.has(id) ? Promise.resolve(this.results.get(id)) : new Promise(resolve => this.waiters.set(id, resolve));
	}

	reportTaskStarted(id, _lease, context) {
		this.started.set(id, context);
		this.afterStarted?.(id);
	}

	refreshServerActivity() {}
	reportReady() {
		this.ready = true;
	}

	reportSelectionProbeAck() {}
	updateContext(context) {
		this.context = context;
	}

	close() {}
}
require('../src/runtime/bridge-transport.ts').BridgeTransport = MockBridgeTransport;
const { enqueueTask, startBridgeRuntime, stopBridgeRuntime } = require('../src/runtime/bridge-runtime.ts');

async function runtimeTests() {
	const f = fixture();
	let cachedReads = 0;
	for (const [module, method] of [['dmt_Project', 'getCurrentProjectInfo'], ['dmt_Pcb', 'getCurrentPcbInfo'], ['dmt_Schematic', 'getCurrentSchematicPageInfo']]) {
		f.runtime[module][method] = async () => {
			cachedReads += 1;
			throw new Error('cached board context must not be used');
		};
	}
	try {
		startBridgeRuntime();
		const deadline = Date.now() + 3000;
		while (!activeTransport?.ready && Date.now() < deadline)
			await new Promise(resolve => setTimeout(resolve, 10));
		assert.equal(activeTransport?.ready, true, 'the footprint document must establish a Bridge connection');
		assert.equal(cachedReads, 0);
		assert.equal(activeTransport.context.libraryUuid, 'library-one');
		assert.equal(activeTransport.context.projectUuid, undefined);
		assert.equal(activeTransport.context.pageUuid, 'fp-document');
		const submit = async (id, path, payload) => {
			enqueueTask({ requestId: id, path, payload, leaseTerm: 1 }, activeTransport);
			return activeTransport.resultFor(id);
		};
		for (const path of ['/bridge/jlceda/pcb/read', '/bridge/jlceda/pcb/component-edit', '/bridge/jlceda/net/query-pcb']) {
			const value = await submit(path, path, {});
			assert.match(value.error.message, /footprint|board\/schematic/);
			assert.equal(activeTransport.started.has(path), false);
		}
		const unsupported = await submit('unsupported', '/bridge/jlceda/api/invoke', { apiFullName: 'eda.pcb_PrimitiveAttribute.create', args: [] });
		assert.equal(unsupported.error.code, 'UNSUPPORTED_FOOTPRINT_API');
		assert.equal(activeTransport.started.has('unsupported'), false);
		const read = await submit('read', '/bridge/jlceda/api/invoke', { apiFullName: 'eda.pcb_PrimitivePad.get', args: ['pad-1'] });
		assert.equal(read.error, undefined);
		assert.equal(read.result.result.primitiveId, 'pad-1');
		const write = await submit('write', '/bridge/jlceda/api/invoke', { apiFullName: 'eda.pcb_PrimitiveLine.modify', args: ['line-1', { lineWidth: 8 }] });
		assert.equal(write.error, undefined);
		assert.equal(write.result.after.lineWidth, 8);
		assert.equal(activeTransport.started.get('write').documentType, 4);
		assert.equal(activeTransport.started.get('write').libraryUuid, 'library-one');
		const originalRead = f.runtime.dmt_SelectControl.getCurrentDocumentInfo;
		let readsSinceStart = 0;
		activeTransport.afterStarted = (id) => {
			if (id === 'lease-changed')
				readsSinceStart = 1;
		};
		f.runtime.dmt_SelectControl.getCurrentDocumentInfo = async () => {
			const document = await originalRead();
			if (readsSinceStart && ++readsSinceStart === 4)
				activeTransport.callbacks.onRoleChanged({ type: 'bridge/role', clientId: activeTransport.clientId, activeClientId: 'another-client', role: 'standby', leaseTerm: 2 });
			return document;
		};
		const beforeLease = f.calls.length;
		const changedLease = await submit('lease-changed', '/bridge/jlceda/api/invoke', { apiFullName: 'eda.pcb_PrimitiveLine.create', args: [] });
		assert.match(changedLease.error.message, /role or lease changed/);
		assert.equal(f.calls.length, beforeLease);
		activeTransport.callbacks.onRoleChanged({ type: 'bridge/role', clientId: activeTransport.clientId, activeClientId: activeTransport.clientId, role: 'active', leaseTerm: 1 });
		readsSinceStart = 0;
		activeTransport.afterStarted = (id) => {
			if (id === 'modify-lease-changed')
				readsSinceStart = 1;
		};
		const doneBeforeLease = f.calls.filter(call => call[1] === 'done').length;
		const changedModifyLease = await submit('modify-lease-changed', '/bridge/jlceda/api/invoke', { apiFullName: 'eda.pcb_PrimitivePad.modify', args: ['pad-1', { x: 0 }] });
		assert.match(changedModifyLease.error.message, /role or lease changed/);
		assert.equal(f.calls.filter(call => call[1] === 'done').length, doneBeforeLease, 'the final lease guard must prevent the prepared DTO commit');
		f.runtime.dmt_SelectControl.getCurrentDocumentInfo = originalRead;
		activeTransport.callbacks.onRoleChanged({ type: 'bridge/role', clientId: activeTransport.clientId, activeClientId: activeTransport.clientId, role: 'active', leaseTerm: 1 });
		activeTransport.afterStarted = (id) => {
			if (id === 'switched')
				f.document.documentType = 3;
		};
		const before = f.calls.length;
		const switched = await submit('switched', '/bridge/jlceda/api/invoke', { apiFullName: 'eda.pcb_PrimitiveLine.create', args: [] });
		assert.match(switched.error.message, /page kind changed|not a footprint/);
		assert.equal(f.calls.length, before);
		f.document.documentType = 4;
		activeTransport.afterStarted = undefined;
		f.controls.pad = { ignoredFields: ['pad'] };
		const partial = await submit('partial-pad', '/bridge/jlceda/api/invoke', { apiFullName: 'eda.pcb_PrimitivePad.modify', args: ['pad-1', { x: 130, pad: ['ELLIPSE', 90, 60] }] });
		assert.equal(partial.error, undefined);
		assert.equal(partial.result.ok, false);
		assert.equal(partial.result.reason, 'native_footprint_modify_incomplete');
		assert.equal(partial.result.after.x, 130);
		assert.equal(partial.result.commitUnknown, undefined);
		const nextWrite = await submit('after-partial-pad', '/bridge/jlceda/api/invoke', { apiFullName: 'eda.pcb_PrimitivePad.modify', args: ['pad-1', { x: 140 }] });
		assert.equal(nextWrite.error, undefined, 'a known partial modification must not quarantine the next write');
		assert.equal(nextWrite.result.after.x, 140);
		assert.equal(nextWrite.result.fieldMismatches, undefined);
		f.controls.line = { error: new Error('ETIMEDOUT') };
		const unknownModify = await submit('unknown-modify', '/bridge/jlceda/api/invoke', { apiFullName: 'eda.pcb_PrimitiveLine.modify', args: ['line-1', { lineWidth: 9 }] });
		assert.equal(unknownModify.result.commitUnknown, true);
		assert.equal(unknownModify.result.nativeCallSettled, false);
		const doneBeforeBlocked = f.calls.filter(call => call[1] === 'done').length;
		const blocked = await submit('blocked-modify', '/bridge/jlceda/api/invoke', { apiFullName: 'eda.pcb_PrimitiveLine.modify', args: ['line-1', { lineWidth: 10 }] });
		assert.match(blocked.error.message, /unknown commit|restart|recovery/i);
		assert.equal(f.calls.filter(call => call[1] === 'done').length, doneBeforeBlocked, 'an unsettled native done must quarantine subsequent writes');
		const recoveryRead = await submit('modify-full-read', '/bridge/jlceda/footprint/read', {});
		assert.equal(recoveryRead.error, undefined);
		assert.equal(recoveryRead.result.complete, true, 'quarantine must allow controlled full readback');
		assert.equal(recoveryRead.result.lines[0].lineWidth, 9);
	}
	finally {
		stopBridgeRuntime();
	}
}

async function main() {
	await modifyCommitTests();
	await modifyMappingTests();
	await partialModificationTests();
	await missingPrimitiveTests();
	await handlerTests();
	await runtimeTests();
	console.log('Footprint context, 41 native APIs, identity isolation and transport tests passed');
}
main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
