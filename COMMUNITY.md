# JLCEDA MCP Community

JLCEDA MCP Community is a community-maintained fork of
[`sengbin/JLCEDA-MCP`](https://github.com/sengbin/JLCEDA-MCP).

- Repository: https://github.com/hs150521/JLCEDA-MCP-Community
- Contact: `hs150521@proton.me`
- License: Apache License 2.0
- Status: independent community project; not affiliated with or endorsed by
  JLCEDA or the upstream maintainer

## Attribution

The original work and contributor history are retained under Apache-2.0. New
community changes are recorded through Git history and release notes. Product
and company names are used only to identify compatibility.

## Branch policy

- `main`: stable upstream-compatible community line.
- `audit/native-mcp-v2`: preserved PR #6 prototype plus the community audit.
- `native-mcp-v2`: native MCP implementation rebuilt behind automated tests
  and security controls.

The PR #6 audit is in [`docs/audits/PR-6-native-mcp.md`](./docs/audits/PR-6-native-mcp.md).

## Release requirements

Before a community EDA extension is published, it must have:

1. a new extension UUID and unique package name;
2. original, non-infringing artwork;
3. explicit community publisher and repository metadata;
4. reproducible MCP server and EDA extension builds;
5. automated protocol, routing and lifecycle tests;
6. a successful packaged-artifact smoke test;
7. an EDA integration test against supported editor versions; and
8. retained Apache-2.0 license and applicable attribution notices.

Security-sensitive reports should be sent to `hs150521@proton.me` before
public disclosure.
