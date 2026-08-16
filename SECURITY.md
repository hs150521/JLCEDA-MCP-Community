# Security policy

JLCEDA MCP Community controls an EDA application through a local WebSocket bridge. Some exposed operations can modify schematics, PCB documents, libraries, and project data. Treat access to the bridge as equivalent to interactive access to the open EDA session.

## Supported code

Security fixes are developed on `native-mcp-v2` until that architecture is promoted to the stable branch. Released versions and the current stable branch receive priority.

## Reporting a vulnerability

Report security issues privately to `hs150521@proton.me`. Include the affected commit or release, reproduction steps, impact, and any suggested mitigation. Please do not publish a working exploit before a fix is available.

## Local bridge protections

- The native bridge listens only on `127.0.0.1`.
- Set `JLCEDA_BRIDGE_TOKEN` to require a shared secret on both `/bridge/ws` and `/mcp-internal`.
- The EDA extension connects with `?token=...` in its configured WebSocket URL.
- Bridge logs redact `token`, `access_token`, and `auth` query parameters.
- Never expose port 8765 through a firewall rule, reverse proxy, tunnel, or port-forward.

Running without `JLCEDA_BRIDGE_TOKEN` is supported temporarily for local compatibility, but it allows any process running as the local user to attempt a bridge connection.
