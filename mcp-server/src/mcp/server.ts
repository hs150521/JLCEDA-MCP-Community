import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ToolDispatcher } from './tool-dispatcher.js';

function createToolInputSchema(
  name: string,
  inputSchema: Record<string, unknown>,
): z.ZodType {
  // MCP SDK v2 cannot encode JSON Schema conditional keywords for the legacy
  // tool advertisement. Keep the canonical JSON definition unchanged, but
  // express this one conditional contract as a Zod union at registration time.
  if (name === 'bridge_recover_client') {
    const properties = inputSchema.properties as Record<string, unknown> | undefined;
    const readbackDefinition = properties?.readbackPath as { enum?: unknown; default?: unknown } | undefined;
    const readbackPaths = readbackDefinition?.enum;
    const readbackDefault = readbackDefinition?.default;
    if (!Array.isArray(readbackPaths) || readbackPaths.length === 0
      || readbackPaths.some(path => typeof path !== 'string' || !path.trim())) {
      throw new Error('bridge_recover_client readbackPath enum must contain non-empty strings.');
    }
    if (typeof readbackDefault !== 'string' || !readbackPaths.includes(readbackDefault)) {
      throw new Error('bridge_recover_client readbackPath default must belong to its enum.');
    }
    const common = {
      confirm: z.literal(true),
      timeoutMs: z.number().int().min(5000).max(120000).default(60000),
      requestId: z.string().min(1).optional(),
      recoveryId: z.string().min(1).optional(),
      clientId: z.string().min(1).optional(),
      expectedDocumentUuid: z.string().min(1).optional(),
      expectedProjectUuid: z.string().min(1).optional(),
      expectedPageUuid: z.string().min(1).optional(),
      resolution: z.enum(['applied', 'cancelled']).optional(),
      hostRestartConfirmed: z.literal(true).optional(),
      readbackPath: z.enum(readbackPaths as [string, ...string[]]).default(readbackDefault),
      readbackPayload: z.record(z.string(), z.unknown()).default({}),
    };
    const recover = z.object({ ...common, action: z.literal('recover').default('recover'), requestId: z.string().min(1) }).strict();
    const readback = z.object({
      ...common,
      action: z.literal('readback'),
      recoveryId: z.string().min(1),
      clientId: z.string().min(1),
    }).strict();
    const resolveImport = z.object({
      ...common,
      action: z.literal('resolve_import'),
      requestId: z.string().min(1),
      resolution: z.enum(['applied', 'cancelled']),
    }).strict();
    return z.union([recover, readback, resolveImport]);
  }
  if (name === 'pcb_layer_manage') {
    return z.discriminatedUnion('action', [
      z.object({ action: z.literal('read'), timeoutMs: z.number().int().min(5000).max(120000).optional() }).strict(),
      z.object({ action: z.literal('set'), confirm: z.literal(true), copperLayerCount: z.number().int().min(2).max(32).multipleOf(2), timeoutMs: z.number().int().min(5000).max(120000).optional() }).strict(),
    ]);
  }
  const schema = z.fromJSONSchema(inputSchema as z.core.JSONSchema.JSONSchema);
  if (name === 'pcb_component_edit' || name === 'schematic_component_edit' || name === 'schematic_wire_manage' || name === 'schematic_text_manage' || name === 'pcb_pour_manage' || name === 'pcb_routing_edit' || name === 'pcb_board_outline_manage' || name === 'pcb_region_manage' || name === 'pcb_text_manage') {
    // z.fromJSONSchema currently omits minProperties. Preserve the advertised
    // contract when the call reaches the MCP parser.
    return schema.superRefine((value, context) => {
      if (typeof value === 'object' && value !== null && 'action' in value && value.action === 'modify'
        && 'property' in value && typeof value.property === 'object' && value.property !== null
        && Object.keys(value.property).length === 0) {
        context.addIssue({ code: 'custom', path: ['property'], message: 'property must contain at least one field' });
      }
    });
  }
  return schema;
}

export function createMcpServer(
  toolDispatcher: ToolDispatcher,
  serverVersion: string,
  instructions: string,
): McpServer {
  const server = new McpServer(
    {
      name: 'jlceda-mcp-server',
      title: 'JLCEDA MCP Community',
      version: serverVersion,
    },
    {
      capabilities: { tools: {} },
      instructions,
    },
  );

  for (const definition of toolDispatcher.getToolDefinitions()) {
    const inputSchema = createToolInputSchema(definition.name, definition.inputSchema);
    server.registerTool(
      definition.name,
      {
        description: definition.description,
        inputSchema,
      },
      async (args): Promise<CallToolResult> => {
        return await toolDispatcher.dispatch({
          name: definition.name,
          arguments: typeof args === 'object' && args !== null ? args as Record<string, unknown> : {},
        });
      },
    );
  }

  return server;
}
