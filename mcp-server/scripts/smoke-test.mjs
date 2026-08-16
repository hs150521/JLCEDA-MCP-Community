import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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

const lines = createInterface({ input: child.stdout });
child.stdin.write(JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke-test', version: '1.0.0' },
  },
}) + '\n');

const linePromise = once(lines, 'line');
const timeoutPromise = new Promise((_, reject) => {
  setTimeout(() => reject(new Error('Timed out waiting for initialize response')), 5000);
});
const [line] = await Promise.race([linePromise, timeoutPromise]);
const response = JSON.parse(line);
assert.equal(response.jsonrpc, '2.0');
assert.equal(response.id, 1);
assert.equal(response.result?.serverInfo?.name, 'jlceda-mcp-server');

child.stdin.end();
const exitPromise = once(child, 'exit');
const exitTimeout = new Promise((_, reject) => {
  setTimeout(() => reject(new Error('Server did not stop after stdin EOF')), 5000);
});
const [code] = await Promise.race([exitPromise, exitTimeout]);
assert.equal(code, 0, stderr);

process.stdout.write('MCP server smoke test passed\n');
