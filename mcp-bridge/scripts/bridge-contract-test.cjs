const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');

const {
	resolveContractTimeoutMs,
	validateBridgeServerMessage,
} = require('../src/bridge/bridge-contract.ts');
const contract = require('../src/resources/bridge-contract.json');
const {
	registeredBridgeTaskPaths,
} = require('../src/runtime/bridge-handler-registry.ts');

const expectedPaths = new Set([
	...contract.operations.filter(operation => operation.owner === 'bridge').map(operation => operation.path),
	...contract.internalOperations.map(operation => operation.path),
]);
assert.deepEqual(new Set(registeredBridgeTaskPaths()), expectedPaths, 'Bridge handler registry must exactly implement Bridge-owned contract paths');

assert.equal(resolveContractTimeoutMs('/bridge/jlceda/api/invoke', { timeoutMs: 42000 }), 42000);
assert.equal(resolveContractTimeoutMs('/bridge/jlceda/canvas/snapshot', {}), 30000);
assert.throws(() => resolveContractTimeoutMs('/bridge/jlceda/canvas/snapshot', { timeoutMs: 4999 }), /5000/);
assert.equal(resolveContractTimeoutMs('/bridge/jlceda/component/select', { timeoutMs: 1 }), 25000);

assert.equal(validateBridgeServerMessage({
	type: 'bridge/task',
	requestId: 'request-1',
	path: '/bridge/jlceda/context',
	payload: {},
	createdAt: Date.now(),
	leaseTerm: 1,
}), undefined);
assert.match(validateBridgeServerMessage({ type: 'bridge/task', requestId: '', path: '/bridge/jlceda/context', payload: {}, createdAt: Date.now(), leaseTerm: 1 }) ?? '', /requestId/);
assert.match(validateBridgeServerMessage({ type: 'bridge/task', requestId: 'request-1', path: '/bridge/jlceda/context', createdAt: Date.now(), leaseTerm: 1 }) ?? '', /payload/);
assert.match(validateBridgeServerMessage({ type: 'bridge/task', requestId: 'request-1', path: '/not-a-bridge-route', payload: {}, createdAt: Date.now(), leaseTerm: 1 }) ?? '', /path/);

process.stdout.write(`Bridge contract registry tests passed for ${expectedPaths.size} routes\n`);
