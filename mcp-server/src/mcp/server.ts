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
    const common = {
      confirm: z.literal(true),
      requestId: z.string().min(1).optional(),
      recoveryId: z.string().min(1).optional(),
      clientId: z.string().min(1).optional(),
      expectedDocumentUuid: z.string().min(1).optional(),
      expectedProjectUuid: z.string().min(1).optional(),
      readbackPath: z.enum([
        '/bridge/jlceda/context',
        '/bridge/jlceda/schematic/read',
        '/bridge/jlceda/schematic/review',
        '/bridge/jlceda/schematic/layout-check',
        '/bridge/jlceda/pcb/drc-check',
        '/bridge/jlceda/schematic/drc-check',
      ]).default('/bridge/jlceda/context'),
      readbackPayload: z.record(z.string(), z.unknown()).optional(),
    };
    const recover = z.object({ ...common, action: z.literal('recover').default('recover'), requestId: z.string().min(1) }).strict();
    const readback = z.object({
      ...common,
      action: z.literal('readback'),
      recoveryId: z.string().min(1),
      clientId: z.string().min(1),
    }).strict();
    return z.union([recover, readback]);
  }
  return z.fromJSONSchema(inputSchema as z.core.JSONSchema.JSONSchema);
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
