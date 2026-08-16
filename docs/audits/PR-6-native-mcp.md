# PR #6 native MCP architecture audit

Audit date: 2026-08-16  
Audited head: `090d441` (`sengbin/JLCEDA-MCP#6`)  
Community contact: `yuanzl150521@gmail.com`

## Verdict

The architectural direction is useful, but this branch is not ready to merge
into a release branch or publish to the JLCEDA extension marketplace. It should
be treated as a prototype and selectively rebuilt behind tests.

## Community remediation status

Status at community commit `efc54e7` on `native-mcp-v2`:

Resolved:

- build output now copies required runtime resources and is executed by smoke tests;
- stdio EOF shuts down the process and releases the bridge listener;
- WebSocket listening is restricted to `127.0.0.1` and exact paths;
- optional shared-token authentication covers EDA and internal MCP routes, with log redaction;
- EDA hello/welcome, heartbeat expiry, ready, active/standby lease, result validation and takeover are implemented;
- request IDs include a process UUID and multi-MCP routing is integration-tested;
- EDA peers report official project/document/page identity, and MCP tools can list and explicitly select the target client;
- surviving MCP processes can compete to take over the listener after the owner exits;
- the handwritten MCP implementation was replaced by the official TypeScript Server SDK 2.0;
- tests cover legacy initialize, 2026-07-28 server/discover, tools/list, bridge routing, path/auth rejection and EDA takeover;
- Linux, Windows and packaged-extension GitHub Actions jobs pass;
- temporary packages, duplicate server-side API data, backup transport and unreachable server handlers were removed; and
- the community extension has a new UUID, name, publisher, repository metadata and original artwork.

Still open before release:

- make shared-token authentication mandatory or provide a safe first-run token exchange;
- enable stricter TypeScript and establish a practical repository-wide lint baseline;
- install the packaged EEXT in supported JLCEDA versions and run real EDA API integration tests; and
- review every raw or mutating EDA tool for user-visible safety boundaries.

## Verification performed

- `mcp-server`: `npm ci` passed; `npm run build` passed.
- `mcp-bridge`: `npm ci` passed; `npm run build` produced an EEXT.
- Production dependency audit against `registry.npmjs.org`: zero known
  vulnerabilities in both packages.
- `mcp-server` lint did not run because no ESLint configuration exists.
- `mcp-bridge` source lint reported 222 errors; full lint additionally reports
  thousands of generated-JSON indentation errors.
- Starting the compiled MCP server failed before initialization because required
  runtime resources were not copied to `dist/resources`.

## Release blockers

### Critical: compiled MCP server is not runnable

`npm run build` only runs `tsc`. Runtime code reads resources relative to
`dist`, but the build does not copy them. Startup failed successively for:

- `dist/resources/agent-instructions.md`
- `dist/resources/mcp-tool-definitions.json`

The build command therefore gives a false-positive success result.

### Critical: unauthenticated WebSocket may listen beyond localhost

`EdaBridgeServer.startAsMainServer()` creates `WebSocketServer({ port })`
without an explicit host. It also accepts every URL path and has no origin,
token, role, or protocol handshake. Because the bridge exposes raw EDA API
invocation, accepting an unintended client can mutate the open EDA project.

The server must bind explicitly to `127.0.0.1` (and optionally `::1`), validate
the exact endpoint path, and authenticate both EDA and internal MCP peers with
an installation-scoped secret.

### High: no deterministic EDA page selection

Resolved on the community `native-mcp-v2` branch. The bridge now carries the
official API's project, document and page identifiers in hello/heartbeat
messages. `bridge_clients` lists every ready peer and `bridge_select_client`
changes the active lease by exact client ID. Selection rejects missing or
unready clients and refuses to switch away while an active task is pending.

All EDA sockets are stored in a `Set`, and requests go to the first socket.
There is no client identity, project/page context, ready state, active/standby
lease, or explicit page-selection operation. With multiple EDA tabs open, a
task may execute in the wrong project or page.

### High: multi-process routing is not session-safe

Additional MCP processes connect to `/mcp-internal` without authentication.
Request IDs are generated independently by each process and are not namespaced;
the main process stores all requests in one map. Collisions can misroute or
drop responses. There is also no robust promotion path when the original main
process exits.

### High: lifecycle and reconnection are incomplete

- The MCP process does not shut down when stdio reaches EOF, so an abandoned
  server can retain the fixed port.
- The EDA transport defines disconnect/error handlers but does not register a
  close callback with the transport used by this branch.
- There is no heartbeat or stale-connection detection.
- The server URL is hard-coded even though the UI describes connection settings.

### High: publishing metadata impersonates upstream/official identities

The extension retains the upstream UUID, name, logo, publisher and links. The
MCP package declares its author as `JLCEDA`. A community release must use a new
UUID, unique package name, original icon, community publisher identity, correct
repository links, and a clear non-official disclaimer.

## Quality and maintainability findings

- TypeScript strictness is disabled in the MCP server.
- There is no automated test suite or CI quality gate.
- The MCP server declares a lint command without a lint configuration.
- Bridge source currently has 222 lint errors.
- Backup implementations and multiple client/server transport variants coexist,
  making the runtime path difficult to establish.
- Generated API documents are duplicated in multiple locations.
- Temporary packages, compiled JavaScript, a ZIP, a large GIF, and extensive
  one-off debugging notes are committed under `build/temp_check` and `build`.
- The PR combines architecture replacement, new tools, generated data,
  documentation, packaging and behavior changes in one review unit.

## MCP protocol findings

The server implements a small handwritten subset of MCP and always returns
protocol version `2024-11-05`. It does not track initialization state or
negotiate the client-requested version. A maintained implementation should use
the official TypeScript SDK where practical, or include conformance tests for
initialization, notifications, cancellation, errors and shutdown.

References:

- https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle
- https://modelcontextprotocol.io/specification/draft/basic/transports

## Recommended community migration plan

1. Keep the upstream 1.5.x architecture available as a stable compatibility
   branch while the native server is rebuilt.
2. Start a clean `native-mcp-v2` branch with only `mcp-server`, `mcp-bridge`,
   essential documentation and reproducible packaging inputs.
3. Replace the WebSocket layer with an authenticated localhost-only broker that
   has explicit EDA page identities and active-client selection.
4. Use the official MCP SDK and add protocol/lifecycle tests.
5. Add unit tests for routing, request timeouts, disconnect takeover and request
   ID isolation; add an integration smoke test that starts the compiled server.
6. Make builds copy all resources and verify the packaged artifacts by executing
   them after build.
7. Reintroduce PR #6 tools one at a time after API and safety review.
8. Rebrand as **JLCEDA MCP Community**, retain Apache-2.0 attribution, and meet
   the marketplace requirements before publishing.

Marketplace reference:

- https://prodocs.easyeda.com/cn/api/guide/extensions-marketplace.html
