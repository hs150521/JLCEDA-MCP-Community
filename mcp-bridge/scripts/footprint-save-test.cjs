const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');
const { handleFootprintSaveTask } = require('../src/mcp/footprint-save-handler.ts');
const { requiresHostRestartForResult } = require('../src/runtime/task-timeout.ts');

const DOCUMENT_UUID = 'current-footprint';
const SOURCE = ` \r\nDOCHEAD||{"uuid":"${DOCUMENT_UUID}","docType":"PCB"}|\r\n${Array.from({ length: 420 }, (_, index) => `PREFERENCE||{"id":"preference-${index}","text":"完整源码，保留原始空白与中文"}|`).join('\r\n')}\r\n `;

function fixture(libraryUuid = 'personal-library', staleParent = libraryUuid) {
	const document = { documentType: 4, uuid: DOCUMENT_UUID, tabId: `${DOCUMENT_UUID}@${libraryUuid}`, parentLibraryUuid: staleParent };
	const calls = { source: [], update: [], forbidden: [] };
	const state = { source: SOURCE, acknowledgement: true, onSource: undefined, onUpdate: undefined, onDocument: undefined, documentReads: 0 };
	const forbidden = name => () => {
		calls.forbidden.push(name);
		throw new Error(`footprint_save must not call ${name}`);
	};
	const runtime = {
		dmt_SelectControl: {
			async getCurrentDocumentInfo() {
				assert.equal(this, runtime.dmt_SelectControl);
				state.documentReads++;
				state.onDocument?.(state.documentReads);
				return { ...document };
			},
		},
		sys_FileManager: {
			async getDocumentSource(...args) {
				assert.equal(this, runtime.sys_FileManager, 'source read must preserve the native receiver');
				calls.source.push(args);
				await state.onSource?.();
				return state.source;
			},
		},
		lib_Footprint: {
			async updateDocumentSource(...args) {
				assert.equal(this, runtime.lib_Footprint, 'library write must preserve the native receiver');
				calls.update.push(args);
				if (state.onUpdate)
					return await state.onUpdate(...args);
				return state.acknowledgement;
			},
			openInEditor: forbidden('openInEditor'),
			copy: forbidden('copy'),
		},
		dmt_EditorControl: { closeDocument: forbidden('closeDocument'), openDocument: forbidden('openDocument') },
		pcb_PrimitivePad: { getAll: forbidden('getAll') },
	};
	globalThis.eda = runtime;
	return { document, calls, state, runtime };
}

function expectedIdentity(f) {
	return { pageKind: 'footprint', documentType: 4, documentUuid: f.document.uuid, pageUuid: f.document.uuid, libraryUuid: f.document.tabId.split('@')[1], tabId: f.document.tabId };
}

function assertNoExtraOperations(f) {
	assert.deepEqual(f.calls.forbidden, []);
}

async function checkSuccessfulLibrary(libraryUuid, staleParent) {
	const f = fixture(libraryUuid, staleParent);
	let guarded = 0;
	const result = await handleFootprintSaveTask({ expectedFootprintIdentity: expectedIdentity(f), timeoutMs: 5000 }, undefined, () => {
		guarded++;
		assert.equal(f.calls.update.length, 0, 'the final write guard must precede native execution');
	});
	assert.equal(guarded, 1);
	assert.deepEqual(f.calls.source, [[]]);
	assert.deepEqual(f.calls.update, [[DOCUMENT_UUID, libraryUuid, SOURCE]], 'the complete source must be passed once without trimming or serialization');
	assert.equal(result.ok, true);
	assert.equal(result.saved, true);
	assert.equal(result.saveAcknowledged, true);
	assert.equal(result.scope, 'library_source');
	assert.equal(result.sharedSource, true);
	assert.equal(result.sourceLength, SOURCE.length);
	assert.equal(result.nativeCallAttempted, true);
	assert.equal(result.nativeCallSettled, true);
	assert.equal(result.identityVerified, true);
	for (const [key, value] of Object.entries(expectedIdentity(f)))
		assert.equal(result[key], value);
	assert.equal(result.commitUnknown, undefined);
	assert.equal(result.durableDeletionVerified, undefined, 'a library ACK must not claim referenced PCB persistence verification');
	assertNoExtraOperations(f);
}

