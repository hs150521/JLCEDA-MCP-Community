const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');

function deferred() {
	let resolve;
	const promise = new Promise((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

let activeTransport;
let nextConnectGate;
let nextReportReadyError;
const transportReady = deferred();
class MockBridgeTransport {
	constructor(_url, _socketId, clientId, _version, _context, callbacks) {
		this.clientId = clientId;
		this.callbacks = callbacks;
		this.results = new Map();
		this.resultWaiters = new Map();
		this.started = [];
		this.probeAcks = [];
		this.startedContexts = new Map();
		this.pinAdapters = new Map();
		activeTransport = this;
	}

	async connect() {
		const gate = nextConnectGate;
		nextConnectGate = undefined;
		if (gate) {
			gate.entered.resolve();
			await gate.release.promise;
		}
		this.callbacks.onRoleChanged({
			type: 'bridge/role',
			clientId: this.clientId,
			activeClientId: this.clientId,
			role: 'active',
			leaseTerm: 1,
		});
		transportReady.resolve();
	}

	completeTask(requestId, _leaseTerm, result, error) {
		this.beforeComplete?.(requestId);
		const response = { result, error };
		this.results.set(requestId, response);
		this.resultWaiters.get(requestId)?.resolve(response);
	}

	resultFor(requestId) {
		if (this.results.has(requestId))
			return Promise.resolve(this.results.get(requestId));
		const waiter = deferred();
		this.resultWaiters.set(requestId, waiter);
		return waiter.promise;
	}

	reportTaskStarted(requestId, _leaseTerm, context, adapter) {
		this.started.push(requestId);
		this.startedContexts.set(requestId, context);
		if (adapter)
			this.pinAdapters.set(requestId, adapter);
		this.afterStarted?.(requestId);
	}

	refreshServerActivity() {}
	reportReady() {
		if (nextReportReadyError) {
			this.readyError = nextReportReadyError;
			nextReportReadyError = undefined;
			throw this.readyError;
		}
		this.ready = true;
	}

	reportSelectionProbeAck(probeId) { this.probeAcks.push(probeId); }
	updateContext() {}
	close() { this.closed = true; }
}

// Keep the real runtime, route registry, and API handler; replace only the socket transport.
require('../src/runtime/bridge-transport.ts').BridgeTransport = MockBridgeTransport;
const { enqueueTask, restartBridgeServer, startBridgeRuntime, stopBridgeRuntime } = require('../src/runtime/bridge-runtime.ts');

async function waitUntil(predicate, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate())
			return;
		await new Promise(resolve => setTimeout(resolve, 20));
	}
	throw new Error('Bridge state did not become ready before the test deadline');
}

async function main() {
	const headerMenus = require('../extension.json').headerMenus;
	assert.deepEqual(headerMenus.footprint, headerMenus.pcb, 'footprint editors must expose the same MCP actions');
	const deleteEntered = deferred();
	const finishDelete = deferred();
	let idReads = 0;
	let deleteCalls = 0;
	let secondWriteCalls = 0;
	let readCalls = 0;
	let pcbWriteCalls = 0;
	let wireWriteCalls = 0;
	let currentDocumentType = 3;
	let currentSchematicPage = 'schematic-one';
	let schematicDocumentOverride;
	let gatedDocumentRead;
	let documentReadHook;
	let hangingDocumentReads = 0;
	let hangingEditablePageReads = false;
	let hungEditableGetterCalls = 0;
	globalThis.eda = {
		EDMT_EditorDocumentType: { SCHEMATIC_PAGE: 1, PCB: 3 },
		sys_Storage: { getExtensionUserConfig() { return undefined; }, async setExtensionUserConfig() {} },
		sys_MessageBus: {
			subscribe() { return { running: () => true, cancel() {} }; },
			publish() {},
		},
		sys_Message: { showToastMessage() {} },
		dmt_SelectControl: {
			async getCurrentDocumentInfo() {
				documentReadHook?.();
				if (hangingDocumentReads > 0) {
					hangingDocumentReads -= 1;
					return new Promise(() => {});
				}
				if (gatedDocumentRead) {
					const gate = gatedDocumentRead;
					gatedDocumentRead = undefined;
					gate.entered.resolve();
					await gate.release.promise;
				}
				return {
					uuid: currentDocumentType === 3 ? 'pcb-document' : schematicDocumentOverride ?? currentSchematicPage,
					documentType: currentDocumentType,
				};
			},
		},
		dmt_Project: { async getCurrentProjectInfo() { return { uuid: 'project-one' }; } },
		dmt_Schematic: {
			async getCurrentSchematicPageInfo() {
				if (hangingEditablePageReads) {
					hungEditableGetterCalls += 1;
					return new Promise(() => {});
				}
				return { uuid: currentSchematicPage };
			},
		},
		dmt_Pcb: { async getCurrentPcbInfo() { return { uuid: 'cached-pcb' }; } },
		sch_PrimitiveWire: {
			async getAll() { return []; },
			async create() {
				wireWriteCalls += 1;
				return undefined;
			},
		},
		sch_PrimitiveAttribute: { async getAll() { return []; } },
		pcb_PrimitiveComponent: {
			async create() {
				pcbWriteCalls += 1;
				return { primitiveId: 'pcb-created' };
			},
		},
		sch_PrimitiveComponent: {
			async getAllPrimitiveId() {
				idReads += 1;
				if (idReads === 1)
					return ['to-delete'];
				throw new Error('post-delete readback failed');
			},
			async delete() {
				deleteCalls += 1;
				deleteEntered.resolve();
				await finishDelete.promise;
				return true;
			},
			async create() {
				secondWriteCalls += 1;
				return { primitiveId: 'unexpected-write' };
			},
			async getAll() {
				readCalls += 1;
				return [];
			},
		},
	};
	globalThis.ESYS_ToastMessageType = { SUCCESS: 'success' };

	startBridgeRuntime();
	await transportReady.promise;
	const transport = activeTransport;
	const path = '/bridge/jlceda/api/invoke';
	let submittedLease = 1;
	const submit = (requestId, payload) => enqueueTask({ requestId, path, payload, leaseTerm: submittedLease }, transport);
	const holdNextDocumentRead = () => {
		gatedDocumentRead = { entered: deferred(), release: deferred() };
		return gatedDocumentRead;
	};
	let writeAtCompletionRejected = false;
	transport.beforeComplete = (requestId) => {
		if (requestId !== 'uncertain-delete')
			return;
		// This runs before the first result is sent to the Server.
		submit('write-at-result', { apiFullName: 'eda.sch_PrimitiveComponent.create', args: [] });
		writeAtCompletionRejected = transport.results.has('write-at-result');
	};
	try {
		submit('pcb-write', { apiFullName: 'eda.pcb_PrimitiveComponent.create', args: [] });
		const pcbWrite = await transport.resultFor('pcb-write');
		assert.equal(pcbWrite.error, undefined);
		assert.equal(pcbWriteCalls, 1);
		assert.equal(transport.startedContexts.get('pcb-write').pageKind, 'pcb');
		assert.equal(transport.startedContexts.get('pcb-write').pageUuid, 'cached-pcb');
		currentDocumentType = 1;
		globalThis.eda.sch_PrimitivePin = { async modify(id, patch) {
			assert.equal(transport.pinAdapters.get('ordinary-pin-write'), 'native_pin');
			return { primitiveId: id, ...patch };
		} };
		submit('ordinary-pin-write', { apiFullName: 'eda.sch_PrimitivePin.modify', args: ['ordinary-pin', { noConnected: false }] });
		assert.equal((await transport.resultFor('ordinary-pin-write')).error, undefined);
		assert.equal(transport.startedContexts.get('ordinary-pin-write').pageUuid, 'schematic-one');
		readCalls = 0;
		submit('wrong-page-write', { apiFullName: 'eda.pcb_PrimitiveComponent.create', args: [] });
		const wrongPage = await transport.resultFor('wrong-page-write');
		assert.match(wrongPage.error.message, /Current editor is schematic/);
		assert.equal(transport.started.includes('wrong-page-write'), false);
		const roleGate = holdNextDocumentRead();
		submit('role-changed-during-context', { apiFullName: 'eda.sch_PrimitiveComponent.create', args: [] });
		await roleGate.entered.promise;
		transport.callbacks.onRoleChanged({
			type: 'bridge/role',
			clientId: transport.clientId,
			activeClientId: 'other-client',
			role: 'standby',
			leaseTerm: 2,
		});
		roleGate.release.resolve();
		const staleRole = await transport.resultFor('role-changed-during-context');
		assert.match(staleRole.error.message, /standby|待命/i);
		assert.equal(transport.started.includes('role-changed-during-context'), false);
		assert.equal(secondWriteCalls, 0);
		transport.callbacks.onRoleChanged({
			type: 'bridge/role',
			clientId: transport.clientId,
			activeClientId: transport.clientId,
			role: 'active',
			leaseTerm: 3,
		});
		submittedLease = 3;
		const leaseGate = holdNextDocumentRead();
		submit('lease-changed-during-context', { apiFullName: 'eda.sch_PrimitiveComponent.create', args: [] });
		await leaseGate.entered.promise;
		transport.callbacks.onRoleChanged({
			type: 'bridge/role',
			clientId: transport.clientId,
			activeClientId: transport.clientId,
			role: 'active',
			leaseTerm: 4,
		});
		leaseGate.release.resolve();
		const staleLease = await transport.resultFor('lease-changed-during-context');
		assert.match(staleLease.error.message, /lease|租约/i);
		assert.equal(transport.started.includes('lease-changed-during-context'), false);
		assert.equal(secondWriteCalls, 0);
		submittedLease = 4;
		const hungContextGate = holdNextDocumentRead();
		submit('hung-context-write', { apiFullName: 'eda.sch_PrimitiveComponent.create', args: [] });
		await hungContextGate.entered.promise;
		submit('read-after-hung-context', { apiFullName: 'eda.sch_PrimitiveComponent.getAll', args: [] });
		const hungWrite = await transport.resultFor('hung-context-write');
		const readAfterHungContext = await transport.resultFor('read-after-hung-context');
		assert.match(hungWrite.error.message, /page context read timed out/);
		assert.equal(transport.started.includes('hung-context-write'), false, 'a timed-out identity read must not start the write handler');
		assert.equal(secondWriteCalls, 0);
		assert.equal(readAfterHungContext.error, undefined, 'later read-only work must not remain stuck behind the failed preflight');
		hungContextGate.release.resolve();
		readCalls = 0;
		schematicDocumentOverride = 'schematic-two';
		submit('unsynced-delete', { apiFullName: 'eda.sch_PrimitiveComponent.delete', args: ['to-delete'] });
		const unsyncedDelete = await transport.resultFor('unsynced-delete');
		assert.match(unsyncedDelete.error.message, /not synchronized/);
		assert.equal(transport.started.includes('unsynced-delete'), false);
		assert.equal(deleteCalls, 0);
		schematicDocumentOverride = undefined;
		transport.afterStarted = (requestId) => {
			if (requestId === 'page-switch-before-delete')
				currentSchematicPage = 'schematic-two';
		};
		submit('page-switch-before-delete', {
			apiFullName: 'eda.sch_PrimitiveComponent.delete',
			args: ['to-delete'],
			expectedSchematicDeletePageUuid: 'schematic-two',
		});
		const switchedBeforeDelete = await transport.resultFor('page-switch-before-delete');
		assert.match(switchedBeforeDelete.error.message, /删除前原理图图页已切换/);
		assert.equal(transport.startedContexts.get('page-switch-before-delete').pageUuid, 'schematic-one');
		assert.equal(deleteCalls, 0, 'the new page must not receive the old page deletion');
		assert.equal(idReads, 0);
		currentSchematicPage = 'schematic-one';
		const rawCreate = { apiFullName: 'eda.sch_PrimitiveComponent.create', args: [{ libraryType: '2', uuid: 'symbol', libraryUuid: 'system' }, 100, 200] };
		transport.afterStarted = (requestId) => {
			if (requestId === 'page-switch-before-create')
				currentSchematicPage = 'schematic-two';
		};
		submit('page-switch-before-create', { ...rawCreate, expectedSchematicCreatePageUuid: 'schematic-two' });
		const switchedBeforeCreate = await transport.resultFor('page-switch-before-create');
		assert.match(switchedBeforeCreate.error.message, /创建前原理图图页已切换/);
		assert.equal(transport.startedContexts.get('page-switch-before-create').pageUuid, 'schematic-one');
		assert.equal(secondWriteCalls, 0, 'runtime must bind raw creation to its execution page');
		currentSchematicPage = 'schematic-one';
		let createDocumentReads = 0;
		transport.afterStarted = (requestId) => {
			if (requestId !== 'lease-change-before-create')
				return;
			documentReadHook = () => {
				if (++createDocumentReads === 3) {
					transport.callbacks.onRoleChanged({
						type: 'bridge/role',
						clientId: transport.clientId,
						activeClientId: transport.clientId,
						role: 'active',
						leaseTerm: 5,
					});
				}
			};
		};
		submit('lease-change-before-create', rawCreate);
		const leaseChangedBeforeCreate = await transport.resultFor('lease-change-before-create');
		assert.match(leaseChangedBeforeCreate.error.message, /lease changed before the native mutation/);
		assert.equal(createDocumentReads, 3, 'lease changes during the final identity read after the baseline');
		assert.equal(secondWriteCalls, 0, 'the final native guard must prevent the raw create');
		documentReadHook = undefined;
		submittedLease = 5;
		for (const raw of [true, false]) {
			const wirePath = raw ? path : '/bridge/jlceda/schematic/connectivity';
			const wirePayload = raw ? { apiFullName: 'eda.sch_PrimitiveWire.create', args: [[0, 0, 10, 0]] } : { action: 'wire_create', line: [0, 0, 10, 0] };
			const switchId = `page-switch-before-${raw ? 'raw' : 'controlled'}-wire`;
			transport.afterStarted = (requestId) => {
				if (requestId === switchId)
					currentSchematicPage = 'schematic-two';
			};
			enqueueTask({ requestId: switchId, path: wirePath, payload: { ...wirePayload, expectedSchematicWirePageUuid: 'schematic-two' }, leaseTerm: submittedLease }, transport);
			const switchedWire = await transport.resultFor(switchId);
			assert.match(switchedWire.error.message, /page changed before wire creation/);
			assert.equal(transport.startedContexts.get(switchId).pageUuid, 'schematic-one');
			assert.equal(wireWriteCalls, 0, 'both routes bind wire creation to the runtime execution page');
			currentSchematicPage = 'schematic-one';
			const leaseId = `lease-change-before-${raw ? 'raw' : 'controlled'}-wire`;
			let wireDocumentReads = 0;
			const finalRead = raw ? 3 : 2;
			transport.afterStarted = (requestId) => {
				if (requestId !== leaseId)
					return;
				documentReadHook = () => {
					if (++wireDocumentReads === finalRead) {
						transport.callbacks.onRoleChanged({ type: 'bridge/role', clientId: transport.clientId, activeClientId: transport.clientId, role: 'active', leaseTerm: submittedLease + 1 });
					}
				};
			};
			enqueueTask({ requestId: leaseId, path: wirePath, payload: wirePayload, leaseTerm: submittedLease }, transport);
			const changedWireLease = await transport.resultFor(leaseId);
			assert.match(changedWireLease.error.message, /lease changed before the native mutation/);
			assert.equal(wireDocumentReads, finalRead, 'lease changed during the final page read immediately before native create');
			assert.equal(wireWriteCalls, 0);
			documentReadHook = undefined;
			submittedLease++;
		}
		transport.afterStarted = undefined;
		const originalWireApi = globalThis.eda.sch_PrimitiveWire;
		const shortTimeoutWires = [];
		const shortTimeoutNativeArgs = [];
		globalThis.eda.sch_PrimitiveWire = {
			async getAll() { return shortTimeoutWires; },
			async create(...args) {
				assert.equal(this, globalThis.eda.sch_PrimitiveWire);
				shortTimeoutNativeArgs.push(args);
				const id = `short-timeout-wire-${shortTimeoutNativeArgs.length}`;
				const created = {
					getState_PrimitiveId: () => id,
					getState_Net: () => args[1],
					getState_Line: () => args[0],
				};
				shortTimeoutWires.push(created);
				return created;
			},
		};
		const shortTimeoutArgs = [[0, 0, 100, 0], 'NET_A', '#FF0000', 6, 1];
		submit('raw-wire-one-second', { apiFullName: 'eda.sch_PrimitiveWire.create', args: shortTimeoutArgs, timeoutMs: 1000 });
		const shortRawWire = await transport.resultFor('raw-wire-one-second');
		assert.equal(shortRawWire.error, undefined);
		assert.equal(shortRawWire.result.ok, true, 'raw 1s budget must leave time for complete wire readback');
		assert.equal(shortRawWire.result.committed, true);
		assert.equal(shortRawWire.result.commitUnknown, false);
		assert.equal(shortRawWire.result.nativeCallSettled, true);
		assert.deepEqual(shortRawWire.result.confirmedPrimitiveIds, ['short-timeout-wire-1']);
		assert.deepEqual(shortTimeoutNativeArgs, [shortTimeoutArgs], 'the real runtime preserves all five raw arguments');
		enqueueTask({ requestId: 'controlled-wire-one-second', path: '/bridge/jlceda/schematic/connectivity', payload: { action: 'wire_create', line: [0, 100, 100, 100], net: 'NET_B', timeoutMs: 1000 }, leaseTerm: submittedLease }, transport);
		const shortControlledWire = await transport.resultFor('controlled-wire-one-second');
		assert.match(shortControlledWire.error.message, /timeoutMs must be an integer between 5000 and 120000/);
		assert.equal(shortTimeoutNativeArgs.length, 1, 'controlled 1s budget is rejected before any native write');
		enqueueTask({ requestId: 'controlled-wire-after-short-budget', path: '/bridge/jlceda/schematic/connectivity', payload: { action: 'wire_create', line: [0, 100, 100, 100], net: 'NET_B', timeoutMs: 5000 }, leaseTerm: submittedLease }, transport);
		const nextControlledWire = await transport.resultFor('controlled-wire-after-short-budget');
		assert.equal(nextControlledWire.error, undefined);
		assert.equal(nextControlledWire.result.ok, true, 'neither the raw write nor the rejected budget may quarantine later normal work');
		assert.equal(nextControlledWire.result.committed, true);
		assert.equal(nextControlledWire.result.commitUnknown, false);
		assert.equal(shortTimeoutNativeArgs.length, 2);
		globalThis.eda.sch_PrimitiveWire = originalWireApi;
		const originalRoutingDocumentApi = globalThis.eda.dmt_SelectControl;
		const originalRoutingPcbApi = globalThis.eda.dmt_Pcb;
		const originalRoutingNetApi = globalThis.eda.pcb_Net;
		const originalRoutingApi = globalThis.eda.pcb_Document;
		let routingPageUuid = 'routing-pcb-one';
		const routingNativeArgs = [];
		currentDocumentType = 3;
		globalThis.eda.dmt_SelectControl = {
			...originalRoutingDocumentApi,
			async getCurrentDocumentInfo() {
				const document = await originalRoutingDocumentApi.getCurrentDocumentInfo();
				return document.documentType === 3 ? { ...document, uuid: routingPageUuid } : document;
			},
		};
		globalThis.eda.dmt_Pcb = {
			async getCurrentPcbInfo() { return { uuid: routingPageUuid }; },
		};
		globalThis.eda.pcb_Net = {
			async getAllPrimitivesByNet() { return []; },
			async getNetLength() { return 0; },
		};
		globalThis.eda.pcb_Document = {
			async autoRouting(...args) {
				assert.equal(this, globalThis.eda.pcb_Document);
				routingNativeArgs.push(args);
				return { success: true, totalNetsCount: 1, successNetsCount: 1, failedNets: [], duration: 1 };
			},
		};
		const selectedRoutingArgs = [{ RoutingNets: ['NET_A'], layers: [1], existingPrimitiveMode: 'keep' }];
		for (const [mode, args] of [['all', []], ['selected', selectedRoutingArgs]]) {
			const requestId = `page-switch-before-${mode}-routing`;
			transport.afterStarted = (id) => {
				if (id === requestId)
					routingPageUuid = 'routing-pcb-two';
			};
			submit(requestId, { apiFullName: 'eda.pcb_Document.autoRouting', args, expectedPcbUuid: 'routing-pcb-two' });
			const switchedRouting = await transport.resultFor(requestId);
			assert.match(switchedRouting.error.message, /PCB.*changed|changed.*PCB/i);
			assert.equal(transport.startedContexts.get(requestId).pageUuid, 'routing-pcb-one');
			assert.equal(routingNativeArgs.length, 0, 'all and selected routing must bind to the execution PCB, overriding a caller target');
			routingPageUuid = 'routing-pcb-one';
		}
		let routingDocumentReads = 0;
		transport.afterStarted = (requestId) => {
			if (requestId !== 'lease-change-before-routing')
				return;
			documentReadHook = () => {
				if (++routingDocumentReads === 2)
					transport.callbacks.onRoleChanged({ type: 'bridge/role', clientId: transport.clientId, activeClientId: transport.clientId, role: 'active', leaseTerm: submittedLease + 1 });
			};
		};
		submit('lease-change-before-routing', { apiFullName: 'eda.pcb_Document.autoRouting', args: selectedRoutingArgs });
		const changedRoutingLease = await transport.resultFor('lease-change-before-routing');
		assert.match(changedRoutingLease.error.message, /lease changed before the native mutation/);
		assert.equal(routingDocumentReads, 2, 'lease changes during the final fresh editor identity read after the selected-net observation');
		assert.equal(routingNativeArgs.length, 0);
		documentReadHook = undefined;
		submittedLease++;
		transport.afterStarted = (requestId) => {
			if (requestId === 'schematic-switch-before-routing')
				currentDocumentType = 1;
		};
		submit('schematic-switch-before-routing', { apiFullName: 'eda.pcb_Document.autoRouting', args: [] });
		const switchedEditorRouting = await transport.resultFor('schematic-switch-before-routing');
		assert.match(switchedEditorRouting.error.message, /page kind changed|Current editor is schematic/i);
		assert.equal((await globalThis.eda.dmt_Pcb.getCurrentPcbInfo()).uuid, 'routing-pcb-one', 'the PCB getter deliberately retains its cached page after switching to SCH');
		assert.equal(routingNativeArgs.length, 0);
		currentDocumentType = 3;
		transport.afterStarted = undefined;
		submit('normal-routing-after-rejected-tasks', { apiFullName: 'eda.pcb_Document.autoRouting', args: selectedRoutingArgs, expectedPcbUuid: 'routing-pcb-two' });
		const normalRouting = await transport.resultFor('normal-routing-after-rejected-tasks');
		assert.equal(normalRouting.error, undefined);
		assert.equal(normalRouting.result.result.success, true);
		assert.equal(normalRouting.result.commitUnknown, undefined);
		assert.deepEqual(routingNativeArgs, [selectedRoutingArgs], 'identity and lease rejections must leave the next normal call available with original native arguments');
		globalThis.eda.dmt_SelectControl = originalRoutingDocumentApi;
		globalThis.eda.dmt_Pcb = originalRoutingPcbApi;
		globalThis.eda.pcb_Net = originalRoutingNetApi;
		globalThis.eda.pcb_Document = originalRoutingApi;
		currentDocumentType = 1;
		readCalls = 0;
		transport.afterStarted = undefined;
		submit('uncertain-delete', { apiFullName: 'eda.sch_PrimitiveComponent.delete', args: ['to-delete'] });
		await deleteEntered.promise;
		transport.callbacks.onProbeRequested('queued-probe');
		await new Promise(resolve => setTimeout(resolve, 20));
		assert.deepEqual(transport.probeAcks, [], 'selection probe must wait for the running EDA task');
		// Both following tasks enter taskChain before the first handler returns.
		submit('queued-write', { apiFullName: 'eda.sch_PrimitiveComponent.create', args: [] });
		submit('queued-read', { apiFullName: 'eda.sch_PrimitiveComponent.getAll', args: [] });
		finishDelete.resolve();
		await waitUntil(() => transport.probeAcks.includes('queued-probe'));
		let timeoutId;
		const responses = await Promise.race([
			Promise.all([
				transport.resultFor('uncertain-delete'),
				transport.resultFor('queued-write'),
				transport.resultFor('queued-read'),
				transport.resultFor('write-at-result'),
			]),
			new Promise((_resolve, reject) => {
				timeoutId = setTimeout(() => reject(new Error('Queued task result timed out')), 3000);
			}),
		]).finally(() => clearTimeout(timeoutId));
		const [first, second, read, atCompletion] = responses;
		assert.equal(first.error, undefined);
		assert.equal(first.result.commitUnknown, true);
		assert.equal(transport.startedContexts.get('uncertain-delete').pageKind, 'schematic');
		assert.equal(transport.startedContexts.get('uncertain-delete').pageUuid, 'schematic-one');
		assert.equal(deleteCalls, 1);
		assert.equal(idReads, 2);
		assert.equal(writeAtCompletionRejected, true, 'the barrier must exist before the first result is sent');
		assert.ok(atCompletion.error);
		assert.equal(secondWriteCalls, 0, 'the queued write handler must never run after an unknown commit');
		assert.ok(second.error, 'the queued write must be rejected');
		assert.equal(transport.started.includes('queued-write'), false);
		assert.equal(read.error, undefined, 'a read-only task must remain available');
		assert.equal(readCalls, 1);
		assert.equal(transport.started.includes('queued-read'), true);
	}
	finally {
		finishDelete.resolve();
		stopBridgeRuntime();
	}
	const previousTransport = activeTransport;
	hangingEditablePageReads = true;
	startBridgeRuntime();
	let oldConnectGate;
	let newContextGate;
	let oldContextGate;
	let newConnectGate;
	try {
		await new Promise(resolve => setTimeout(resolve, 5400));
		assert.equal(activeTransport, previousTransport, 'a hung editable-page getter must prevent a premature connection');
		assert.ok(hungEditableGetterCalls <= 2, 'periodic context checks must not accumulate during a hung native getter');
		hangingEditablePageReads = false;
		await waitUntil(() => activeTransport !== previousTransport, 5000);
		const reconnectedTransport = activeTransport;
		hangingDocumentReads = 1;
		restartBridgeServer();
		await waitUntil(() => activeTransport !== reconnectedTransport, 10_000);
		assert.equal(hangingDocumentReads, 0, 'the first connection context read must have reached the hung getter');
		assert.equal(activeTransport.started.length, 0);
		oldConnectGate = { entered: deferred(), release: deferred() };
		nextConnectGate = oldConnectGate;
		restartBridgeServer();
		await oldConnectGate.entered.promise;
		const staleConnectingTransport = activeTransport;
		newContextGate = holdNextDocumentRead();
		restartBridgeServer();
		await newContextGate.entered.promise;
		oldConnectGate.release.resolve();
		await new Promise(resolve => setTimeout(resolve, 1600));
		assert.equal(activeTransport, staleConnectingTransport, 'an old connect completion must not clear the newer attempt or start a third connection');
		newContextGate.release.resolve();
		await waitUntil(() => activeTransport !== staleConnectingTransport && activeTransport.ready, 5000);
		oldContextGate = holdNextDocumentRead();
		restartBridgeServer();
		await oldContextGate.entered.promise;
		newConnectGate = { entered: deferred(), release: deferred() };
		nextConnectGate = newConnectGate;
		restartBridgeServer();
		await newConnectGate.entered.promise;
		const newerConnectingTransport = activeTransport;
		await new Promise(resolve => setTimeout(resolve, 6600));
		assert.equal(activeTransport, newerConnectingTransport, 'an old context timeout must not clear the newer attempt or start a third connection');
		newConnectGate.release.resolve();
		await waitUntil(() => newerConnectingTransport.ready, 2000);
		nextReportReadyError = new Error('WebSocket is not open');
		newerConnectingTransport.callbacks.onLost('Server restarted');
		await waitUntil(() => activeTransport !== newerConnectingTransport && activeTransport.readyError, 5000);
		const failedReadyTransport = activeTransport;
		assert.equal(failedReadyTransport.closed, true, 'a failed ready send must close the adopted transport');
		assert.equal(failedReadyTransport.ready, undefined);
		await waitUntil(() => activeTransport !== failedReadyTransport && activeTransport.ready, 5000);
		const recoveredTransport = activeTransport;
		assert.equal(recoveredTransport.closed, undefined, 'automatic reconnect must produce a live transport');
		failedReadyTransport.callbacks.onLost('late failure from the previous connection');
		await new Promise(resolve => setTimeout(resolve, 100));
		assert.equal(activeTransport, recoveredTransport, 'a stale loss callback must preserve the new connection');
		assert.equal(recoveredTransport.closed, undefined);
		process.stdout.write('Bridge context timeout, queue barrier, and ready-send reconnect tests passed\n');
	}
	finally {
		oldConnectGate?.release.resolve();
		newContextGate?.release.resolve();
		oldContextGate?.release.resolve();
		newConnectGate?.release.resolve();
		hangingEditablePageReads = false;
		stopBridgeRuntime();
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
