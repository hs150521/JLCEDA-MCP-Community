const { spawnSync } = require('node:child_process');
const path = require('node:path');

const isWindows = process.platform === 'win32';
const executable = isWindows ? 'py' : 'python3';
const pythonArgs = isWindows ? ['-3'] : [];
const generatorPath = path.join('..', 'tool', 'generate_jlceda_api_doc.py');
const result = spawnSync(executable, [
	...pythonArgs,
	generatorPath,
	'--input', 'node_modules/@jlceda/pro-api-types/index.d.ts',
	'--output', 'resources/jlceda-pro-api-doc.json',
	'--typescript-module', 'node_modules/typescript/lib/typescript.js',
	'--check',
], { stdio: 'inherit' });

if (result.error) {
	throw result.error;
}
process.exitCode = result.status ?? 1;
