#!/usr/bin/env node

import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EdaBridgeServer } from './mcp/bridge-client.js';
import { createMcpServer } from './mcp/server.js';
import { ToolDispatcher } from './mcp/tool-dispatcher.js';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(
  readFileSync(join(currentDirectory, '..', 'package.json'), 'utf8'),
) as { version?: string };
const serverVersion = packageJson.version || '2.0.0';
const agentInstructions = readFileSync(
  join(currentDirectory, 'resources', 'agent-instructions.md'),
  'utf8',
).trimEnd();

function readBridgePort(): number {
  const rawPort = process.env.JLCEDA_BRIDGE_PORT || '8765';
  const port = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid JLCEDA_BRIDGE_PORT: ${rawPort}`);
  }
  return port;
}

async function main(): Promise<void> {
  const bridgePort = readBridgePort();
  process.stderr.write(`JLCEDA MCP Server v${serverVersion}\n`);
  process.stderr.write(`Starting WebSocket server on port ${bridgePort}...\n`);

  const bridgeServer = new EdaBridgeServer(bridgePort);
  await bridgeServer.start();
  process.stderr.write(`Bridge mode: ${bridgeServer.getMode()}\n`);

  const toolDispatcher = new ToolDispatcher(bridgeServer);
  const stdioServer = serveStdio(
    () => createMcpServer(toolDispatcher, serverVersion, agentInstructions),
    {
      onerror: (error) => process.stderr.write(`MCP transport error: ${error.message}\n`),
    },
  );

  process.stderr.write('MCP server listening on stdio\n');
  let shuttingDown = false;
  const cleanup = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    process.stderr.write('Shutting down...\n');
    await stdioServer.close();
    bridgeServer.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void cleanup());
  process.on('SIGTERM', () => void cleanup());
  process.stdin.on('end', () => void cleanup());
}

process.on('uncaughtException', (error) => {
  process.stderr.write(`Uncaught exception: ${error.message}\n`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  process.stderr.write(`Unhandled rejection: ${String(reason)}\n`);
  process.exit(1);
});

void main().catch((error) => {
  process.stderr.write(`Failed to start server: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
