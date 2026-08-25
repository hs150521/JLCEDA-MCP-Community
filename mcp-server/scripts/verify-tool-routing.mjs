import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readJson = (url) => JSON.parse(readFileSync(url, 'utf8'));
const definitions = readJson(new URL('../src/resources/mcp-tool-definitions.json', import.meta.url));
const contract = readJson(new URL('../../contracts/bridge-contract.json', import.meta.url));
const serverContract = readJson(new URL('../src/resources/bridge-contract.json', import.meta.url));
const bridgeContract = readJson(new URL('../../mcp-bridge/src/resources/bridge-contract.json', import.meta.url));

assert.deepEqual(serverContract, contract, 'Server contract resource differs from contracts/bridge-contract.json');
assert.deepEqual(bridgeContract, contract, 'Bridge contract resource differs from contracts/bridge-contract.json');
assert.equal(contract.contractVersion, '2.3.0', 'Contract version must match the 2.3.0 release');

const definitionNames = new Set(definitions.map(definition => definition.name));
const publicOperations = new Map(contract.operations.map(operation => [operation.toolName, operation]));
const allPaths = new Set([...contract.operations, ...contract.internalOperations].map(operation => operation.path));

assert.equal(publicOperations.size, contract.operations.length, 'Public tool names must be unique');
assert.equal(allPaths.size, contract.operations.length + contract.internalOperations.length, 'Bridge paths must be unique');
for (const definitionName of definitionNames) {
  assert.ok(publicOperations.has(definitionName), `Tool definition has no contract operation: ${definitionName}`);
}
for (const operation of contract.operations) {
  assert.ok(definitionNames.has(operation.toolName), `Contract operation has no tool definition: ${operation.toolName}`);
  assert.match(operation.path, /^\/bridge\//, `Invalid Bridge path: ${operation.path}`);
  assert.ok(['server', 'bridge'].includes(operation.owner), `Invalid operation owner: ${operation.toolName}`);
  if (operation.timeoutPolicy) {
    assert.ok(contract.timeoutPolicies[operation.timeoutPolicy], `Unknown timeout policy: ${operation.timeoutPolicy}`);
  }
}
for (const operation of contract.internalOperations) {
  assert.equal(operation.owner, 'bridge', `Internal operation must be Bridge-owned: ${operation.path}`);
  assert.ok(contract.timeoutPolicies[operation.timeoutPolicy], `Unknown internal timeout policy: ${operation.path}`);
}

process.stdout.write(`Verified ${contract.operations.length} public tools and ${contract.internalOperations.length} internal Bridge operations from one contract\n`);
