# Native MCP setup

This document applies to the community `native-mcp-v2` branch.

## 1. Build the server

```powershell
cd mcp-server
npm ci
npm test
```

The build copies required runtime resources into `dist/resources`. Do not run an older `dist` directory produced without this step.

## 2. Create a bridge token

Use a random value of at least 32 bytes. One PowerShell example is:

```powershell
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
[Convert]::ToBase64String($bytes)
```

Keep the output private. Reuse the same value for every MCP client that must share the local EDA bridge.

## 3. Configure the MCP client

Start `mcp-server/dist/index.js` with these environment variables:

```json
{
  JLCEDA_BRIDGE_PORT: 8765,
  JLCEDA_BRIDGE_TOKEN: replace-with-your-random-token
}
```

The server binds to `127.0.0.1` only. The first MCP process owns the WebSocket listener; later processes connect to it through the authenticated `/mcp-internal` route.

## 4. Configure the EDA extension

Open the extension settings page and save:

```text
ws://127.0.0.1:8765/bridge/ws?token=replace-with-your-random-token
```

The settings page displays the configured URL. Treat screenshots of that page as sensitive. Runtime bridge logs redact the token.

## 5. Avoid mixed architectures

Do not run the legacy MCP Hub and the native MCP server on the same port. Stop the old MCP process or assign different ports before testing. A process that owns port 8765 but does not implement `/mcp-internal` will make additional native MCP sessions fail to start.

## 6. Select the EDA target

When more than one editable JLCEDA page is open, call `bridge_clients` before
any EDA operation. Match the returned project and page identity, then pass its
exact `clientId` to `bridge_select_client`. The identity fields come from the
official JLCEDA context APIs and refresh when the active editor tab changes.

The server rejects unknown or unready clients. It also refuses to change the
target while the current active page has an unfinished request.

## 7. Protocol support

The server uses the official MCP TypeScript Server SDK 2.x:

- 2024/2025 clients use the legacy `initialize` lifecycle.
- 2026-07-28 clients use `server/discover` and per-request `_meta` envelopes.

Both paths are covered by automated smoke tests.
