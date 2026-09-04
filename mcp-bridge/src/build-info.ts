import extensionConfig from '../extension.json';

declare const __MCP_BRIDGE_BUILD_DATE__: string | undefined;

export const BRIDGE_VERSION = String(extensionConfig.version ?? 'unknown');
export const BRIDGE_BUILD_DATE = typeof __MCP_BRIDGE_BUILD_DATE__ === 'string'
	&& /^\d{4}-\d{2}-\d{2}$/.test(__MCP_BRIDGE_BUILD_DATE__)
	? __MCP_BRIDGE_BUILD_DATE__
	: 'dev';
export const BRIDGE_BUILD_WATERMARK = `v${BRIDGE_VERSION} | ${BRIDGE_BUILD_DATE}`;