async function main() {
	await checkSuccessfulLibrary('personal-library', 'project-library');
	await checkSuccessfulLibrary('project-library', 'personal-library');

	const deferred = fixture();
	let resolveAck;
	let updateStarted;
	const nativeStarted = new Promise(resolve => updateStarted = resolve);
	const nativeAck = new Promise(resolve => resolveAck = resolve);
	deferred.state.onUpdate = () => {
		updateStarted();
		return nativeAck;
	};
	let returned = false;
	const saving = handleFootprintSaveTask({}).then((result) => {
		returned = true;
		return result;
	});
	await nativeStarted;
	await Promise.resolve();
	assert.equal(returned, false, 'saving must wait for the native library ACK');
	assert.equal(deferred.calls.update.length, 1);
	resolveAck(true);
	assert.equal((await saving).saved, true);
	assertNoExtraOperations(deferred);

	for (const acknowledgement of [false]) {
		const f = fixture();
		f.state.acknowledgement = acknowledgement;
		const result = await handleFootprintSaveTask({});
		assert.equal(f.calls.update.length, 1);
		assert.equal(result.ok, false);
		assert.equal(result.saved, false);
		assert.equal(result.saveAcknowledged, false);
		assert.equal(result.reason, 'native_footprint_save_not_acknowledged');
		assert.equal(requiresHostRestartForResult('/bridge/jlceda/footprint/save', {}, result), false);
		assert.equal(result.nativeCallSettled, true);
		assert.equal(result.commitUnknown, undefined);
		assert.equal(result.readbackRequired, undefined);
		assertNoExtraOperations(f);
	}

	const unacknowledged = fixture();
	let persistedSource;
	unacknowledged.state.onUpdate = (_document, _library, source) => {
		persistedSource = source;
		return undefined;
	};
	const unknownAcknowledgement = await handleFootprintSaveTask({});
	assert.equal(persistedSource, SOURCE, 'an undefined result can arrive after the library source was already written');
	assert.equal(unacknowledged.calls.update.length, 1);
	assert.equal(unknownAcknowledgement.ok, false);
	assert.equal(unknownAcknowledgement.reason, 'native_footprint_save_unknown');
	assert.equal(unknownAcknowledgement.commitUnknown, true);
	assert.equal(unknownAcknowledgement.readbackRequired, true);
	assert.equal(unknownAcknowledgement.nativeCallAttempted, true);
	assert.equal(unknownAcknowledgement.nativeCallSettled, true);
	assert.equal(unknownAcknowledgement.saved, undefined, 'a settled but unconfirmed result cannot claim the source was not saved');
	assert.equal(unknownAcknowledgement.saveAcknowledged, undefined);
	assert.equal(requiresHostRestartForResult('/bridge/jlceda/footprint/save', {}, unknownAcknowledgement), false);
	assertNoExtraOperations(unacknowledged);

	for (const error of [new Error('RPC ETIMEDOUT'), new Error('WebSocket is not open'), new Error('transport closed'), Object.assign(new Error('RPC aborted'), { code: 'ECONNABORTED' })]) {
		const f = fixture();
		f.state.onUpdate = () => {
			throw error;
		};
		const result = await handleFootprintSaveTask({});
		assert.equal(f.calls.update.length, 1, 'an unknown save must not be retried');
		assert.equal(result.ok, false);
		assert.equal(result.reason, 'native_footprint_save_unknown');
		assert.equal(result.commitUnknown, true);
		assert.equal(result.readbackRequired, true);
		assert.equal(result.nativeCallAttempted, true);
		assert.equal(result.nativeCallSettled, false);
		assert.equal(requiresHostRestartForResult('/bridge/jlceda/footprint/save', {}, result), true);
		assert.equal(result.saved, undefined, 'loss of the native result cannot prove the source was not saved');
		assert.equal(result.saveAcknowledged, undefined);
		assertNoExtraOperations(f);
	}

	const rejected = fixture();
	rejected.state.onUpdate = () => {
		throw new Error('library permission denied');
	};
	const rejectedResult = await handleFootprintSaveTask({});
	assert.equal(rejectedResult.ok, false);
	assert.equal(rejectedResult.saved, false);
	assert.equal(rejectedResult.saveAcknowledged, false);
	assert.equal(rejectedResult.reason, 'native_footprint_save_rejected');
	assert.equal(rejectedResult.nativeCallSettled, true);
	assert.equal(rejectedResult.commitUnknown, undefined);
	assert.equal(rejected.calls.update.length, 1);
	assertNoExtraOperations(rejected);

	for (const source of [undefined, '', ' \r\n\t ']) {
		const f = fixture();
		f.state.source = source;
		await assert.rejects(handleFootprintSaveTask({}), /document source is unavailable/);
		assert.equal(f.calls.update.length, 0);
		assertNoExtraOperations(f);
	}

	const wrongPage = fixture();
	wrongPage.document.documentType = 3;
	await assert.rejects(handleFootprintSaveTask({}), /not a footprint document/);
	assert.deepEqual(wrongPage.calls.source, []);
	assert.deepEqual(wrongPage.calls.update, []);
	assertNoExtraOperations(wrongPage);

	const wrongExpected = fixture('project-library', 'personal-library');
	const expected = { ...expectedIdentity(wrongExpected), libraryUuid: 'personal-library', tabId: `${DOCUMENT_UUID}@personal-library` };
	await assert.rejects(handleFootprintSaveTask({ expectedFootprintIdentity: expected }), /library, document, or tab changed/);
	assert.deepEqual(wrongExpected.calls.source, []);
	assert.deepEqual(wrongExpected.calls.update, []);
	assertNoExtraOperations(wrongExpected);

	const switchedDuringRead = fixture();
	switchedDuringRead.state.onSource = () => {
		switchedDuringRead.document.tabId = `${DOCUMENT_UUID}@project-library`;
	};
	await assert.rejects(handleFootprintSaveTask({}), /library, document, or tab changed/);
	assert.equal(switchedDuringRead.calls.source.length, 1);
	assert.equal(switchedDuringRead.calls.update.length, 0);
	assertNoExtraOperations(switchedDuringRead);

	const leaseLost = fixture();
	let guards = 0;
	leaseLost.state.onDocument = (read) => {
		if (read === 2)
			leaseLost.state.leaseLost = true;
	};
	await assert.rejects(handleFootprintSaveTask({}, undefined, () => {
		guards++;
		assert.equal(leaseLost.state.leaseLost, true, 'the guard must run after the final identity await');
		throw new Error('runtime lease changed');
	}), /runtime lease changed/);
	assert.equal(guards, 1);
	assert.equal(leaseLost.calls.update.length, 0, 'lease loss during the last identity read must prevent the library write');
	assertNoExtraOperations(leaseLost);

	for (const postSaveFailure of ['switch', 'read-error']) {
		const f = fixture();
		f.state.onUpdate = () => {
			if (postSaveFailure === 'switch') {
				f.document.tabId = `${DOCUMENT_UUID}@project-library`;
			}
			else {
				f.state.onDocument = () => {
					throw new Error('post-save document read failed');
				};
			}
			return true;
		};
		const result = await handleFootprintSaveTask({});
		assert.equal(result.ok, false);
		assert.equal(result.saved, true, 'a true ACK remains known even when the active editor changes afterward');
		assert.equal(result.saveAcknowledged, true);
		assert.equal(result.identityVerified, false);
		assert.equal(result.reason, 'footprint_changed_after_save');
		assert.equal(result.nativeCallSettled, true);
		assert.equal(result.commitUnknown, undefined);
		assert.equal(result.readbackRequired, undefined);
		assert.equal(f.calls.update.length, 1);
		assertNoExtraOperations(f);
	}

	await checkRuntimeUnknownSave();
	await checkRuntimeUnknownSave(true);
	console.log('footprint save handler/runtime: source/identity/ACK/unknown-result checks passed');
}

