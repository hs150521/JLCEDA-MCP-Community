import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const definitions = JSON.parse(readFileSync(new URL('../src/resources/mcp-tool-definitions.json', import.meta.url), 'utf8'));
const routes = JSON.parse(readFileSync(new URL('../src/resources/bridge-tool-routes.json', import.meta.url), 'utf8'));
const canonicalRoutes = JSON.parse(readFileSync(new URL('../../contracts/bridge-tool-routes.json', import.meta.url), 'utf8'));
const bridgeRuntimeSource = readFileSync(new URL('../../mcp-bridge/src/runtime/bridge-runtime.ts', import.meta.url), 'utf8');
const bridgeServerSource = readFileSync(new URL('../src/mcp/bridge-client.ts', import.meta.url), 'utf8');
const definitionNames = new Set(definitions.map((definition) => definition.name));

function findVariableInitializer(sourceFile, variableName) {
  let initializer;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === variableName) {
      initializer = node.initializer;
      return;
    }
    if (!initializer) {
      ts.forEachChild(node, visit);
    }
  };
  visit(sourceFile);
  assert.ok(initializer, `Bridge runtime is missing ${variableName}`);
  return initializer;
}

function readStringLiteral(node, label) {
  assert.ok(ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node), `${label} must be a string literal`);
  return node.text;
}

function readHandlerRoutes(runtimeSource) {
  const sourceFile = ts.createSourceFile('bridge-runtime.ts', runtimeSource, ts.ScriptTarget.Latest, true);
  const handlers = findVariableInitializer(sourceFile, 'BRIDGE_TASK_HANDLERS');
  assert.ok(ts.isObjectLiteralExpression(handlers), 'BRIDGE_TASK_HANDLERS must be an object literal');
  return new Set(handlers.properties.map((property) => {
    assert.ok(ts.isPropertyAssignment(property), 'BRIDGE_TASK_HANDLERS may only contain property assignments');
    return readStringLiteral(property.name, 'BRIDGE_TASK_HANDLERS property name');
  }));
}

function readInternalRoutes(runtimeSource) {
  const sourceFile = ts.createSourceFile('bridge-runtime.ts', runtimeSource, ts.ScriptTarget.Latest, true);
  const internalRoutes = findVariableInitializer(sourceFile, 'BRIDGE_INTERNAL_ROUTES');
  assert.ok(ts.isNewExpression(internalRoutes) && ts.isIdentifier(internalRoutes.expression) && internalRoutes.expression.text === 'Set', 'BRIDGE_INTERNAL_ROUTES must be a Set');
  const values = internalRoutes.arguments?.[0];
  assert.ok(values && ts.isArrayLiteralExpression(values), 'BRIDGE_INTERNAL_ROUTES must initialize Set with an array literal');
  return new Set(values.elements.map((element) => readStringLiteral(element, 'BRIDGE_INTERNAL_ROUTES entry')));
}

const handlerRoutes = readHandlerRoutes(bridgeRuntimeSource);
const declaredInternalRoutes = readInternalRoutes(bridgeRuntimeSource);
assert.deepEqual(routes, canonicalRoutes, 'Server route resource differs from canonical contracts manifest');
const bridgeRoutes = JSON.parse(readFileSync(new URL('../../mcp-bridge/src/resources/bridge-tool-routes.json', import.meta.url), 'utf8'));
assert.deepEqual(bridgeRoutes, canonicalRoutes, 'Bridge route resource differs from canonical contracts manifest');
const internalBridgeRoutes = [
  '/bridge/jlceda/component/place/start',
  '/bridge/jlceda/component/place/check',
  '/bridge/jlceda/component/place/close',
];

for (const toolName of definitionNames) {
  assert.ok(routes[toolName], `Tool definition has no canonical route: ${toolName}`);
}
for (const toolName of Object.keys(routes)) {
  assert.ok(definitionNames.has(toolName), `Dispatcher route has no tool definition: ${toolName}`);
}
for (const [toolName, path] of Object.entries(routes)) {
  if (path.startsWith('/bridge/admin/')) {
    assert.ok(
      bridgeServerSource.includes(`'${path}'`) || bridgeServerSource.includes(`\`${path}\``),
      `Dispatcher admin route has no server implementation: ${toolName} -> ${path}`,
    );
    continue;
  }
  assert.ok(handlerRoutes.has(path), `Dispatcher route has no bridge handler: ${toolName} -> ${path}`);
}
for (const path of internalBridgeRoutes) {
  assert.ok(declaredInternalRoutes.has(path), `Internal orchestration route is not allowlisted: ${path}`);
  assert.ok(handlerRoutes.has(path), `Internal orchestration route has no bridge handler: ${path}`);
}
const expectedHandlerRoutes = new Set([
  ...Object.values(routes).filter((path) => !path.startsWith('/bridge/admin/')),
  ...internalBridgeRoutes,
]);
assert.deepEqual(handlerRoutes, expectedHandlerRoutes, 'Bridge task handlers must exactly match public and internal route contracts');
assert.deepEqual(declaredInternalRoutes, new Set(internalBridgeRoutes), 'Bridge internal route allowlist must exactly match orchestration routes');

process.stdout.write(`Verified ${Object.keys(routes).length} synchronized MCP tool routes\n`);
