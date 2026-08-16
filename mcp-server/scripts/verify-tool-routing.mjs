import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const definitions = JSON.parse(readFileSync(new URL('../src/resources/mcp-tool-definitions.json', import.meta.url), 'utf8'));
const dispatcherSource = readFileSync(new URL('../src/mcp/tool-dispatcher.ts', import.meta.url), 'utf8');
const bridgeRuntimeSource = readFileSync(new URL('../../mcp-bridge/src/runtime/bridge-runtime.ts', import.meta.url), 'utf8');
const bridgeServerSource = readFileSync(new URL('../src/mcp/bridge-client.ts', import.meta.url), 'utf8');

const pathMapSource = dispatcherSource.match(/const pathMap:[\s\S]*?= \{([\s\S]*?)\n    \};/u)?.[1];
assert.ok(pathMapSource, 'Unable to locate dispatcher pathMap');

const routes = new Map(
  [...pathMapSource.matchAll(/'([^']+)'\s*:\s*'([^']+)'/gu)]
    .map((match) => [match[1], match[2]]),
);
const definitionNames = new Set(definitions.map((definition) => definition.name));

for (const toolName of definitionNames) {
  assert.ok(routes.has(toolName), `Tool definition has no dispatcher route: ${toolName}`);
}
for (const toolName of routes.keys()) {
  assert.ok(definitionNames.has(toolName), `Dispatcher route has no tool definition: ${toolName}`);
}
for (const [toolName, path] of routes) {
  const implementationSource = path.startsWith('/bridge/admin/') ? bridgeServerSource : bridgeRuntimeSource;
  assert.ok(
    implementationSource.includes(`'${path}'`) || implementationSource.includes(`\`${path}\``),
    `Dispatcher route has no bridge implementation: ${toolName} -> ${path}`,
  );
}

process.stdout.write(`Verified ${routes.size} synchronized MCP tool routes\n`);
