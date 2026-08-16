import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ToolDispatcher } from './tool-dispatcher.js';

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
    const inputSchema = z.fromJSONSchema(definition.inputSchema as z.core.JSONSchema.JSONSchema);
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
