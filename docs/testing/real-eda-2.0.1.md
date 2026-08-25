# Real JLCEDA integration test: community bridge 2.0.1

Date: 2026-08-16

Environment:

- JLCEDA Professional desktop 3.2.181 on Windows
- JLCEDA MCP Community Bridge 2.0.1
- native MCP server 2.1.0
- project `2026`, schematic page `POWER DISTRIBUTION`

## Discovery and fix

The first real installation of 2.0.0 connected at the TCP/WebSocket layer but
never registered a ready peer. The packaged extension entry still imported the
obsolete client-mode runtime, so the native hello/ready/heartbeat
implementation was not running in the EDA process.

Version 2.0.1 switches the real extension entry to `bridge-runtime.ts`, restores
the settings iframe, implements stop/restart lifecycle exports, and adds a
build-time bundle assertion. The build now fails if required native protocol
markers are absent or the obsolete client-mode entry is present.

## Read-only verification

All checks below passed in the installed desktop application:

- `bridge_clients` reported one ready, active 2.0.1 peer.
- Bridge identity reported project `2026`, document type 1 and page
  `POWER DISTRIBUTION`.
- `eda_context` returned the same project, document and page identities from
  the official context APIs and listed all seven schematic pages.
- `schematic_review` returned a 3,717-character whole-project netlist.
- `api_search` found the exact official signature for
  `eda.dmt_Schematic.getCurrentSchematicPageInfo`.
- `api_invoke` called that read-only API with no arguments and returned the same
  current page identity.
- GitHub CI passed on Ubuntu, Windows and EEXT packaging for the 2.0.1 fix.

The existing project returned `drcCheckPassed: false`. This was recorded as
project state; no warning was ignored and no automatic modification was made.

## Not covered

- No mutating EDA API was invoked.
- Multi-page selection is covered by automated bridge tests, but only one live
  EDA page was connected during this desktop test.
- Shared-token authentication was not enabled for this compatibility test.
