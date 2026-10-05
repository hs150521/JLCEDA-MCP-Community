const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');

let activeTransport;
class MockBridgeTransport {
	constructor(_url, _socketId, clientId, _version, _context, callbacks) {
		this.clientId = clientId;
		this.callbacks = callbacks;
		this.results = new Map();
		activeTransport = this;
	}

	async connect() {
		this.callbacks.onRoleChanged({
			type: 'bridge/role',
			clientId: this.clientId,
			activeClientId: this.clientId,
			role: 'active',
			leaseTerm: 1,
		});
	}

	completeTask(requestId, _leaseTerm, result, error) {
		this.results.set(requestId, { result, error });
	}

	reportReady() { this.ready = true; }
	reportTaskStarted() {}
	refreshServerActivity() {}
	updateContext() {}
	close() { this.closed = true; }
}

// Only the socket is replaced: tasks use the production runtime, registry, and handlers.
require('../src/runtime/bridge-transport.ts').BridgeTransport = MockBridgeTransport;
const { getEditorVersionBeforeNetLabelSupport } = require('../src/mcp/netlabel-place-handler.ts');
const { enqueueTask, startBridgeRuntime, stopBridgeRuntime } = require('../src/runtime/bridge-runtime.ts');

async function waitUntil(predicate) {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (predicate())
			return;
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	throw new Error('Net label task did not complete before the test deadline');
}

async function main() {
	let editorVersion = '3.2.181';
	const labelCalls = [];
	const flagCalls = [];
	let readCalls = 0;
	globalThis.eda = {
		EDMT_EditorDocumentType: { SCHEMATIC_PAGE: 1, PCB: 3 },
		sys_Environment: { getEditorCurrentVersion: () => editorVersion },
		sys_Storage: { getExtensionUserConfig() { return undefined; }, async setExtensionUserConfig() {} },
		sys_MessageBus: { subscribe() { return { running: () => true, cancel() {} }; }, publish() {} },
		sys_Message: { showToastMessage() {} },
		dmt_SelectControl: { async getCurrentDocumentInfo() { return { documentType: 1, uuid: 'label-page' }; } },
		dmt_Project: { async getCurrentProjectInfo() { return { uuid: 'label-project' }; } },
		dmt_Schematic: { async getCurrentSchematicPageInfo() { return { uuid: 'label-page' }; } },
		dmt_Pcb: { async getCurrentPcbInfo() { return undefined; } },
		sch_PrimitiveAttribute: {
			async createNetLabel(...args) {
				assert.equal(this, globalThis.eda.sch_PrimitiveAttribute);
				labelCalls.push(args);
				return { primitiveId: 'native-label' };
			},
		},
		sch_PrimitiveComponent: {
			async getAll() {
				readCalls += 1;
				return [];
			},
			async getAllPinsByPrimitiveId() {
				return [{
					getState_PinNumber: () => '1',
					getState_PinName: () => 'OUT',
					getState_X: () => 10,
					getState_Y: () => 20,
					getState_Rotation: () => 0,
					getState_PinLength: () => 10,
				}];
			},
			async createNetFlag(...args) {
				flagCalls.push(args);
				return { primitiveId: 'native-ground' };
			},
		},
	};
	globalThis.ESYS_ToastMessageType = { SUCCESS: 'success' };
	assert.equal(getEditorVersionBeforeNetLabelSupport(), '3.2.181');

	startBridgeRuntime();
	try {
		await waitUntil(() => activeTransport?.ready);
		const transport = activeTransport;
		const submit = async (requestId, path, payload) => {
			enqueueTask({ requestId, path, payload, leaseTerm: 1 }, transport);
			await waitUntil(() => transport.results.has(requestId));
			const response = transport.results.get(requestId);
			assert.equal(response.error, undefined);
			return response.result;
		};
		const invoke = (id, payload) => submit(id, '/bridge/jlceda/api/invoke', payload);
		const rejected = await invoke('v3-raw-label', {
			apiFullName: 'eda.sch_PrimitiveAttribute.createNetLabel',
			args: [10, 20, 'FSW_SET'],
		});
		assert.equal(labelCalls.length, 0, 'EDA 3.x must reject the raw API before any native call');
		assert.equal(rejected.ok, false);
		assert.equal(rejected.errorCode, 'EDA_VERSION_UNSUPPORTED');
		assert.equal(rejected.commitStatus, 'not_started');
		assert.equal(rejected.nativeCallAttempted, false);
		assert.equal(rejected.commitUnknown, undefined);
		assert.equal(rejected.readbackRequired, undefined);
		assert.match(rejected.error, /3\.2\.181.*v4/);

		const read = await invoke('read-after-precheck', { apiFullName: 'eda.sch_PrimitiveComponent.getAll', args: [] });
		assert.deepEqual(read.result, []);
		assert.equal(readCalls, 1, 'a rejected unsupported API must leave the runtime available for the next read');
		const semantic = await submit('v3-ground-after-precheck', '/bridge/jlceda/netlabel/place', {
			placements: [
				{ componentId: 'component-one', pinIdentifier: '1', netName: 'FSW_SET' },
				{ componentId: 'component-one', pinIdentifier: '1', netName: 'GND' },
			],
		});
		assert.equal(semantic.partial, true);
		assert.equal(semantic.results[0].errorCode, 'EDA_VERSION_UNSUPPORTED');
		assert.equal(semantic.results[0].commitStatus, 'not_started');
		assert.equal(semantic.results[1].success, true);
		assert.deepEqual(flagCalls, [['Ground', 'GND', 10, 20, 0, false]]);
		assert.equal(labelCalls.length, 0, 'semantic ordinary labels must use the same version precheck');

		editorVersion = '4.0.0';
		assert.equal(getEditorVersionBeforeNetLabelSupport(), undefined);
		const supportedArgs = [0, 20, 'FSW_SET'];
		const supported = await invoke('v4-raw-label', {
			apiFullName: 'eda.sch_PrimitiveAttribute.createNetLabel',
			args: supportedArgs,
		});
		assert.deepEqual(labelCalls, [supportedArgs], 'the supported version must pass native arguments through exactly once');
		assert.deepEqual(supported.result, { primitiveId: 'native-label' });
		assert.equal(supported.errorCode, undefined);

		const index = await submit('label-api-index', '/bridge/jlceda/api/index', { owner: 'sch_PrimitiveAttribute.createNetLabel' });
		assert.equal(index.total, 1);
		assert.match(index.index[0].summary, /v4.*3\.x/);
		assert.equal(transport.closed, undefined);
	}
	finally {
		stopBridgeRuntime();
	}
	console.log('netlabel-version-precheck-test passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
