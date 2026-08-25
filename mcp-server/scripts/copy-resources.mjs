import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = resolve(packageRoot, 'src', 'resources');
const outputRoot = resolve(packageRoot, 'dist', 'resources');
const resources = ['agent-instructions.md', 'mcp-tool-definitions.json', 'bridge-tool-routes.json'];

await mkdir(outputRoot, { recursive: true });

for (const resource of resources) {
  await cp(resolve(sourceRoot, resource), resolve(outputRoot, resource));
}
