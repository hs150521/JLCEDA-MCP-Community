import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(repositoryRoot, 'contracts', 'bridge-contract.json');
const targets = [
  resolve(repositoryRoot, 'mcp-server', 'src', 'resources', 'bridge-contract.json'),
  resolve(repositoryRoot, 'mcp-bridge', 'src', 'resources', 'bridge-contract.json'),
];

for (const target of targets) {
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target);
}
