import type esbuild from 'esbuild';
import process from 'node:process';

// Bridge 通用 esbuild 构建配置。
export default {
	entryPoints: {
		index: './src/index',
		settings: './src/page/settings',
	},
	entryNames: '[name]',
	assetNames: '[name]',
	bundle: true, // 用于内部方法调用，请勿修改
	minify: false, // 用于内部方法调用，请勿修改
	loader: {},
	outdir: './dist/',
	sourcemap: undefined,
	platform: 'browser', // 用于内部方法调用，请勿修改
	format: 'iife', // 用于内部方法调用，请勿修改
	globalName: 'edaEsbuildExportName', // 用于内部方法调用，请勿修改
	treeShaking: true,
	ignoreAnnotations: true,
	define: {
		__MCP_BRIDGE_BUILD_DATE__: JSON.stringify(process.env.MCP_BRIDGE_BUILD_DATE?.trim() || new Date().toISOString().slice(0, 10)),
	},
	external: [],
} satisfies Parameters<(typeof esbuild)['build']>[0];
