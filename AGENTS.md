# AGENTS.md

## Repository structure

Dual-package monorepo for JLCEDA EDA integration via the MCP protocol:

- `mcp-server/` - Node.js MCP server. It exposes MCP over stdio and hosts the localhost WebSocket bridge.
- `mcp-bridge/` - JLCEDA EDA extension. It connects to `mcp-server` and executes EDA operations.
- `build/` - packaged JLCEDA extension output (`.eext`).
- `tool/` - utility scripts, including offline API-document generation.

There is no root-level build orchestration. Build each package from its own directory.

## Build commands

```powershell
# MCP server
cd mcp-server
npm install
npm run build

# JLCEDA extension
cd ../mcp-bridge
npm install
npm run build  # produces ../build/mcp-bridge-community-{version}.eext
```

`mcp-server` produces runtime files in `mcp-server/dist/`. `mcp-bridge` uses esbuild and ts-node, then writes its EDA extension package to `build/`.

## Test commands

```powershell
cd mcp-server
npm test
node verify-multi-client.mjs

cd ../mcp-bridge
npm run test:netlabel
npm run test:2.1
npm run typecheck
npm run lint
```

The multi-client entry points run the maintained bridge protocol integration test. It requires a built `mcp-server/dist/` tree.

## Cross-package coordination

When adding or changing an MCP tool:

1. Update `mcp-server/src/resources/mcp-tool-definitions.json`.
2. Update the server route/dispatcher in `mcp-server/src/`.
3. Update the corresponding handler and runtime route in `mcp-bridge/src/`.
4. Update relevant READMEs and CHANGELOGs in both packages and the root README.
5. Add focused schema and handler tests.

Tool definitions, dispatcher routes, bridge runtime routes, and handler behavior must stay synchronized.

## Manual verification

- Install the built `.eext` in JLCEDA EDA Professional.
- Start the built MCP server with `node mcp-server/dist/index.js` or the packaged `jlceda-mcp` command.
- Open a schematic or PCB page and confirm it connects to `ws://127.0.0.1:8765/bridge/ws`.
- Invoke the tool through an MCP client and verify the active bridge client executes it.

Only schematic and PCB pages establish bridge connections. Multiple pages can connect, but the active bridge client executes tasks.

## Requirements

- Node.js 20+
- JLCEDA EDA Professional