let activeTransport;
class MockBridgeTransport {
	constructor(_url, _socketId, clientId, _version, context, callbacks) {
		this.clientId = clientId;
		this.context = context;
		this.callbacks = callbacks;
		this.results = new Map();
		this.started = new Map();
		activeTransport = this;
	}

	async connect() {
		this.callbacks.onRoleChanged({ type: 'bridge/role', clientId: this.clientId, activeClientId: this.clientId, role: 'active', leaseTerm: 1 });
	}

	completeTask(id, _leaseTerm, result, error) {
		this.results.set(id, { result, error });
	}

	reportTaskStarted(id, _leaseTerm, context) {
		this.started.set(id, context);
	}

	reportReady() {
		this.ready = true;
	}

	refreshServerActivity() {}
	updateContext() {}
	close() {}
}

async function waitUntil(predicate) {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (predicate())
			return;
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	throw new Error('Footprint save runtime task did not complete');
}

async function checkRuntimeUnknownSave(nativeCallSettled = false) {
	// 只替换socket：实际runtime/registry/handler完成执行分类、隔离和只读回读。
	require('../src/runtime/bridge-transport.ts').BridgeTransport = MockBridgeTransport;
	// 各场景重新加载实际 runtime，旧场景 stop 后不复用其写入隔离状态。
	const runtimePath = require.resolve('../src/runtime/bridge-runtime.ts');
	delete require.cache[runtimePath];
	activeTransport = undefined;
	const { enqueueTask, startBridgeRuntime, stopBridgeRuntime } = require(runtimePath);
	const f = fixture('project-library', 'stale-personal-library');
	Object.assign(f.runtime, {
		EDMT_EditorDocumentType: { SCHEMATIC_PAGE: 1, PCB: 3, FOOTPRINT: 4 },
		sys_Environment: { getEditorCurrentVersion: () => '3.2.181' },
		sys_Storage: { getExtensionUserConfig() { return undefined; }, async setExtensionUserConfig() {} },
		sys_MessageBus: { subscribe() { return { running: () => true, cancel() {} }; }, publish() {} },
		sys_Message: { showToastMessage() {} },
	});
	globalThis.ESYS_ToastMessageType = { SUCCESS: 'success' };
	const readKinds = [];
	for (const kind of ['Pad', 'Via', 'Line', 'Arc', 'Polyline', 'String', 'Attribute']) {
		f.runtime[`pcb_Primitive${kind}`] = {
			async getAll() {
				readKinds.push(kind);
				return [];
			},
			async getAllPrimitiveId() {
				return [];
			},
		};
	}
	startBridgeRuntime();
	try {
		await waitUntil(() => activeTransport?.ready);
		const submit = async (id, path, payload) => {
			enqueueTask({ requestId: id, path, payload, leaseTerm: 1 }, activeTransport);
			await waitUntil(() => activeTransport.results.has(id));
			return activeTransport.results.get(id);
		};
		const saved = await submit('normal-save', '/bridge/jlceda/footprint/save', {});
		assert.equal(saved.error, undefined, 'the public runtime must pass only accepted internal identity fields');
		assert.equal(saved.result.saved, true);
		assert.equal(saved.result.saveAcknowledged, true);
		assert.equal(saved.result.identityVerified, true);
		assert.deepEqual(f.calls.update, [[DOCUMENT_UUID, 'project-library', SOURCE]]);
		f.state.onUpdate = (_document, _library, source) => {
			if (nativeCallSettled) {
				f.state.persistedSource = source;
				return undefined;
			}
			throw new Error('RPC ETIMEDOUT');
		};
		const first = await submit('unknown-save', '/bridge/jlceda/footprint/save', {});
		assert.equal(first.error, undefined);
		assert.equal(first.result.commitUnknown, true);
		assert.equal(first.result.nativeCallSettled, nativeCallSettled);
		assert.equal(requiresHostRestartForResult('/bridge/jlceda/footprint/save', {}, first.result), !nativeCallSettled);
		if (nativeCallSettled)
			assert.equal(f.state.persistedSource, SOURCE, 'the settled unknown save fixture applies its source before returning undefined');
		assert.equal(first.result.saveAcknowledged, undefined);
		assert.equal(first.result.saved, undefined);
		assert.equal(activeTransport.started.get('unknown-save').pageKind, 'footprint');
		assert.equal(activeTransport.started.get('unknown-save').libraryUuid, 'project-library');
		assert.deepEqual(f.calls.update, [[DOCUMENT_UUID, 'project-library', SOURCE], [DOCUMENT_UUID, 'project-library', SOURCE]]);
		assert.deepEqual(readKinds, [], 'saving must not rebuild source from primitive arrays');
		const blocked = await submit('blocked-save', '/bridge/jlceda/footprint/save', {});
		assert.match(blocked.error.message, /unknown commit|restart|recovery/i);
		assert.equal(f.calls.update.length, 2, 'unknown save must quarantine the next write');
		const readback = await submit('read-after-unknown-save', '/bridge/jlceda/footprint/read', {});
		assert.equal(readback.error, undefined);
		assert.equal(readback.result.ok, true);
		assert.equal(readback.result.complete, true);
		assert.equal(readback.result.primitiveCount, 0);
		assert.equal(readback.result.libraryUuid, 'project-library');
		assert.equal(readback.result.documentUuid, DOCUMENT_UUID);
		assert.deepEqual(readKinds, ['Pad', 'Via', 'Line', 'Arc', 'Polyline', 'String', 'Attribute']);
		const stillBlocked = await submit('still-blocked-save', '/bridge/jlceda/footprint/save', {});
		assert.match(stillBlocked.error.message, /unknown commit|restart|recovery/i);
		assert.equal(f.calls.update.length, 2, 'a read by itself must not clear the unknown native write barrier');
		assertNoExtraOperations(f);
	}
	finally {
		stopBridgeRuntime();
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
