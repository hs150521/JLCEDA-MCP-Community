import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const definitions = JSON.parse(readFileSync(new URL('../src/resources/mcp-tool-definitions.json', import.meta.url), 'utf8'));
const routes = JSON.parse(readFileSync(new URL('../src/resources/bridge-tool-routes.json', import.meta.url), 'utf8'));
const canonicalRoutes = JSON.parse(readFileSync(new URL('../../contracts/bridge-tool-routes.json', import.meta.url), 'utf8'));
const bridgeRuntimeSource = readFileSync(new URL('../../mcp-bridge/src/runtime/bridge-runtime.ts', import.meta.url), 'utf8');
const bridgeServerSource = readFileSync(new URL('../src/mcp/bridge-client.ts', import.meta.url), 'utf8');
const definitionNames = new Set(definitions.map((definition) => definition.name));
assert.deepEqual(routes, canonicalRoutes, 'Server route resource differs from canonical contracts manifest');
const bridgeRoutes = JSON.parse(readFileSync(new URL('../../mcp-bridge/src/resources/bridge-tool-routes.json', import.meta.url), 'utf8'));
assert.deepEqual(bridgeRoutes, canonicalRoutes, 'Bridge route resource differs from canonical contracts manifest');

for (const toolName of definitionNames) {
  assert.ok(routes[toolName], `Tool definition has no canonical route: ${toolName}`);
}
for (const toolName of Object.keys(routes)) {
  assert.ok(definitionNames.has(toolName), `Dispatcher route has no tool definition: ${toolName}`);
}
for (const [toolName, path] of Object.entries(routes)) {
  const implementationSource = path.startsWith('/bridge/admin/') ? bridgeServerSource : bridgeRuntimeSource;
  assert.ok(
    implementationSource.includes(`'${path}'`) || implementationSource.includes(`\`${path}\``),
    `Dispatcher route has no bridge implementation: ${toolName} -> ${path}`,
  );
}

process.stdout.write(`Verified ${Object.keys(routes).length} synchronized MCP tool routes\n`);
