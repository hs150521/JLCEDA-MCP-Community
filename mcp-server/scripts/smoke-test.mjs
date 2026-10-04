import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const recoveryReadbackSchema = JSON.parse(readFileSync(resolve(packageRoot, 'src/resources/mcp-tool-definitions.json'), 'utf8'))
  .find(tool => tool.name === 'bridge_recover_client').inputSchema.properties.readbackPath;

function findPropertySchemas(schema, propertyName, matches = []) {
  if (!schema || typeof schema !== 'object') {
    return matches;
  }
  if (!Array.isArray(schema) && schema.properties?.[propertyName]) {
    matches.push(schema.properties[propertyName]);
  }
  for (const value of Object.values(schema)) {
    if (value && typeof value === 'object') {
      findPropertySchemas(value, propertyName, matches);
    }
  }
  return matches;
}

async function testProtocolVersion(protocolVersion) {
  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: packageRoot,
    env: { ...process.env, JLCEDA_BRIDGE_PORT: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  try {
    const lines = createInterface({ input: child.stdout });
    const modern = protocolVersion === '2026-07-28';
    const params = modern
      ? {
        _meta: {
        'io.modelcontextprotocol/protocolVersion': protocolVersion,
        'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': { name: 'smoke-test', version: '1.0.0' },
        },
      }
      : {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: 'smoke-test', version: '1.0.0' },
      };
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: modern ? 'server/discover' : 'initialize',
      params,
    }) + '\n');

    const lineTimeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Timed out waiting for initialize response')), 5000);
    });
    const [line] = await Promise.race([once(lines, 'line'), lineTimeout]);
    const response = JSON.parse(line);
    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.id, 1);
    if (modern) {
      assert.ok(response.result?.resultType === 'complete', JSON.stringify(response));
      assert.equal(
        response.result?._meta?.['io.modelcontextprotocol/serverInfo']?.name,
        'jlceda-mcp-server',
      );
    } else {
      assert.equal(response.result?.protocolVersion, protocolVersion);
      assert.equal(response.result?.serverInfo?.name, 'jlceda-mcp-server');
      child.stdin.write(JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }) + '\n');
    }

    const toolsLinePromise = once(lines, 'line');
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: modern ? params : {},
    }) + '\n');
    const [toolsLine] = await Promise.race([toolsLinePromise, lineTimeout]);
    const toolsResponse = JSON.parse(toolsLine);
    assert.equal(toolsResponse.id, 2);
    assert.ok(Array.isArray(toolsResponse.result?.tools));
    assert.ok(toolsResponse.result.tools.some((tool) => tool.name === 'eda_context'));
    assert.ok(toolsResponse.result.tools.some((tool) => tool.name === 'pcb_component_edit'));
    assert.ok(toolsResponse.result.tools.some((tool) => tool.name === 'pcb_pour_manage'));
    const routingTool = toolsResponse.result.tools.find((tool) => tool.name === 'pcb_routing_edit');
    assert.ok(routingTool?.inputSchema, 'pcb_routing_edit must be advertised');
    const boardOutlineTool = toolsResponse.result.tools.find((tool) => tool.name === 'pcb_board_outline_manage');
    assert.ok(boardOutlineTool?.inputSchema, 'pcb_board_outline_manage must be advertised');
    const regionTool = toolsResponse.result.tools.find((tool) => tool.name === 'pcb_region_manage');
    assert.ok(regionTool?.inputSchema, 'pcb_region_manage must be advertised');
    const textTool = toolsResponse.result.tools.find((tool) => tool.name === 'pcb_text_manage');
    assert.ok(textTool?.inputSchema, 'pcb_text_manage must be advertised');
    const schematicTextTool = toolsResponse.result.tools.find((tool) => tool.name === 'schematic_text_manage');
    assert.ok(schematicTextTool?.inputSchema, 'schematic_text_manage must be advertised');
    const layerTool = toolsResponse.result.tools.find((tool) => tool.name === 'pcb_layer_manage');
    assert.ok(layerTool?.inputSchema, 'pcb_layer_manage must be advertised');
    assert.ok(findPropertySchemas(layerTool.inputSchema, 'confirm').some(schema => schema.const === true),
      'pcb_layer_manage must publish confirm=true for set');
    assert.ok(layerTool.inputSchema.oneOf?.some(rule => rule.properties?.action?.const === 'set' && rule.required?.includes('confirm')),
      'pcb_layer_manage set must require confirmation in the advertised schema');
    assert.ok(layerTool.inputSchema.oneOf?.every(rule => rule.properties?.timeoutMs?.maximum === 120000),
      'pcb_layer_manage read and set must publish an adjustable timeout');
    const recoverTool = toolsResponse.result.tools.find((tool) => tool.name === 'bridge_recover_client');
    assert.ok(recoverTool?.inputSchema, 'bridge_recover_client must publish an input schema');
    const confirmSchemas = findPropertySchemas(recoverTool.inputSchema, 'confirm');
    assert.ok(confirmSchemas.some((schema) => schema.const === true), 'bridge_recover_client must require confirm=true');
    const recoveryTimeoutSchemas = findPropertySchemas(recoverTool.inputSchema, 'timeoutMs');
    assert.ok(recoveryTimeoutSchemas.some((schema) => schema.minimum === 5000 && schema.maximum === 120000), 'bridge_recover_client must advertise its extended readback budget');
    const readbackPayloadSchemas = findPropertySchemas(recoverTool.inputSchema, 'readbackPayload');
    assert.ok(readbackPayloadSchemas.some((schema) => JSON.stringify(schema.default) === '{}'), 'bridge_recover_client must publish the empty readbackPayload default');
    const readbackPathSchemas = findPropertySchemas(recoverTool.inputSchema, 'readbackPath');
    assert.ok(readbackPathSchemas.every(schema => JSON.stringify(schema.enum) === JSON.stringify(recoveryReadbackSchema.enum)),
      'MCP tools/list recovery paths must match the canonical definition, including footprint and project readback');
    assert.ok(readbackPathSchemas.every(schema => schema.default === recoveryReadbackSchema.default),
      'MCP tools/list must preserve the canonical recovery path default');
    assert.ok(readbackPathSchemas.some((schema) => schema.enum?.includes('/bridge/jlceda/api/invoke')), 'bridge_recover_client must allow current-page API readback');
    assert.ok(readbackPathSchemas.some((schema) => schema.enum?.includes('/bridge/jlceda/schematic/component-edit')), 'bridge_recover_client must publish schematic component state readback');
    assert.ok(readbackPathSchemas.some((schema) => schema.enum?.includes('/bridge/jlceda/pcb/component-edit')), 'bridge_recover_client must publish PCB component state readback');
    assert.ok(readbackPathSchemas.some((schema) => schema.enum?.includes('/bridge/jlceda/pcb/documents-manage')), 'bridge_recover_client must publish PCB document inventory readback');
    assert.ok(readbackPathSchemas.some((schema) => schema.enum?.includes('/bridge/jlceda/pcb/pour-manage')), 'bridge_recover_client must publish PCB pour state readback');
    assert.ok(readbackPathSchemas.some((schema) => schema.enum?.includes('/bridge/jlceda/pcb/region-manage')), 'bridge_recover_client must publish PCB region state readback');
    assert.ok(readbackPathSchemas.some((schema) => schema.enum?.includes('/bridge/jlceda/pcb/text-manage')), 'bridge_recover_client must publish PCB text state readback');
    assert.ok(readbackPathSchemas.some((schema) => schema.enum?.includes('/bridge/jlceda/pcb/layer-manage')), 'bridge_recover_client must publish PCB copper-layer state readback');
    const expectedPageSchemas = findPropertySchemas(recoverTool.inputSchema, 'expectedPageUuid');
    assert.ok(expectedPageSchemas.some((schema) => schema.type === 'string'), 'bridge_recover_client must publish the optional page UUID');
    const actionSchemas = findPropertySchemas(recoverTool.inputSchema, 'action');
    assert.ok(actionSchemas.some((schema) => schema.const === 'resolve_import'), 'bridge_recover_client must advertise explicit PCB import resolution');
    const resolutionSchemas = findPropertySchemas(recoverTool.inputSchema, 'resolution');
    assert.ok(resolutionSchemas.some((schema) => schema.enum?.includes('applied') && schema.enum?.includes('cancelled')), 'bridge_recover_client must advertise both native dialog outcomes');

    // Exercise the registered MCP parser, not just the repository JSON Schema.
    // With no active recovery session, the accepted input must reach the Bridge
    // recovery handler and return its normal missing-session error.
    const callLinePromise = once(lines, 'line');
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: {
        ...(modern ? params : {}),
        name: 'bridge_recover_client',
        arguments: { action: 'readback', confirm: true, timeoutMs: 120000, recoveryId: 'smoke-recovery', clientId: 'smoke-client',
          readbackPath: '/bridge/jlceda/schematic/component-edit', readbackPayload: { action: 'read' } },
      },
    }) + '\n');
    const [callLine] = await Promise.race([callLinePromise, lineTimeout]);
    const callResponse = JSON.parse(callLine);
    assert.equal(callResponse.id, 3);
    assert.match(JSON.stringify(callResponse), /No Bridge recovery is awaiting readback/);

    const pcbCallLinePromise = once(lines, 'line');
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: {
        ...(modern ? params : {}),
        name: 'bridge_recover_client',
        arguments: { action: 'readback', confirm: true, recoveryId: 'smoke-pcb-recovery', clientId: 'smoke-pcb-client',
          readbackPath: '/bridge/jlceda/pcb/component-edit', readbackPayload: { action: 'read' } },
      },
    }) + '\n');
    const [pcbCallLine] = await Promise.race([pcbCallLinePromise, lineTimeout]);
    const pcbCallResponse = JSON.parse(pcbCallLine);
    assert.equal(pcbCallResponse.id, 4);
    assert.match(JSON.stringify(pcbCallResponse), /No Bridge recovery is awaiting readback/);

    const documentCallLinePromise = once(lines, 'line');
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 40, method: 'tools/call',
      params: {
        ...(modern ? params : {}),
        name: 'bridge_recover_client',
        arguments: { action: 'readback', confirm: true, recoveryId: 'smoke-document-recovery', clientId: 'smoke-document-client',
          readbackPath: '/bridge/jlceda/pcb/documents-manage', readbackPayload: { operation: 'list', projectUuid: 'smoke-project' } },
      },
    }) + '\n');
    const [documentCallLine] = await Promise.race([documentCallLinePromise, lineTimeout]);
    const documentCallResponse = JSON.parse(documentCallLine);
    assert.equal(documentCallResponse.id, 40);
    assert.match(JSON.stringify(documentCallResponse), /No Bridge recovery is awaiting readback/);

    for (const [id, readbackPath] of [[41, '/bridge/jlceda/footprint/read'], [42, '/bridge/jlceda/project/info'], [43, '/bridge/jlceda/not-a-recovery-readback']]) {
      const recoveryLinePromise = once(lines, 'line');
      child.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id, method: 'tools/call',
        params: {
          ...(modern ? params : {}),
          name: 'bridge_recover_client',
          arguments: { action: 'readback', confirm: true, recoveryId: 'smoke-schema-recovery', clientId: 'smoke-schema-client',
            readbackPath, readbackPayload: {} },
        },
      }) + '\n');
      const [recoveryLine] = await Promise.race([recoveryLinePromise, lineTimeout]);
      const recoveryResponse = JSON.parse(recoveryLine);
      assert.equal(recoveryResponse.id, id);
      assert.match(JSON.stringify(recoveryResponse), id === 43 ? /Invalid arguments/ : /No Bridge recovery is awaiting readback/,
        'known readback paths must pass the real MCP SDK parser and reach dispatch; unknown paths must be rejected');
    }

    const invalidCallLinePromise = once(lines, 'line');
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: {
        ...(modern ? params : {}),
        name: 'pcb_component_edit',
        arguments: { action: 'modify', primitiveId: 'p1', property: {} },
      },
    }) + '\n');
    const [invalidCallLine] = await Promise.race([invalidCallLinePromise, lineTimeout]);
    const invalidCallResponse = JSON.parse(invalidCallLine);
    assert.equal(invalidCallResponse.id, 5);
    assert.match(JSON.stringify(invalidCallResponse), /property must contain at least one field/);

    const pourCallLinePromise = once(lines, 'line');
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: {
        ...(modern ? params : {}),
        name: 'bridge_recover_client',
        arguments: { action: 'readback', confirm: true, recoveryId: 'smoke-pour-recovery', clientId: 'smoke-pour-client',
          readbackPath: '/bridge/jlceda/pcb/pour-manage', readbackPayload: { action: 'read' } },
      },
    }) + '\n');
    const [pourCallLine] = await Promise.race([pourCallLinePromise, lineTimeout]);
    const pourCallResponse = JSON.parse(pourCallLine);
    assert.equal(pourCallResponse.id, 6);
    assert.match(JSON.stringify(pourCallResponse), /No Bridge recovery is awaiting readback/);

    const invalidPourCallLinePromise = once(lines, 'line');
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: {
        ...(modern ? params : {}),
        name: 'pcb_pour_manage',
        arguments: { action: 'modify', primitiveId: 'pour-1', property: {} },
      },
    }) + '\n');
    const [invalidPourCallLine] = await Promise.race([invalidPourCallLinePromise, lineTimeout]);
    const invalidPourCallResponse = JSON.parse(invalidPourCallLine);
    assert.equal(invalidPourCallResponse.id, 7);
    assert.match(JSON.stringify(invalidPourCallResponse), /property must contain at least one field/);

    const invalidRoutingCallLinePromise = once(lines, 'line');
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 8, method: 'tools/call',
      params: {
        ...(modern ? params : {}),
        name: 'pcb_routing_edit',
        arguments: { action: 'modify', kind: 'line', primitiveId: 'line-1', property: {} },
      },
    }) + '\n');
    const [invalidRoutingCallLine] = await Promise.race([invalidRoutingCallLinePromise, lineTimeout]);
    const invalidRoutingCallResponse = JSON.parse(invalidRoutingCallLine);
    assert.equal(invalidRoutingCallResponse.id, 8);
    assert.match(JSON.stringify(invalidRoutingCallResponse), /property must contain at least one field/);

    const routingReadLinePromise = once(lines, 'line');
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 9, method: 'tools/call',
      params: { ...(modern ? params : {}), name: 'pcb_routing_edit', arguments: { action: 'read' } },
    }) + '\n');
    const [routingReadLine] = await Promise.race([routingReadLinePromise, lineTimeout]);
    const routingReadResponse = JSON.parse(routingReadLine);
    assert.equal(routingReadResponse.id, 9);
    assert.match(JSON.stringify(routingReadResponse), /No ready EDA client connected/);

    const boardOutlineReadLinePromise = once(lines, 'line');
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 10, method: 'tools/call',
      params: { ...(modern ? params : {}), name: 'pcb_board_outline_manage', arguments: { action: 'read' } },
    }) + '\n');
    const [boardOutlineReadLine] = await Promise.race([boardOutlineReadLinePromise, lineTimeout]);
    const boardOutlineReadResponse = JSON.parse(boardOutlineReadLine);
    assert.equal(boardOutlineReadResponse.id, 10);
    assert.match(JSON.stringify(boardOutlineReadResponse), /No ready EDA client connected/);

    const unconfirmedLayerLinePromise = once(lines, 'line');
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 11, method: 'tools/call',
      params: { ...(modern ? params : {}), name: 'pcb_layer_manage', arguments: { action: 'set', copperLayerCount: 4 } },
    }) + '\n');
    const [unconfirmedLayerLine] = await Promise.race([unconfirmedLayerLinePromise, lineTimeout]);
    const unconfirmedLayerResponse = JSON.parse(unconfirmedLayerLine);
    assert.equal(unconfirmedLayerResponse.id, 11);
    assert.match(JSON.stringify(unconfirmedLayerResponse), /confirm/);

    const confirmedLayerLinePromise = once(lines, 'line');
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 12, method: 'tools/call',
      params: { ...(modern ? params : {}), name: 'pcb_layer_manage', arguments: { action: 'set', confirm: true, copperLayerCount: 4, timeoutMs: 120000 } },
    }) + '\n');
    const [confirmedLayerLine] = await Promise.race([confirmedLayerLinePromise, lineTimeout]);
    const confirmedLayerResponse = JSON.parse(confirmedLayerLine);
    assert.equal(confirmedLayerResponse.id, 12);
    assert.match(JSON.stringify(confirmedLayerResponse), /No ready EDA client connected/);

    child.stdin.end();
    const exitTimeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Server did not stop after stdin EOF')), 5000);
    });
    const [code] = await Promise.race([once(child, 'exit'), exitTimeout]);
    assert.equal(code, 0, stderr);
  } finally {
    if (child.exitCode === null) {
      child.kill();
    }
  }
}

await testProtocolVersion('2024-11-05');
await testProtocolVersion('2026-07-28');
process.stdout.write('MCP server legacy and modern protocol smoke tests passed\n');
