import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const bundle = readFileSync(new URL('../dist/index.js', import.meta.url), 'utf8');

for (const marker of ['bridge/hello', 'bridge/heartbeat', 'bridge/ready', 'getCurrentProjectInfo']) {
  assert.ok(bundle.includes(marker), `Packaged runtime is missing required marker: ${marker}`);
}

assert.ok(
  !bundle.includes('Starting bridge runtime (client mode)'),
  'Packaged runtime still contains the obsolete client-mode entry',
);

process.stdout.write('Packaged runtime entry verification passed\n');
