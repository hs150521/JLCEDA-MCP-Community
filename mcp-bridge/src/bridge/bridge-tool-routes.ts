import routes from '../resources/bridge-tool-routes.json';

/** Canonical tool-to-Bridge path manifest shared with the MCP server build. */
export const BRIDGE_TOOL_ROUTES: Readonly<Record<string, string>> = routes;

export function bridgePathForTool(toolName: string): string {
	const path = BRIDGE_TOOL_ROUTES[toolName];
	if (!path) {
		throw new Error(`Unknown Bridge tool: ${toolName}`);
	}
	return path;
}
