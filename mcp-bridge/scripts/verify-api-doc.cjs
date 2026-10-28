const { spawnSync } = require('node:child_process');
const path = require('node:path');
const process = require('node:process');

const isWindows = process.platform === 'win32';
const executable = process.env.PYTHON || (isWindows ? 'py' : 'python3');
const pythonArgs = isWindows && !process.env.PYTHON ? ['-3'] : [];
const options = { stdio: 'inherit', env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' } };
const tests = spawnSync(executable, [...pythonArgs, path.join('..', 'tool', 'test_generate_jlceda_api_doc.py')], options);
if (tests.error)
	throw tests.error;
if (tests.status !== 0)
	process.exit(tests.status ?? 1);
const generatorPath = path.join('..', 'tool', 'generate_jlceda_api_doc.py');
const result = spawnSync(executable, [
	...pythonArgs,
	generatorPath,
	'--input',
	'node_modules/@jlceda/pro-api-types/index.d.ts',
	'--output',
	'resources/jlceda-pro-api-doc.json',
	'--typescript-module',
	'node_modules/typescript/lib/typescript.js',
	'--check',
], options);

if (result.error) {
	throw result.error;
}
process.exitCode = result.status ?? 1;
